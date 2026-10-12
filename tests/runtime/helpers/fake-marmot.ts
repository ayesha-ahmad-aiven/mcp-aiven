import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

export const FAKE_MARMOT_API_KEY = 'fake-marmot-key';

export interface FakeMarmotCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeMarmotOptions {
  apiKey?: string;
  toolPages?: Tool[][];
  onCall?: (call: FakeMarmotCall) => CallToolResult | Promise<CallToolResult>;
}

export interface FakeMarmot {
  url: string;
  calls: FakeMarmotCall[];
  seenApiKeys: string[];
  setAvailable(available: boolean): void;
  close(): Promise<void>;
}

export function marmotTool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    ...overrides,
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? undefined : JSON.parse(raw);
}

export async function startFakeMarmot(options: FakeMarmotOptions = {}): Promise<FakeMarmot> {
  const apiKey = options.apiKey ?? FAKE_MARMOT_API_KEY;
  const pages = options.toolPages ?? [[marmotTool('discover_data')]];
  const calls: FakeMarmotCall[] = [];
  const seenApiKeys: string[] = [];
  let available = true;

  const httpServer = createServer((req, res) => {
    void (async (): Promise<void> => {
      const key = req.headers['x-api-key'];
      if (typeof key === 'string') seenApiKeys.push(key);
      if (!available) {
        res.writeHead(503).end();
        return;
      }
      if (req.url !== '/api/v1/mcp') {
        res.writeHead(404).end();
        return;
      }
      // eslint-disable-next-line security/detect-possible-timing-attacks -- test-only fake
      if (key !== apiKey) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-deprecated -- raw handlers needed for cursor paging and JSON Schema tools
      const mcpServer = new Server(
        { name: 'fake-marmot', version: '1.0.0' },
        { capabilities: { tools: {} } }
      );
      mcpServer.setRequestHandler(ListToolsRequestSchema, (request) => {
        const cursor = request.params?.cursor;
        const index = cursor === undefined ? 0 : Number(cursor);
        const next = index + 1 < pages.length ? { nextCursor: String(index + 1) } : {};
        return { tools: pages[index] ?? [], ...next };
      });
      mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const call = { name: request.params.name, args: request.params.arguments ?? {} };
        calls.push(call);
        if (options.onCall) return options.onCall(call);
        return { content: [{ type: 'text', text: JSON.stringify(call) }] };
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, await readJson(req));
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    seenApiKeys,
    setAvailable: (value): void => {
      available = value;
    },
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
