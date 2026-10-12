#!/usr/bin/env node
// Must be first import so instrumentation can hook into Express and other modules
import './instrumentation/index.js';
import { constants as osConstants } from 'node:os';
import { loadConfig, loadMarmotConfig } from './config.js';
import { AivenClient } from './client.js';
import { errorMessage } from './errors.js';
import { loadApiTools } from './tools/registry.js';
import { createKafkaCustomTools } from './tools/kafka/index.js';
import { createPgCustomTools } from './tools/pg/index.js';
import { createApplicationTools } from './tools/applications/index.js';
import { createDocsTools } from './tools/docs/index.js';
import { createServiceSearchTool } from './tools/service-search.js';
import { createConnectionInfoTool } from './tools/connection-info.js';
import { createStdioTransport, startHttpServer } from './transport.js';
import type { ToolDefinition, McpRequestOptions } from './types.js';
import {
  VERSION,
  API_ORIGIN,
  loadHttpMcpRateLimit,
  isExtraProtectionEnabled,
  loadEdgeAuthSecret,
} from './config.js';
import { instrumentServer, flushAndExit, flushAndExitCleanly } from './instrumentation/index.js';
import { summarizeCatalog } from './tool-catalog.js';
import { createMcpServerFactory, registerAdditionalTools } from './server-factory.js';
import { createCallerAuthorizer } from './marmot/authorize.js';
import { MarmotIntegration } from './marmot/integration.js';
import { redactSecret } from './marmot/proxy-tools.js';

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

const MARMOT_CLOSE_TIMEOUT_MS = 5_000;

function closeOnShutdown(marmot: MarmotIntegration): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, MARMOT_CLOSE_TIMEOUT_MS);
      });
      const closed = marmot.close().catch(() => undefined);
      void Promise.race([closed, timeout]).then(() =>
        flushAndExitCleanly(128 + osConstants.signals[signal])
      );
    });
  }
}

function startMarmotInBackground(marmot: MarmotIntegration, apiKey: string): void {
  marmot.start().catch((error: unknown) => {
    console.error(`mcp-aiven: Marmot startup failed: ${redactSecret(errorMessage(error), apiKey)}`);
  });
}

// A throwing listener would stop MarmotIntegration's background rediscovery.
function onMarmotToolsDiscovered(
  marmot: MarmotIntegration,
  listener: (tools: readonly ToolDefinition[]) => void
): void {
  marmot.onToolsDiscovered((tools) => {
    try {
      listener(tools);
    } catch (error) {
      console.error(
        `mcp-aiven: failed to add Marmot data catalog tools to the server: ${errorMessage(error)}`
      );
    }
  });
}

async function main(): Promise<void> {
  const transport = process.env['MCP_TRANSPORT'] === 'http' ? 'http' : 'stdio';
  logEnvReport();
  const config = loadConfig(transport);
  const marmotConfig = loadMarmotConfig();
  const client = new AivenClient(config);

  const aivenTools: readonly ToolDefinition[] = loadAllTools(client);
  const existingToolNames = new Set(
    [...aivenTools, ...createConnectionInfoTool(client, false)].map((tool) => tool.name)
  );
  const marmot = new MarmotIntegration({
    config: marmotConfig,
    existingToolNames,
    authorize: createCallerAuthorizer(client),
  });
  if (marmotConfig) closeOnShutdown(marmot);

  const getTools = (): readonly ToolDefinition[] => [...aivenTools, ...marmot.tools];
  logToolCatalog(getTools());
  onMarmotToolsDiscovered(marmot, () => {
    logToolCatalog(getTools());
  });

  const createMcpServer = createMcpServerFactory({ transport, client, getTools });

  if (transport === 'http') {
    startHttpServer((options) => instrumentServer(createMcpServer(options)), {
      port: parseInt(process.env['PORT'] ?? '3000', 10),
      apiOrigin: API_ORIGIN,
      scopes: ['projects', 'services', 'accounts:read'],
      rateLimit: loadHttpMcpRateLimit(),
      readOnly: config.readOnly,
      extraProtection: isExtraProtectionEnabled(),
      edgeAuthSecret: loadEdgeAuthSecret(),
      healthDetails: marmotConfig
        ? (): Record<string, string> => ({ marmot: marmot.status })
        : undefined,
    });
  } else {
    const options: McpRequestOptions = {
      readOnly: config.readOnly,
      categories: config.categories,
      allowSecrets: config.allowSecrets,
      writeAllowlist: config.writeAllowlist,
    };
    const server = instrumentServer(createMcpServer(options));
    onMarmotToolsDiscovered(marmot, (tools) => {
      registerAdditionalTools(server, tools, options);
    });
    await server.connect(createStdioTransport());
    console.error('mcp-aiven: Server connected and ready');
  }

  if (marmotConfig) startMarmotInBackground(marmot, marmotConfig.apiKey);
}

main().catch(async (error: unknown) => {
  console.error('mcp-aiven: Fatal error:', error instanceof Error ? error.message : error);
  await flushAndExit(error);
});
