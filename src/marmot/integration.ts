import type { MarmotConfig } from '../config.js';
import { errorMessage } from '../errors.js';
import type { ToolDefinition } from '../types.js';
import type { CallerAuthorizer } from './authorize.js';
import { buildProxyTools, MarmotDiscoveryError, redactSecret } from './proxy-tools.js';
import { connectMarmotUpstream, type MarmotUpstreamClient } from './upstream.js';

export type MarmotStatus = 'disabled' | 'ok' | 'unavailable';

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
const DEFAULT_REDISCOVERY_INTERVAL_MS = 60_000;

export interface MarmotIntegrationOptions {
  readonly config: MarmotConfig | undefined;
  readonly existingToolNames: ReadonlySet<string>;
  readonly authorize: CallerAuthorizer;
  readonly connect?: ((config: MarmotConfig) => Promise<MarmotUpstreamClient>) | undefined;
  readonly retryDelaysMs?: readonly number[] | undefined;
  readonly rediscoveryIntervalMs?: number | undefined;
  readonly log?: ((message: string) => void) | undefined;
}

type ToolsListener = (tools: readonly ToolDefinition[]) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MarmotIntegration {
  private readonly options: MarmotIntegrationOptions;
  private readonly listeners: ToolsListener[] = [];
  private upstream: MarmotUpstreamClient | undefined;
  private discovered: readonly ToolDefinition[] = [];
  private currentStatus: MarmotStatus;
  private timer: NodeJS.Timeout | undefined;
  private discovering = false;
  private closed = false;

  constructor(options: MarmotIntegrationOptions) {
    this.options = options;
    this.currentStatus = options.config ? 'unavailable' : 'disabled';
  }

  get status(): MarmotStatus {
    return this.currentStatus;
  }

  get tools(): readonly ToolDefinition[] {
    return this.discovered;
  }

  onToolsDiscovered(listener: ToolsListener): void {
    this.listeners.push(listener);
  }

  async start(): Promise<void> {
    const config = this.options.config;
    if (!config) return;

    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const attempts = delays.length + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.closed) return;
      try {
        if (await this.discover(config)) this.notify();
        return;
      } catch (error) {
        if (error instanceof MarmotDiscoveryError) {
          this.logDiscoveryError(error);
          return;
        }
        this.log(
          `Marmot connection attempt ${attempt + 1} of ${attempts} failed: ${this.describe(error)}`
        );
        const delay = delays[attempt];
        if (delay !== undefined) await sleep(delay);
      }
    }
    if (this.closed) return;

    this.log(
      'Marmot unavailable; starting without Marmot data catalog tools and retrying in the background'
    );
    this.scheduleRediscovery(config);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.upstream?.close();
    this.upstream = undefined;
  }

  private scheduleRediscovery(config: MarmotConfig): void {
    const interval = this.options.rediscoveryIntervalMs ?? DEFAULT_REDISCOVERY_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.rediscover(config);
    }, interval);
    this.timer.unref();
  }

  private async rediscover(config: MarmotConfig): Promise<void> {
    if (this.discovering || this.closed) return;
    this.discovering = true;
    try {
      if (!(await this.discover(config))) return;
      this.stopRediscovery();
      this.notify();
    } catch (error) {
      if (error instanceof MarmotDiscoveryError) {
        this.stopRediscovery();
        this.logDiscoveryError(error);
        return;
      }
      this.log(`Marmot rediscovery failed: ${this.describe(error)}`);
    } finally {
      this.discovering = false;
    }
  }

  private stopRediscovery(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.discovered);
  }

  private logDiscoveryError(error: MarmotDiscoveryError): void {
    this.log(
      `Marmot data catalog tools disabled until restart: ${this.describe(error)}`
    );
  }

  private async discover(config: MarmotConfig): Promise<boolean> {
    const connect = this.options.connect ?? connectMarmotUpstream;
    const upstream = await connect(config);
    try {
      const upstreamTools = await upstream.listAllTools();
      const tools = buildProxyTools(upstreamTools, this.options.existingToolNames, {
        upstream,
        authorize: this.options.authorize,
        apiKey: config.apiKey,
      });
      if (this.closed) {
        await upstream.close().catch(() => undefined);
        return false;
      }
      this.upstream = upstream;
      this.discovered = tools;
      this.currentStatus = 'ok';
      this.log(
        `Marmot connected at ${config.mcpUrl.origin}; tools=${tools.map((tool) => tool.name).join(',')}`
      );
      return true;
    } catch (error) {
      await upstream.close().catch(() => undefined);
      throw error;
    }
  }

  private describe(error: unknown): string {
    return redactSecret(errorMessage(error), this.options.config?.apiKey ?? '');
  }

  private log(message: string): void {
    (this.options.log ?? console.error)(`mcp-aiven: ${message}`);
  }
}
