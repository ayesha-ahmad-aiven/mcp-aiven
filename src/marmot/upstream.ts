import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { VERSION, type MarmotConfig } from '../config.js';

export const MARMOT_CALL_TIMEOUT_MS = 30_000;
export const MAX_TOOL_LIST_PAGES = 100;

export interface UpstreamToolAnnotations {
  readonly title?: string | undefined;
  readonly readOnlyHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}

export interface UpstreamTool {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: UpstreamToolAnnotations | undefined;
}

export interface UpstreamContent {
  readonly type: string;
  readonly text?: string | undefined;
}

export interface UpstreamCallResult {
  readonly content: readonly UpstreamContent[];
  readonly isError?: boolean | undefined;
}

export interface MarmotUpstreamClient {
  listAllTools(): Promise<UpstreamTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<UpstreamCallResult>;
  close(): Promise<void>;
}

export async function connectMarmotUpstream(
  config: MarmotConfig,
  callTimeoutMs: number = MARMOT_CALL_TIMEOUT_MS
): Promise<MarmotUpstreamClient> {
  const transport = new StreamableHTTPClientTransport(config.mcpUrl, {
    requestInit: { headers: { 'X-API-Key': config.apiKey } },
  });
  const client = new Client({ name: 'mcp-aiven', version: VERSION });
  await client.connect(transport as unknown as Transport, { timeout: callTimeoutMs });

  return {
    async listAllTools(): Promise<UpstreamTool[]> {
      const tools: UpstreamTool[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (pages >= MAX_TOOL_LIST_PAGES) {
          throw new Error(`Marmot tool list exceeded ${MAX_TOOL_LIST_PAGES} pages`);
        }
        if (cursor !== undefined) {
          if (seenCursors.has(cursor)) throw new Error('Marmot tool list repeated a page cursor');
          seenCursors.add(cursor);
        }
        pages++;
        const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
          timeout: callTimeoutMs,
        });
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<UpstreamCallResult> {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: callTimeoutMs,
      });
      const content = Array.isArray(result['content'])
        ? (result['content'] as UpstreamContent[])
        : [];
      return { content, isError: result['isError'] === true };
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
