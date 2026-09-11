import { AutomationQueueRegistry } from '@jobagent/queue';
import { dispatchAutomationJobs, type DispatchAutomationJobsResult } from './automation-job-dispatcher';
import { reconcileExpiredAutomationJobLeases } from './automation-jobs';

export interface AutomationDispatcherRuntimeOptions {
  intervalMs?: number;
  batchSize?: number;
  url?: string;
  prefix?: string;
  onError?: (error: unknown) => void;
}

export class AutomationDispatcherRuntime {
  readonly registry: AutomationQueueRegistry;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly onError: (error: unknown) => void;
  private timer?: NodeJS.Timeout;
  private dispatching?: Promise<DispatchAutomationJobsResult>;

  constructor(options: AutomationDispatcherRuntimeOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) throw new Error('intervalMs must be a positive integer');
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize <= 0) throw new Error('batchSize must be a positive integer');
    this.onError = options.onError ?? ((error) => console.error('Automation dispatch failed', error));
    this.registry = new AutomationQueueRegistry({ url: options.url, prefix: options.prefix });
  }

  async dispatchOnce(): Promise<DispatchAutomationJobsResult> {
    if (this.dispatching) return this.dispatching;
    this.dispatching = (async () => {
      await reconcileExpiredAutomationJobLeases();
      return dispatchAutomationJobs(this.registry, { batchSize: this.batchSize });
    })();
    try {
      return await this.dispatching;
    } finally {
      this.dispatching = undefined;
    }
  }

  async start(): Promise<DispatchAutomationJobsResult> {
    if (this.timer) throw new Error('Automation dispatcher is already running');
    const first = await this.dispatchOnce();
    this.timer = setInterval(() => {
      void this.dispatchOnce().catch(this.onError);
    }, this.intervalMs);
    this.timer.unref();
    return first;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.dispatching;
    await this.registry.close();
  }
}
