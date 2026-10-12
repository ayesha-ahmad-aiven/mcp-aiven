import { toolSuccess, type ToolResult } from '../types.js';
import { wrapUntrustedResponse } from '../untrusted.js';
import type { UpstreamCallResult } from './upstream.js';

export function toProxiedResult(result: UpstreamCallResult, toolName: string): ToolResult {
  const body = result.content
    .map((item) => (item.type === 'text' ? (item.text ?? '') : `[${item.type} content omitted]`))
    .join('\n');
  const converted = toolSuccess(wrapUntrustedResponse(body), toolName);
  return result.isError === true ? { ...converted, isError: true } : converted;
}
