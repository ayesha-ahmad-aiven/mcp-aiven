import { z } from 'zod';
import { errorMessage } from '../errors.js';
import { REASONING_MAX_LENGTH, reasoningField } from '../tools/shared-schemas.js';
import {
  ServiceCategory,
  toolError,
  type ToolAnnotations,
  type ToolDefinition,
  type ToolResult,
} from '../types.js';
import type { CallerAuthorizer } from './authorize.js';
import { toProxiedResult } from './result.js';
import type { MarmotUpstreamClient, UpstreamTool } from './upstream.js';

export const CONTEXT_TOOL_PREFIX = 'aiven_context_';
export const CONTEXT_DESCRIPTION_PREFIX = 'Marmot data catalog:';

export const KNOWN_READ_TOOLS: ReadonlySet<string> = new Set([
  'discover_data',
  'find_ownership',
  'lookup_term',
  'explore_data_products',
  'explore_teams',
  'trace_lineage',
]);

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

const READ_DEFAULTS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const UNKNOWN_DEFAULTS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const REASONING_JSON_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: REASONING_MAX_LENGTH,
  description: reasoningField.description,
};

const PROXY_INPUT_SCHEMA = z.object({ reasoning: reasoningField }).passthrough();

export class MarmotDiscoveryError extends Error {}

export interface ProxyToolDeps {
  readonly upstream: Pick<MarmotUpstreamClient, 'callTool'>;
  readonly authorize: CallerAuthorizer;
  readonly apiKey: string;
}

export function redactSecret(text: string, secret: string): string {
  return secret === '' ? text : text.split(secret).join('[redacted]');
}

export function buildProxyTools(
  upstreamTools: readonly UpstreamTool[],
  existingNames: ReadonlySet<string>,
  deps: ProxyToolDeps
): ToolDefinition[] {
  const seen = new Set<string>();
  return upstreamTools.map((tool) => {
    const name = `${CONTEXT_TOOL_PREFIX}${tool.name}`;
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new MarmotDiscoveryError(
        `Marmot tool "${tool.name}" produces an invalid local name "${name}"`
      );
    }
    if (seen.has(name)) {
      throw new MarmotDiscoveryError(`Marmot returned duplicate tool "${tool.name}"`);
    }
    if (existingNames.has(name)) {
      throw new MarmotDiscoveryError(
        `Marmot tool "${tool.name}" collides with existing tool "${name}"`
      );
    }
    seen.add(name);
    return buildProxyTool(tool, name, deps);
  });
}

function resolveAnnotations(tool: UpstreamTool): ToolAnnotations {
  const defaults = KNOWN_READ_TOOLS.has(tool.name) ? READ_DEFAULTS : UNKNOWN_DEFAULTS;
  const upstream = tool.annotations ?? {};
  return {
    readOnlyHint: upstream.readOnlyHint ?? defaults.readOnlyHint,
    destructiveHint: upstream.destructiveHint ?? defaults.destructiveHint,
    idempotentHint: upstream.idempotentHint ?? defaults.idempotentHint,
    openWorldHint: upstream.openWorldHint ?? defaults.openWorldHint,
  };
}

function advertisedInputSchema(tool: UpstreamTool): Record<string, unknown> {
  const properties = (tool.inputSchema['properties'] ?? {}) as Record<string, unknown>;
  if ('reasoning' in properties) {
    throw new MarmotDiscoveryError(
      `Marmot tool "${tool.name}" already defines a "reasoning" argument`
    );
  }
  const required = Array.isArray(tool.inputSchema['required'])
    ? (tool.inputSchema['required'] as string[])
    : [];
  return {
    ...tool.inputSchema,
    type: 'object',
    properties: { ...properties, reasoning: REASONING_JSON_SCHEMA },
    required: [...required, 'reasoning'],
  };
}

function buildProxyTool(tool: UpstreamTool, name: string, deps: ProxyToolDeps): ToolDefinition {
  return {
    name,
    category: ServiceCategory.Context,
    definition: {
      title: tool.title ?? tool.annotations?.title ?? tool.name,
      description: `${CONTEXT_DESCRIPTION_PREFIX} ${tool.description ?? ''}`.trim(),
      inputSchema: PROXY_INPUT_SCHEMA,
      annotations: resolveAnnotations(tool),
    },
    advertisedInputSchema: advertisedInputSchema(tool),
    handler: async (params, context): Promise<ToolResult> => {
      const authorization = await deps.authorize(context?.token);
      if (!authorization.ok) return toolError(authorization.message);

      const args: Record<string, unknown> = { ...(params as Record<string, unknown>) };
      delete args['reasoning'];
      try {
        return toProxiedResult(await deps.upstream.callTool(tool.name, args), name);
      } catch (error) {
        return toolError(
          redactSecret(`Marmot tool call failed for ${name}: ${errorMessage(error)}`, deps.apiKey)
        );
      }
    },
  };
}
