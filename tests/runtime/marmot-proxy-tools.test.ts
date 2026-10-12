import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildProxyTools,
  MarmotDiscoveryError,
  type ProxyToolDeps,
} from '../../src/marmot/proxy-tools.js';
import { toProxiedResult } from '../../src/marmot/result.js';
import type { UpstreamTool } from '../../src/marmot/upstream.js';
import { ServiceCategory, type ToolDefinition } from '../../src/types.js';

const API_KEY = 'secret-marmot-key';

function upstreamTool(name: string, overrides: Partial<UpstreamTool> = {}): UpstreamTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ProxyToolDeps> = {}): ProxyToolDeps {
  return {
    upstream: {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] }),
    },
    authorize: vi.fn().mockResolvedValue({ ok: true }),
    apiKey: API_KEY,
    ...overrides,
  };
}

function getTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} not found`);
  return tool;
}

function resultText(result: Awaited<ReturnType<ToolDefinition['handler']>>): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('expected text content');
  return first.text;
}

describe('buildProxyTools', () => {
  it('prefixes names and descriptions and uses the context category', () => {
    const [tool] = buildProxyTools([upstreamTool('discover_data')], new Set(), makeDeps());

    expect(tool?.name).toBe('aiven_context_discover_data');
    expect(tool?.category).toBe(ServiceCategory.Context);
    expect(tool?.definition.title).toBe('discover_data');
    expect(tool?.definition.description).toBe('Marmot data catalog: discover_data description');
  });

  it('advertises the upstream schema with a required reasoning argument', () => {
    const [tool] = buildProxyTools(
      [
        upstreamTool('manage_tags', {
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', format: 'uuid' } },
            required: ['id'],
            additionalProperties: false,
          },
        }),
      ],
      new Set(),
      makeDeps()
    );

    expect(tool?.advertisedInputSchema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        reasoning: expect.objectContaining({ type: 'string', minLength: 1, maxLength: 2000 }),
      },
      required: ['id', 'reasoning'],
      additionalProperties: false,
    });
  });

  it('rejects an upstream schema that already defines reasoning', () => {
    const tool = upstreamTool('discover_data', {
      inputSchema: { type: 'object', properties: { reasoning: { type: 'string' } } },
    });
    expect(() => buildProxyTools([tool], new Set(), makeDeps())).toThrow(MarmotDiscoveryError);
  });

  it.each([
    [
      'duplicate upstream names',
      [upstreamTool('discover_data'), upstreamTool('discover_data')],
      new Set<string>(),
    ],
    [
      'a collision with an existing tool',
      [upstreamTool('discover_data')],
      new Set(['aiven_context_discover_data']),
    ],
    ['an invalid local name', [upstreamTool('discover data')], new Set<string>()],
  ])('rejects %s', (_label, tools, existing) => {
    expect(() => buildProxyTools(tools, existing, makeDeps())).toThrow(MarmotDiscoveryError);
  });

  it('marks known read tools read-only and unknown tools as destructive writes', () => {
    const tools = buildProxyTools(
      [upstreamTool('trace_lineage'), upstreamTool('manage_owners')],
      new Set(),
      makeDeps()
    );

    expect(getTool(tools, 'aiven_context_trace_lineage').definition.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(getTool(tools, 'aiven_context_manage_owners').definition.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('prefers upstream annotations when present', () => {
    const [tool] = buildProxyTools(
      [
        upstreamTool('custom_report', {
          annotations: { readOnlyHint: true, destructiveHint: false },
        }),
      ],
      new Set(),
      makeDeps()
    );

    expect(tool?.definition.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe('proxied tool handler', () => {
  it('authorizes the caller, removes reasoning, and forwards the remaining arguments', async () => {
    const deps = makeDeps();
    const tool = getTool(
      buildProxyTools([upstreamTool('discover_data')], new Set(), deps),
      'aiven_context_discover_data'
    );

    const result = await tool.handler(
      { reasoning: 'find orders', query: 'orders' },
      { token: 'caller-token' }
    );

    expect(deps.authorize).toHaveBeenCalledWith('caller-token');
    expect(deps.upstream.callTool).toHaveBeenCalledWith('discover_data', { query: 'orders' });
    expect(resultText(result)).toMatch(
      /<untrusted-aiven-response-[^>]+>\n\{"ok":true\}\n<\/untrusted-aiven-response-/
    );
    expect(result.isError).toBeUndefined();
  });

  it('returns the authorization error without calling Marmot', async () => {
    const deps = makeDeps({
      authorize: vi.fn().mockResolvedValue({ ok: false, message: 'denied' }),
    });
    const tool = getTool(
      buildProxyTools([upstreamTool('discover_data')], new Set(), deps),
      'aiven_context_discover_data'
    );

    const result = await tool.handler({ reasoning: 'r' }, { token: 'bogus' });

    expect(result).toEqual({ content: [{ type: 'text', text: 'denied' }], isError: true });
    expect(deps.upstream.callTool).not.toHaveBeenCalled();
  });

  it('turns upstream failures into tool errors without the API key', async () => {
    const deps = makeDeps({
      upstream: {
        callTool: vi.fn().mockRejectedValue(new Error(`connection reset, key=${API_KEY}`)),
      },
    });
    const tool = getTool(
      buildProxyTools([upstreamTool('discover_data')], new Set(), deps),
      'aiven_context_discover_data'
    );

    const result = await tool.handler({ reasoning: 'r' }, { token: 't' });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('aiven_context_discover_data');
    expect(resultText(result)).not.toContain(API_KEY);
  });

  it.each([
    ['a successful result', undefined],
    ['an error result', true],
  ])('redacts the API key from %s', async (_label, isError) => {
    const deps = makeDeps({
      upstream: {
        callTool: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: `echo ${API_KEY}` },
            { type: 'image' },
            { type: 'text', text: `${API_KEY}${API_KEY}` },
          ],
          isError,
        }),
      },
    });
    const tool = getTool(
      buildProxyTools([upstreamTool('discover_data')], new Set(), deps),
      'aiven_context_discover_data'
    );

    const result = await tool.handler({ reasoning: 'r' }, { token: 't' });

    expect(result.isError).toBe(isError);
    expect(resultText(result)).toContain('echo [redacted]');
    for (const item of result.content) {
      expect(JSON.stringify(item)).not.toContain(API_KEY);
    }
  });
});

describe('toProxiedResult', () => {
  afterEach(() => {
    delete process.env['MCP_MAX_TOOL_RESULT_CHARS'];
  });

  it('keeps text, replaces other content with a placeholder, and drops structured content', () => {
    const result = toProxiedResult(
      {
        content: [
          { type: 'text', text: 'first' },
          { type: 'image' },
          { type: 'text', text: 'second' },
        ],
        structuredContent: { hidden: true },
      } as never,
      'aiven_context_discover_data'
    );

    expect(result.structuredContent).toBeUndefined();
    expect(resultText(result)).toContain('first\n[image content omitted]\nsecond');
  });

  it('preserves the error marker', () => {
    const result = toProxiedResult(
      { content: [{ type: 'text', text: 'nope' }], isError: true },
      'tool'
    );
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('nope');
  });

  it('applies the tool result character limit', () => {
    process.env['MCP_MAX_TOOL_RESULT_CHARS'] = '500';
    const result = toProxiedResult(
      { content: [{ type: 'text', text: 'x'.repeat(5_000) }] },
      'tool'
    );
    expect(resultText(result)).toContain('Trimmed');
  });
});
