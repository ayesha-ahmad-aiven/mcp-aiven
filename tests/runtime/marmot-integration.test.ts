import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMarmotMcpUrl, type MarmotConfig } from '../../src/config.js';
import { MarmotIntegration, type MarmotIntegrationOptions } from '../../src/marmot/integration.js';
import { connectMarmotUpstream, type MarmotUpstreamClient } from '../../src/marmot/upstream.js';
import type { ToolDefinition } from '../../src/types.js';
import {
  FAKE_MARMOT_API_KEY,
  marmotTool,
  startFakeMarmot,
  type FakeMarmot,
} from './helpers/fake-marmot.js';

let fake: FakeMarmot | undefined;
let integration: MarmotIntegration | undefined;

afterEach(async () => {
  await integration?.close();
  await fake?.close();
  integration = undefined;
  fake = undefined;
});

function configFor(server: FakeMarmot): MarmotConfig {
  return { mcpUrl: resolveMarmotMcpUrl(server.url), apiKey: FAKE_MARMOT_API_KEY };
}

function makeIntegration(overrides: Partial<MarmotIntegrationOptions>): MarmotIntegration {
  integration = new MarmotIntegration({
    config: undefined,
    existingToolNames: new Set(),
    authorize: vi.fn().mockResolvedValue({ ok: true }),
    retryDelaysMs: [10, 10],
    rediscoveryIntervalMs: 20,
    log: vi.fn(),
    ...overrides,
  });
  return integration;
}

