import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AivenClient } from './client.js';
import { VERSION } from './config.js';
import { sanitizeMcpClient } from './mcp-client-header.js';
import { createObservabilityContext } from './observability.js';
import { connectionInfoInstructions, readOnlyInstructions } from './prompts.js';
import { scan } from './security/model-armor.js';
import { createConnectionInfoTool } from './tools/connection-info.js';
import { toolError, type McpRequestOptions, type ToolDefinition } from './types.js';
import { unwrapUntrustedResponse } from './untrusted.js';

const EMPTY_OBJECT_JSON_SCHEMA = { type: 'object' as const, properties: {} };

/** Streamable HTTP: inbound `/mcp` `User-Agent` (SDK `requestInfo.headers`). */
function mcpClientFromRequestInfo(requestInfo: unknown): string | undefined {
  if (!requestInfo || typeof requestInfo !== 'object' || !('headers' in requestInfo)) {
    return undefined;
  }
  const headersRaw = (requestInfo as { headers: unknown }).headers;
  if (!headersRaw || typeof headersRaw !== 'object') return undefined;
  const h = headersRaw as Record<string, string | undefined>;

  const v = h['user-agent'] ?? h['User-Agent'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function selectTools(
  tools: readonly ToolDefinition[],
  options: Pick<McpRequestOptions, 'readOnly' | 'categories' | 'writeAllowlist'>
): ToolDefinition[] {
  let selected = [...tools];
  if (options.readOnly) {
    const allowlist = options.writeAllowlist;
    selected = selected.filter(
      (t) => t.definition.annotations.readOnlyHint || allowlist?.has(t.name)
    );
  }
  if (options.categories) {
    const allowed = options.categories;
    selected = selected.filter((t) => allowed.has(t.category));
  }
  return selected;
}

export function registerTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  requestOptions: McpRequestOptions
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.definition.title,
        description: tool.definition.description,
        inputSchema: tool.definition.inputSchema,
        annotations: tool.definition.annotations,
        ...(tool.definition.outputSchema ? { outputSchema: tool.definition.outputSchema } : {}),
      },
      async (params, extra) => {
        const paramsObj = params as Record<string, unknown>;
        const reasoning = paramsObj['reasoning'] as string | undefined;
        const obsContext = createObservabilityContext(reasoning);

        const context = {
          token: extra.authInfo?.token,
          mcpClient: sanitizeMcpClient(
            mcpClientFromRequestInfo(extra.requestInfo) ?? server.server.getClientVersion()?.name
          ),
          clientIp: requestOptions.clientIp,
          requestId: obsContext.requestId,
          toolReasoning: obsContext.toolReasoning,
        };

        // Scan tool input for prompt injection / jailbreak before acting on it.
        // Skip `reasoning` (model-generated metadata) and send the raw JSON params.
        const scanParams = Object.fromEntries(
          Object.entries(paramsObj).filter(([key]) => key !== 'reasoning')
        );
        const inputText = JSON.stringify(scanParams);
        const inputBlocked = await scan(inputText);
        if (inputBlocked) return toolError(inputBlocked);

        const result = await tool.handler(params, context);

        // Scan tool output so poisoned Aiven data can't inject the user's LLM.
        // Unwrap our own untrusted-data boundary first — its warning text would
        // otherwise trip the prompt-injection filter.
        const outputText = result.content
          .map((c) => (c.type === 'text' ? unwrapUntrustedResponse(c.text) : ''))
          .join('\n');
        const outputBlocked = await scan(outputText, 'output');
        if (outputBlocked) return toolError(outputBlocked);

        return result;
      }
    );
  }
}

export function toolListEntry(tool: ToolDefinition): Tool {
  const inputObject = normalizeObjectSchema(tool.definition.inputSchema);
  const generatedInput = inputObject
    ? toJsonSchemaCompat(inputObject, { strictUnions: true, pipeStrategy: 'input' })
    : EMPTY_OBJECT_JSON_SCHEMA;
  const entry: Tool = {
    name: tool.name,
    title: tool.definition.title,
    description: tool.definition.description,
    inputSchema: (tool.advertisedInputSchema ?? generatedInput) as Tool['inputSchema'],
    annotations: tool.definition.annotations,
    execution: { taskSupport: 'forbidden' },
  };
  if (tool.definition.outputSchema) {
    const outputObject = normalizeObjectSchema(tool.definition.outputSchema);
    if (outputObject) {
      entry.outputSchema = toJsonSchemaCompat(outputObject, {
        strictUnions: true,
        pipeStrategy: 'output',
      }) as Tool['outputSchema'];
    }
  }
  return entry;
}

const listedTools = new WeakMap<McpServer, ToolDefinition[]>();

// Must run after the first registerTool call: McpServer refuses to install its tool handlers once tools/list is taken.
function installToolsListHandler(server: McpServer, tools: ToolDefinition[]): void {
  if (tools.length === 0) {
    // McpServer declares the tools capability and installs tools/call only on its first registerTool.
    server.registerTool('mcp_aiven_placeholder', {}, () => ({ content: [] })).remove();
  }
  listedTools.set(server, tools);
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: (listedTools.get(server) ?? []).map(toolListEntry),
  }));
}

export function registerAdditionalTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  options: McpRequestOptions
): void {
  const listed = new Set((listedTools.get(server) ?? []).map((tool) => tool.name));
  const selected = selectTools(tools, options).filter((tool) => !listed.has(tool.name));
  if (selected.length === 0) return;
  registerTools(server, selected, options);
  listedTools.get(server)?.push(...selected);
  server.sendToolListChanged();
}

export interface ServerFactoryDeps {
  readonly transport: 'stdio' | 'http';
  readonly client: AivenClient;
  readonly getTools: () => readonly ToolDefinition[];
}

export function createMcpServerFactory(
  deps: ServerFactoryDeps
): (options: McpRequestOptions) => McpServer {
  return (options) => {
    let tools = selectTools(deps.getTools(), options);
    if (options.allowSecrets) {
      tools = [...tools, ...createConnectionInfoTool(deps.client, options.readOnly)];
    }

    const instructions: string[] = [];
    if (options.readOnly)
      instructions.push(readOnlyInstructions(deps.transport, options.writeAllowlist));
    instructions.push(
      connectionInfoInstructions(options.allowSecrets, options.readOnly, deps.transport)
    );

    const serverOptions =
      instructions.length > 0
        ? ([{ instructions: instructions.join(' ') }] as const)
        : ([] as const);

    const server = new McpServer({ name: 'mcp-aiven', version: VERSION }, ...serverOptions);
    registerTools(server, tools, options);
    installToolsListHandler(server, tools);
    return server;
  };
}
