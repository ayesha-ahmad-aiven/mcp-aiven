import { afterEach, describe, expect, it } from 'vitest';
import { resolveMarmotMcpUrl, type MarmotConfig } from '../../src/config.js';
import { connectMarmotUpstream, MAX_TOOL_LIST_PAGES } from '../../src/marmot/upstream.js';
import {
  FAKE_MARMOT_API_KEY,
  marmotTool,
  startFakeMarmot,
  type FakeMarmot,
} from './helpers/fake-marmot.js';

let fake: FakeMarmot | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

function configFor(server: FakeMarmot, apiKey: string = FAKE_MARMOT_API_KEY): MarmotConfig {
  return { mcpUrl: resolveMarmotMcpUrl(server.url), apiKey };
}

describe('connectMarmotUpstream', () => {
  it('sends the API key and lists tools across pages', async () => {
    fake = await startFakeMarmot({
      toolPages: [[marmotTool('discover_data')], [marmotTool('trace_lineage')]],
    });
    const upstream = await connectMarmotUpstream(configFor(fake));
    try {
      const tools = await upstream.listAllTools();
      expect(tools.map((tool) => tool.name)).toEqual(['discover_data', 'trace_lineage']);
      expect(tools[0]?.inputSchema).toEqual({
        type: 'object',
        properties: { query: { type: 'string' } },
      });
      expect(fake.seenApiKeys.length).toBeGreaterThan(0);
      expect(fake.seenApiKeys.every((key) => key === FAKE_MARMOT_API_KEY)).toBe(true);
    } finally {
      await upstream.close();
    }
  });

  it('passes arguments through and returns content and the error marker', async () => {
    fake = await startFakeMarmot({
      onCall: () => ({ content: [{ type: 'text', text: 'not found' }], isError: true }),
    });
    const upstream = await connectMarmotUpstream(configFor(fake));
    try {
      const result = await upstream.callTool('discover_data', { query: 'orders' });
      expect(fake.calls).toEqual([{ name: 'discover_data', args: { query: 'orders' } }]);
      expect(result).toEqual({ content: [{ type: 'text', text: 'not found' }], isError: true });
    } finally {
      await upstream.close();
    }
  });

  it('rejects a repeated tool list cursor', async () => {
    fake = await startFakeMarmot({ nextCursor: () => 'same' });
    const upstream = await connectMarmotUpstream(configFor(fake));
    try {
      const error = await upstream.listAllTools().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/repeated/i);
      expect((error as Error).message).not.toContain(FAKE_MARMOT_API_KEY);
    } finally {
      await upstream.close();
    }
  });

  it('rejects tool lists longer than the page cap', async () => {
    fake = await startFakeMarmot({
      nextCursor: (cursor) => String(cursor === undefined ? 1 : Number(cursor) + 1),
    });
    const upstream = await connectMarmotUpstream(configFor(fake));
    try {
      const error = await upstream.listAllTools().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(String(MAX_TOOL_LIST_PAGES));
      expect((error as Error).message).not.toContain(FAKE_MARMOT_API_KEY);
    } finally {
      await upstream.close();
    }
  });

  it('rejects when Marmot refuses the API key', async () => {
    fake = await startFakeMarmot();
    await expect(connectMarmotUpstream(configFor(fake, 'wrong-key'))).rejects.toThrow();
  });

  it('times out slow tool calls', async () => {
    fake = await startFakeMarmot({ onCall: () => new Promise(() => undefined) });
    const upstream = await connectMarmotUpstream(configFor(fake), 200);
    try {
      await expect(upstream.callTool('discover_data', {})).rejects.toThrow(/timed out/i);
    } finally {
      await upstream.close();
    }
  });

  it('handles concurrent calls through one client', async () => {
    fake = await startFakeMarmot();
    const upstream = await connectMarmotUpstream(configFor(fake));
    try {
      const results = await Promise.all(
        ['a', 'b', 'c'].map((query) => upstream.callTool('discover_data', { query }))
      );
      const queries = results.map(
        (result) =>
          (JSON.parse(result.content[0]?.text ?? '{}') as { args: { query: string } }).args.query
      );
      expect(queries).toEqual(['a', 'b', 'c']);
    } finally {
      await upstream.close();
    }
  });
});
