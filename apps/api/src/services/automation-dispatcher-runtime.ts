import { AutomationQueueRegistry } from '@jobagent/queue';
import { dispatchAutomationJobs, type DispatchAutomationJobsResult } from './automation-job-dispatcher';
import { reconcileExpiredAutomationJobLeases } from './automation-jobs';
import { reconcileStaleSubmissionAuthorizations } from './submission-engine';
import { writeStructuredLog } from '../observability/structured-log';

export interface AutomationDispatcherRuntimeOptions {
  intervalMs?: number;
  batchSize?: number;
  shutdownTimeoutMs?: number;
  url?: string;
  prefix?: string;
  onError?: (error: unknown) => void;
}

export class AutomationDispatcherRuntime {
  readonly registry: AutomationQueueRegistry;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly shutdownTimeoutMs: number;
  private readonly onError: (error: unknown) => void;
  private timer?: NodeJS.Timeout;
  private dispatching?: Promise<DispatchAutomationJobsResult>;

  constructor(options: AutomationDispatcherRuntimeOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 100;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) throw new Error('intervalMs must be a positive integer');
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize <= 0) throw new Error('batchSize must be a positive integer');
    if (!Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 1_000) throw new Error('Dispatcher shutdown timeout must be at least one second');
    this.onError = options.onError ?? ((error) => writeStructuredLog('error', { event: 'automation.dispatch_failure', error: error instanceof Error ? error.message : 'unknown error' }));
    this.registry = new AutomationQueueRegistry({ url: options.url, prefix: options.prefix });
  }

  async dispatchOnce(): Promise<DispatchAutomationJobsResult> {
    if (this.dispatching) return this.dispatching;
    this.dispatching = (async () => {
      await reconcileExpiredAutomationJobLeases();
      await reconcileStaleSubmissionAuthorizations();
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
    try {
      if (this.dispatching) {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.dispatching,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Automation dispatcher did not stop before the shutdown timeout')), this.shutdownTimeoutMs);
              timeout.unref();
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
    } finally {
      await this.registry.close();
    }
  }
}