describe('MarmotIntegration', () => {
  it('is disabled without configuration', async () => {
    const marmot = makeIntegration({});
    await marmot.start();
    expect(marmot.status).toBe('disabled');
    expect(marmot.tools).toEqual([]);
  });

  it('discovers tools and logs the origin and names without the key', async () => {
    fake = await startFakeMarmot({
      toolPages: [[marmotTool('discover_data'), marmotTool('manage_tags')]],
    });
    const log = vi.fn();
    const marmot = makeIntegration({ config: configFor(fake), log });

    await marmot.start();

    expect(marmot.status).toBe('ok');
    expect(marmot.tools.map((tool) => tool.name)).toEqual([
      'aiven_context_discover_data',
      'aiven_context_manage_tags',
    ]);
    const logged = log.mock.calls.map(([message]) => String(message)).join('\n');
    expect(logged).toContain(fake.url);
    expect(logged).toContain('aiven_context_discover_data');
    expect(logged).not.toContain(FAKE_MARMOT_API_KEY);
  });

  it('proxies a call end to end through the discovered tool', async () => {
    fake = await startFakeMarmot();
    const marmot = makeIntegration({ config: configFor(fake) });
    await marmot.start();

    const [tool] = marmot.tools;
    if (!tool) throw new Error('no tools discovered');
    const result = await tool.handler({ reasoning: 'r', query: 'orders' }, { token: 't' });

    expect(fake.calls).toEqual([{ name: 'discover_data', args: { query: 'orders' } }]);
    const first = result.content[0];
    expect(first?.type === 'text' ? first.text : '').toContain('"query":"orders"');
  });

  it('notifies listeners when the initial discovery succeeds', async () => {
    fake = await startFakeMarmot();
    const listener = vi.fn<(tools: readonly ToolDefinition[]) => void>();
    const marmot = makeIntegration({ config: configFor(fake) });
    marmot.onToolsDiscovered(listener);

    await marmot.start();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].map((tool) => tool.name)).toEqual([
      'aiven_context_discover_data',
    ]);
  });

  it('stays unavailable without retrying when startup discovery finds a name collision', async () => {
    fake = await startFakeMarmot();
    const log = vi.fn();
    const listener = vi.fn();
    const connect = vi.fn(connectMarmotUpstream);
    const marmot = makeIntegration({
      config: configFor(fake),
      existingToolNames: new Set(['aiven_context_discover_data']),
      connect,
      log,
    });
    marmot.onToolsDiscovered(listener);

    await expect(marmot.start()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(marmot.status).toBe('unavailable');
    expect(marmot.tools).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    const logged = log.mock.calls.map(([message]) => String(message)).join('\n');
    expect(logged).toContain('aiven_context_discover_data');
    expect(logged).not.toContain(FAKE_MARMOT_API_KEY);
  });

  it('stops background rediscovery when it finds a name collision', async () => {
    fake = await startFakeMarmot();
    fake.setAvailable(false);
    const log = vi.fn();
    const connect = vi.fn(connectMarmotUpstream);
    const marmot = makeIntegration({
      config: configFor(fake),
      existingToolNames: new Set(['aiven_context_discover_data']),
      connect,
      log,
    });

    await marmot.start();
    const startupAttempts = connect.mock.calls.length;
    fake.setAvailable(true);
    await vi.waitFor(() => {
      expect(connect.mock.calls.length).toBeGreaterThan(startupAttempts);
    });
    const afterCollision = connect.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(connect).toHaveBeenCalledTimes(afterCollision);
    expect(marmot.status).toBe('unavailable');
    expect(marmot.tools).toEqual([]);
    const logged = log.mock.calls.map(([message]) => String(message)).join('\n');
    expect(logged).toContain('aiven_context_discover_data');
    expect(logged).not.toContain(FAKE_MARMOT_API_KEY);
  });

  it('retries, starts degraded, then discovers tools in the background', async () => {
    fake = await startFakeMarmot();
    fake.setAvailable(false);
    const log = vi.fn();
    const listener = vi.fn<(tools: readonly ToolDefinition[]) => void>();
    const marmot = makeIntegration({ config: configFor(fake), log });
    marmot.onToolsDiscovered(listener);

    await marmot.start();

    expect(marmot.status).toBe('unavailable');
    expect(marmot.tools).toEqual([]);
    const attempts = log.mock.calls.filter(([message]) =>
      String(message).includes('connection attempt')
    );
    expect(attempts).toHaveLength(3);

    fake.setAvailable(true);
    await vi.waitFor(
      () => {
        expect(marmot.status).toBe('ok');
      },
      { timeout: 2_000 }
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].map((tool) => tool.name)).toEqual([
      'aiven_context_discover_data',
    ]);
  });

  it('stops background rediscovery on close', async () => {
    fake = await startFakeMarmot();
    fake.setAvailable(false);
    const marmot = makeIntegration({ config: configFor(fake) });
    await marmot.start();

    await marmot.close();
    fake.setAvailable(true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(marmot.status).toBe('unavailable');
  });

  it('stops startup retries when closed mid-start', async () => {
    fake = await startFakeMarmot();
    const connect = vi.fn().mockRejectedValue(new Error('down'));
    const marmot = makeIntegration({ config: configFor(fake), connect, retryDelaysMs: [50, 50] });

    const starting = marmot.start();
    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledTimes(1);
    });
    await marmot.close();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(marmot.status).toBe('unavailable');
  });

  it('discards an upstream that finishes connecting after close', async () => {
    fake = await startFakeMarmot();
    let releaseList: () => void = () => undefined;
    const listAllTools = vi.fn(
      () =>
        new Promise<Tool[]>((resolve) => {
          releaseList = (): void => {
            resolve([marmotTool('discover_data')]);
          };
        })
    );
    const upstream: MarmotUpstreamClient = {
      listAllTools,
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const listener = vi.fn();
    const marmot = makeIntegration({
      config: configFor(fake),
      connect: () => Promise.resolve(upstream),
    });
    marmot.onToolsDiscovered(listener);

    const starting = marmot.start();
    await vi.waitFor(() => {
      expect(listAllTools).toHaveBeenCalledTimes(1);
    });
    await marmot.close();
    releaseList();
    await starting;

    expect(upstream.close).toHaveBeenCalledTimes(1);
    expect(marmot.status).toBe('unavailable');
    expect(marmot.tools).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });
});
