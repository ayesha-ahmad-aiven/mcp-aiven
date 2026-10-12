#!/usr/bin/env node
// Must be first import so instrumentation can hook into Express and other modules
import './instrumentation/index.js';
import { loadConfig } from './config.js';
import { AivenClient } from './client.js';
import { loadApiTools } from './tools/registry.js';
import { createKafkaCustomTools } from './tools/kafka/index.js';
import { createPgCustomTools } from './tools/pg/index.js';
import { createApplicationTools } from './tools/applications/index.js';
import { createDocsTools } from './tools/docs/index.js';
import { createServiceSearchTool } from './tools/service-search.js';
import { createStdioTransport, startHttpServer } from './transport.js';
import type { ToolDefinition, McpRequestOptions } from './types.js';
import {
  VERSION,
  API_ORIGIN,
  loadHttpMcpRateLimit,
  isExtraProtectionEnabled,
  loadEdgeAuthSecret,
} from './config.js';
import { instrumentServer, flushAndExit } from './instrumentation/index.js';
import { summarizeCatalog } from './tool-catalog.js';
import { createMcpServerFactory } from './server-factory.js';

function logEnvReport(): void {
  const names = Object.keys(process.env).sort();
  console.error(`mcp-aiven: ${names.length} env vars visible (values hidden):`);
  for (const name of names) {
    const hasValue = (process.env[name] ?? '').trim().length > 0;
    console.error(`mcp-aiven:   ${name}=${hasValue ? '<value_exists>' : '<value_empty>'}`);
  }
}

/**
 * Log what this process will actually serve. The catalog is built once at startup and
 * depends on env, so instances can serve different tool lists with no code difference;
 * the fingerprint turns "which instance answered?" into a single log search.
 */
function logToolCatalog(allTools: readonly ToolDefinition[]): void {
  const all = summarizeCatalog(allTools);
  const readOnly = summarizeCatalog(allTools.filter((t) => t.definition.annotations.readOnlyHint));
  console.error(
    `mcp-aiven: ${all.count} tools registered fp=${all.fingerprint} ` +
      `(read-only: ${readOnly.count} fp=${readOnly.fingerprint}) v=${VERSION}`
  );
  console.error(`mcp-aiven: tools=${all.names.join(',')}`);
}

function loadAllTools(client: AivenClient): ToolDefinition[] {
  return [
    ...loadApiTools(client),
    ...createKafkaCustomTools(client),
    ...createPgCustomTools(client),
    ...createApplicationTools(client),
    ...createDocsTools(),
    ...createServiceSearchTool(client),
  ];
}

async function main(): Promise<void> {
  const transport = process.env['MCP_TRANSPORT'] === 'http' ? 'http' : 'stdio';
  logEnvReport();
  const config = loadConfig(transport);
  const client = new AivenClient(config);

  const allTools: readonly ToolDefinition[] = loadAllTools(client);
  logToolCatalog(allTools);

  const createMcpServer = createMcpServerFactory({ transport, client, getTools: () => allTools });

  if (transport === 'http') {
    startHttpServer((options) => instrumentServer(createMcpServer(options)), {
      port: parseInt(process.env['PORT'] ?? '3000', 10),
      apiOrigin: API_ORIGIN,
      scopes: ['projects', 'services', 'accounts:read'],
      rateLimit: loadHttpMcpRateLimit(),
      readOnly: config.readOnly,
      extraProtection: isExtraProtectionEnabled(),
      edgeAuthSecret: loadEdgeAuthSecret(),
    });
  } else {
    const options: McpRequestOptions = {
      readOnly: config.readOnly,
      categories: config.categories,
      allowSecrets: config.allowSecrets,
      writeAllowlist: config.writeAllowlist,
    };
    const server = instrumentServer(createMcpServer(options));
    await server.connect(createStdioTransport());
    console.error('mcp-aiven: Server connected and ready');
  }
}

main().catch(async (error: unknown) => {
  console.error('mcp-aiven: Fatal error:', error instanceof Error ? error.message : error);
  await flushAndExit(error);
});
