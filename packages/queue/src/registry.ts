import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { bullPriority, deadLetterQueueName, QUEUE_NAMES, queueForJobType, type QueueName } from './names';
import { redisConnection, type QueueConnectionConfig } from './connection';

export interface AutomationQueueMessage {
  automationJobId: string;
  type: string;
  correlationId: string;
  payloadVersion: number;
  deliveryGeneration: number;
  dispatchAttempt: number;
}

export interface EnqueueAutomationJobInput extends AutomationQueueMessage {
  priority: number;
  availableAt: Date;
  maxAttempts: number;
}

export interface DeadLetterEntry {
  id: string;
  name: string;
  message: AutomationQueueMessage;
  failedReason?: string;
  timestamp: number;
}

export interface QueueRegistryOptions extends QueueConnectionConfig {
  defaultJobOptions?: JobsOptions;
}

export function queueJobId(automationJobId: string, dispatchAttempt: number): string {
  return `${automationJobId}-${dispatchAttempt}`;
}

export class AutomationQueueRegistry {
  private readonly queues = new Map<QueueName, Queue<AutomationQueueMessage>>();
  private readonly connection;
  private readonly prefix: string;
  private readonly defaultJobOptions: JobsOptions;

  constructor(options: QueueRegistryOptions = {}) {
    this.connection = redisConnection(options);
    this.prefix = options.prefix ?? process.env.BULLMQ_PREFIX ?? 'jobagent';
    this.defaultJobOptions = options.defaultJobOptions ?? {
      attempts: 1,
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    };
  }

  queue(name: QueueName): Queue<AutomationQueueMessage> {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const created = new Queue<AutomationQueueMessage>(name, {
      connection: this.connection,
      prefix: this.prefix,
      defaultJobOptions: this.defaultJobOptions,
    });
    this.queues.set(name, created);
    return created;
  }

  async enqueue(input: EnqueueAutomationJobInput): Promise<void> {
    const name = queueForJobType(input.type);
    await this.queue(name).add(input.type, {
      automationJobId: input.automationJobId,
      type: input.type,
      correlationId: input.correlationId,
      payloadVersion: input.payloadVersion,
      deliveryGeneration: input.deliveryGeneration,
      dispatchAttempt: input.dispatchAttempt,
    }, {
      jobId: queueJobId(input.automationJobId, input.dispatchAttempt),
      priority: bullPriority(input.priority),
      delay: Math.max(0, input.availableAt.getTime() - Date.now()),
      attempts: input.maxAttempts,
      backoff: { type: 'jobagent-retry', delay: 1_000 },
      removeOnComplete: true,
    });
  }

  async pause(name?: QueueName): Promise<void> {
    await Promise.all((name ? [name] : QUEUE_NAMES).map((queueName) => this.queue(queueName).pause()));
  }

  async resume(name?: QueueName): Promise<void> {
    await Promise.all((name ? [name] : QUEUE_NAMES).map((queueName) => this.queue(queueName).resume()));
  }

  async remove(automationJobId: string, type: string, dispatchAttempt = 1): Promise<boolean> {
    const job = await this.queue(queueForJobType(type)).getJob(queueJobId(automationJobId, dispatchAttempt));
    if (!job) return false;
    await job.remove();
    return true;
  }

  async drain(name?: QueueName): Promise<void> {
    await Promise.all((name ? [name] : QUEUE_NAMES).map((queueName) => this.queue(queueName).drain(true)));
  }

  async listDeadLetters(name: QueueName, start = 0, end = 99): Promise<DeadLetterEntry[]> {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start) {
      throw new Error('Dead-letter range must contain non-negative integers with end >= start');
    }
    const queue = new Queue<AutomationQueueMessage>(deadLetterQueueName(name), {
      connection: this.connection,
      prefix: this.prefix,
    });
    try {
      const jobs = await queue.getJobs(['wait', 'active', 'delayed', 'completed', 'failed'], start, end, true);
      return jobs.map((job) => ({
        id: String(job.id),
        name: job.name,
        message: job.data,
        failedReason: job.failedReason,
        timestamp: job.timestamp,
      }));
    } finally {
      await queue.close();
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
