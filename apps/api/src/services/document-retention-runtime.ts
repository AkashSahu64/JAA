import { DocumentStorage } from './document-storage';
import { purgeExpiredDocuments, type DocumentRetentionResult } from './document-retention';

const MAX_RETENTION_SHUTDOWN_TIMEOUT_MS = 120_000;

export interface DocumentRetentionRuntimeOptions {
  intervalMs?: number;
  shutdownTimeoutMs?: number;
  storage?: Pick<DocumentStorage, 'deleteAuthorized'>;
  onError?: (error: unknown) => void;
}

export class DocumentRetentionRuntime {
  private readonly intervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly storage: Pick<DocumentStorage, 'deleteAuthorized'>;
  private readonly onError: (error: unknown) => void;
  private timer?: NodeJS.Timeout;
  private running?: Promise<DocumentRetentionResult>;
  private closed = false;

  constructor(options: DocumentRetentionRuntimeOptions = {}) {
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1_000) throw new Error('Document retention interval must be at least one second');
    if (!Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 1_000 || this.shutdownTimeoutMs > MAX_RETENTION_SHUTDOWN_TIMEOUT_MS) throw new Error('Document retention shutdown timeout must be between one second and two minutes');
    this.storage = options.storage ?? new DocumentStorage();
    this.onError = options.onError ?? (() => undefined);
  }

  runOnce(): Promise<DocumentRetentionResult> {
    if (this.closed) return Promise.reject(new Error('Document retention runtime is closed'));
    if (this.running) return this.running;
    this.running = purgeExpiredDocuments(this.storage).catch(error => {
      this.onError(error);
      throw error;
    }).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async start(): Promise<DocumentRetentionResult> {
    if (this.timer) throw new Error('Document retention runtime is already running');
    const first = await this.runOnce();
    this.timer = setInterval(() => { void this.runOnce().catch(() => undefined); }, this.intervalMs);
    this.timer.unref();
    return first;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.running) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.running,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Document retention did not stop before the shutdown timeout')), this.shutdownTimeoutMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
