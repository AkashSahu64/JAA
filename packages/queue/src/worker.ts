import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import { deadLetterQueueName, type QueueName } from './names';
import { queueJobId, type AutomationQueueMessage } from './registry';
import { redisConnection, type QueueConnectionConfig } from './connection';

export interface AutomationWorkerContext {
  workerId: string;
  signal: AbortSignal;
  heartbeat: () => Promise<void>;
}

export interface AutomationWorkerResult {
  outcome: 'EXECUTED' | 'SKIPPED';
}

export type AutomationProcessor = (message: AutomationQueueMessage, context: AutomationWorkerContext) => Promise<AutomationWorkerResult | void>;

export interface AutomationRetryContext {
  /** BullMQ executions failed for the current delivery, including the failure being retried. */
  failedAttempts: number;
  /** The dispatch attempt that will be persisted in the queue envelope before the retry is delayed. */
  nextDispatchAttempt: number;
  /** Unchanged fencing token for this delivery. */
  deliveryGeneration: number;
}

export interface AutomationWorkerOptions extends QueueConnectionConfig {
  workerId: string;
  concurrency?: number;
  limiter?: WorkerOptions['limiter'];
  leaseMs?: number;
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  maxStalledCount?: number;
  processor: AutomationProcessor;
  onFailure: (message: AutomationQueueMessage, error: Error, retryDelayMs: number) => Promise<'RETRY' | 'DEAD_LETTER' | 'IGNORED'>;
  onComplete: (message: AutomationQueueMessage, result: AutomationWorkerResult | void) => Promise<void>;
  shouldRetry: (message: AutomationQueueMessage) => Promise<boolean>;
  /**
   * Confirms the authoritative attempt transition before BullMQ persists and delays an internal retry.
   * The queue advances only dispatchAttempt; deliveryGeneration and all other envelope fields stay unchanged.
   */
  onRetry?: (message: AutomationQueueMessage, context: AutomationRetryContext) => Promise<void>;
  onRenew: (message: AutomationQueueMessage, leaseMs: number) => Promise<void>;
  /** Identifies an onRenew failure that conclusively means this worker no longer owns the lease. */
  isLeaseLost?: (error: unknown) => boolean;
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function retryJitter(automationJobId: string, attempt: number): number {
  let hash = 2_166_136_261;
  const input = `${automationJobId}:${attempt}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0xffff_ffff;
}

export function retryDelayMs(attempt: number, baseMs = 1_000, jitter = Math.random()): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.round(exponential * (0.75 + Math.max(0, Math.min(1, jitter)) * 0.5));
}

export class AutomationQueueWorker {
  private readonly worker: Worker<AutomationQueueMessage, AutomationWorkerResult | void>;
  private readonly deadLetterQueue: Queue<AutomationQueueMessage>;

  constructor(name: QueueName, options: AutomationWorkerOptions) {
    const connection = redisConnection(options);
    const prefix = options.prefix ?? process.env.BULLMQ_PREFIX ?? 'jobagent';
    const leaseMs = options.leaseMs ?? 30_000;
    this.deadLetterQueue = new Queue(deadLetterQueueName(name), { connection, prefix });
    this.worker = new Worker<AutomationQueueMessage, AutomationWorkerResult | void>(name, async (job) => {
      const controller = new AbortController();
      let renewal: Promise<void> | undefined;
      const renew = async () => {
        try {
          await options.onRenew(job.data, leaseMs);
        } catch (error) {
          if (options.isLeaseLost?.(error)) controller.abort(error);
          throw error;
        }
      };
      const heartbeat = () => {
        if (!renewal) {
          renewal = renew().finally(() => {
            renewal = undefined;
          });
        }
        return renewal;
      };
      const timer = setInterval(() => void heartbeat().catch(() => undefined), Math.max(1_000, Math.floor(leaseMs / 3)));
      timer.unref();
      try {
        const result = await options.processor(job.data, { workerId: options.workerId, signal: controller.signal, heartbeat });
        await options.onComplete(job.data, result);
        return result;
      } catch (value) {
        const error = errorFrom(value);
        const attempt = job.attemptsMade + 1;
        const delay = retryDelayMs(attempt, 1_000, retryJitter(job.data.automationJobId, attempt));
        const disposition = await options.onFailure(job.data, error, delay);
        if (disposition === 'DEAD_LETTER') {
          await this.deadLetter(job, error);
          return { outcome: 'EXECUTED' };
        }
        if (disposition === 'RETRY') throw error;
        return { outcome: 'SKIPPED' };
      } finally {
        clearInterval(timer);
        await renewal?.catch(() => undefined);
      }
    }, {
      connection,
      prefix,
      concurrency: options.concurrency ?? 4,
      ...(options.limiter ? { limiter: options.limiter } : {}),
      lockDuration: options.lockDurationMs ?? leaseMs,
      ...(options.stalledIntervalMs ? { stalledInterval: options.stalledIntervalMs } : {}),
      ...(options.maxStalledCount !== undefined ? { maxStalledCount: options.maxStalledCount } : {}),
      settings: {
        backoffStrategy: async (attemptsMade, _type, _error, job) => {
          const message = job?.data as AutomationQueueMessage | undefined;
          if (message && !await options.shouldRetry(message)) return -1;
          if (job && message) {
            const nextDispatchAttempt = message.dispatchAttempt + 1;
            await options.onRetry?.(message, {
              failedAttempts: attemptsMade,
              nextDispatchAttempt,
              deliveryGeneration: message.deliveryGeneration,
            });
            await job.updateData({ ...message, dispatchAttempt: nextDispatchAttempt });
          }
          return retryDelayMs(
            attemptsMade,
            1_000,
            message ? retryJitter(message.automationJobId, attemptsMade) : 0.5,
          );
        },
      },
      autorun: true,
    });
  }

  private async deadLetter(job: Job<AutomationQueueMessage>, error: Error): Promise<void> {
    await this.deadLetterQueue.add(job.name, job.data, {
      jobId: queueJobId(job.data.automationJobId, job.attemptsMade + 1),
      removeOnComplete: false,
      removeOnFail: false,
    });
    await job.log(`Dead-lettered: ${error.message.slice(0, 10_000)}`);
  }

  async pause(): Promise<void> {
    await this.worker.pause();
  }

  async resume(): Promise<void> {
    await this.worker.resume();
  }

  async close(force = false): Promise<void> {
    await this.worker.close(force);
    await this.deadLetterQueue.close();
  }
}
