import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AivenClient } from '../../src/client.js';
import { parseScopes } from '../../src/config.js';
import { buildProxyTools } from '../../src/marmot/proxy-tools.js';
import { createMcpServerFactory, registerAdditionalTools } from '../../src/server-factory.js';
import { createApplicationTools } from '../../src/tools/applications/handlers.js';
import { reasoningField } from '../../src/tools/shared-schemas.js';
import {
  READ_ONLY_ANNOTATIONS,
  ServiceCategory,
  type McpRequestOptions,
  type ToolDefinition,
} from '../../src/types.js';

function mockClient(): AivenClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  } as unknown as AivenClient;
}

const DEFAULT_OPTIONS: McpRequestOptions = {
  readOnly: false,
  categories: undefined,
  allowSecrets: false,
  writeAllowlist: undefined,
};

const toolWithOutput: ToolDefinition = {
  name: 'test_tool_with_output',
  category: ServiceCategory.Core,
  definition: {
    title: 'Test tool',
    description: 'Tool with a union input and an output schema',
    inputSchema: z.object({
      mode: z.union([z.literal('a'), z.literal('b')]),
      limit: z.number().int().optional(),
      reasoning: reasoningField,
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    outputSchema: z.object({ ok: z.boolean() }),
  },
  handler: () =>
    Promise.resolve({
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { ok: true },
    }),
};

function makeProxyTools(
  callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] })
): {
  tools: ToolDefinition[];
  callTool: ReturnType<typeof vi.fn>;
  authorize: ReturnType<typeof vi.fn>;
} {
  const authorize = vi.fn().mockResolvedValue({ ok: true });
  const tools = buildProxyTools(
    [
      {
        name: 'discover_data',
        description: 'Find assets',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', format: 'uri' } },
          additionalProperties: false,
        },
      },
      {
        name: 'manage_tags',
        description: 'Tag assets',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    ],
    new Set(),
    { upstream: { callTool }, authorize, apiKey: 'key' }
  );
  return { tools, callTool, authorize };
}

async function connect(server: McpServer): Promise<Client> {
  const client = new Client({ name: 'server-factory-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function listTools(server: McpServer): Promise<Tool[]> {
  const client = await connect(server);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

function stockServer(tools: readonly ToolDefinition[]): McpServer {
  const server = new McpServer({ name: 'stock', version: '1.0.0' });
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
      (params) => tool.handler(params)
    );
  }
  return server;
}

describe('createMcpServerFactory tools/list', () => {
  it('lists Aiven tools exactly as stock McpServer does', async () => {
    const tools = [toolWithOutput, ...createApplicationTools(mockClient())];
    const factory = createMcpServerFactory({
      transport: 'stdio',
      client: mockClient(),
      getTools: () => tools,
    });

    const ours = await listTools(factory(DEFAULT_OPTIONS));
    const stock = await listTools(stockServer(tools));

    expect(ours).toEqual(stock);
  });

  it('advertises the raw JSON Schema of proxied tools', async () => {
    const { tools } = makeProxyTools();
    const factory = createMcpServerFactory({
      transport: 'stdio',
      client: mockClient(),
      getTools: () => tools,
    });

    const listed = await listTools(factory(DEFAULT_OPTIONS));
    const discover = listed.find((tool) => tool.name === 'aiven_context_discover_data');

    expect(discover?.inputSchema).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', format: 'uri' },
        reasoning: expect.objectContaining({ type: 'string' }),
      },
      additionalProperties: false,
      required: ['reasoning'],
    });
    expect(discover?.outputSchema).toBeUndefined();
  });
});

describe('createMcpServerFactory tools/call', () => {
  it('routes proxied calls through registerTools and forwards extra arguments', async () => {
    const { tools, callTool, authorize } = makeProxyTools();
    const factory = createMcpServerFactory({
      transport: 'stdio',
      client: mockClient(),
      getTools: () => tools,
    });
    const server = factory(DEFAULT_OPTIONS);
    const client = await connect(server);

    try {
      const result = await client.callTool({
        name: 'aiven_context_discover_data',
        arguments: { reasoning: 'find orders', query: 'orders' },
      });
      expect(authorize).toHaveBeenCalledWith(undefined);
      expect(callTool).toHaveBeenCalledWith('discover_data', { query: 'orders' });
      expect(JSON.stringify(result['content'])).toContain('untrusted-aiven-response');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('tool selection', () => {
  async function namesFor(options: McpRequestOptions): Promise<string[]> {
    const { tools } = makeProxyTools();
    const factory = createMcpServerFactory({
      transport: 'http',
      client: mockClient(),
      getTools: () => tools,
    });
    return (await listTools(factory(options))).map((tool) => tool.name);
  }

  it('keeps known read tools and hides unknown write tools in read-only mode', async () => {
    const names = await namesFor({ ...DEFAULT_OPTIONS, readOnly: true });
    expect(names).toContain('aiven_context_discover_data');
    expect(names).not.toContain('aiven_context_manage_tags');
  });

  it('re-enables a proxied write tool through write_allowlist', async () => {
    const names = await namesFor({
      ...DEFAULT_OPTIONS,
      readOnly: true,
      writeAllowlist: new Set(['aiven_context_manage_tags']),
    });
    expect(names).toContain('aiven_context_manage_tags');
  });

  it('excludes context tools from other scopes and includes them in the context scope', async () => {
    const pgScope = parseScopes('pg');
    const contextScope = parseScopes('context');
    if ('error' in pgScope || 'error' in contextScope) throw new Error('unexpected scope error');

    expect(await namesFor({ ...DEFAULT_OPTIONS, categories: pgScope.categories })).toEqual([]);
    expect(await namesFor({ ...DEFAULT_OPTIONS, categories: contextScope.categories })).toEqual([
      'aiven_context_discover_data',
      'aiven_context_manage_tags',
    ]);
  });
});

describe('registerAdditionalTools', () => {
  it('registers late tools, honors read-only filtering, and notifies the client', async () => {
    const options: McpRequestOptions = { ...DEFAULT_OPTIONS, readOnly: true };
    const factory = createMcpServerFactory({
      transport: 'stdio',
      client: mockClient(),
      getTools: () => [toolWithOutput],
    });
    const server = factory(options);
    const notified = vi.fn();
    const client = await connect(server);
    client.setNotificationHandler(ToolListChangedNotificationSchema, notified);

    try {
      registerAdditionalTools(server, makeProxyTools().tools, options);
      await vi.waitFor(() => {
        expect(notified).toHaveBeenCalled();
      });

      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(['test_tool_with_output', 'aiven_context_discover_data']);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
