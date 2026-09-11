export interface DiscoveryTask<T, TSource extends PropertyKey = string> {
  source: TSource;
  run(context: DiscoveryTaskContext<TSource>): T | Promise<T>;
}

export interface DiscoveryTaskContext<TSource extends PropertyKey = string> {
  source: TSource;
  index: number;
  attempt: number;
  signal?: AbortSignal;
}

export interface SourceRateLimit {
  /** Maximum requests from this source that may be in flight. */
  concurrency?: number;
  /** Minimum delay between request starts for this source. */
  minIntervalMs?: number;
}

export interface DiscoveryRetryContext<TSource extends PropertyKey = string>
  extends DiscoveryTaskContext<TSource> {
  error: unknown;
}

export interface DiscoveryRetryOptions<TSource extends PropertyKey = string> {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (context: DiscoveryRetryContext<TSource>) => boolean;
  retryAfterMs?: (error: unknown, nowMs: number) => number | undefined;
}

export type SourceRateLimits<TSource extends PropertyKey> =
  | ReadonlyMap<TSource, SourceRateLimit>
  | Partial<Record<TSource, SourceRateLimit>>
  | ((source: TSource) => SourceRateLimit | undefined);

export interface DiscoveryExecutorOptions<TSource extends PropertyKey = string> {
  concurrency?: number;
  sourceRateLimits?: SourceRateLimits<TSource>;
  retry?: DiscoveryRetryOptions<TSource>;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  /** Protects callers from accidentally materializing an infinite iterable. */
  maxTasks?: number;
}

export type DiscoveryExecutionResult<T, TSource extends PropertyKey = string> =
  | { status: 'fulfilled'; source: TSource; index: number; attempts: number; value: T }
  | { status: 'rejected'; source: TSource; index: number; attempts: number; reason: unknown };

interface NormalizedOptions<TSource extends PropertyKey> {
  concurrency: number;
  sourceRateLimits?: SourceRateLimits<TSource>;
  retry: Required<Pick<DiscoveryRetryOptions<TSource>, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'>> &
    Omit<DiscoveryRetryOptions<TSource>, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'>;
  signal?: AbortSignal;
  now: () => number;
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  maxTasks: number;
}

interface SourceState {
  active: number;
  nextStartAt: number;
  blockedUntil: number;
}

interface QueuedTask<T, TSource extends PropertyKey> {
  task: DiscoveryTask<T, TSource>;
  index: number;
  attempt: number;
  readyAt: number;
}

const DEFAULT_MAX_TASKS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class DiscoveryExecutionAbortedError extends Error {
  constructor(public readonly reason?: unknown) {
    super('Discovery execution was aborted', reason === undefined ? undefined : { cause: reason });
    this.name = 'DiscoveryExecutionAbortedError';
  }
}

export async function executeDiscovery<T, TSource extends PropertyKey = string>(
  tasks: Iterable<DiscoveryTask<T, TSource>>,
  options: DiscoveryExecutorOptions<TSource> = {},
): Promise<Array<DiscoveryExecutionResult<T, TSource>>> {
  const normalized = normalizeOptions(options);
  throwIfAborted(normalized.signal);

  const queue = materializeTasks(tasks, normalized.maxTasks);
  const results = new Array<DiscoveryExecutionResult<T, TSource>>(queue.length);
  const sourceStates = new Map<TSource, SourceState>();
  let active = 0;
  let completed = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let scheduling = false;
    let wakeVersion = 0;
    let scheduledWakeAt = Number.POSITIVE_INFINITY;

    const abort = () => {
      if (settled) return;
      settled = true;
      reject(new DiscoveryExecutionAbortedError(normalized.signal?.reason));
    };
    normalized.signal?.addEventListener('abort', abort, { once: true });

    const finish = () => {
      if (settled || completed !== results.length) return;
      settled = true;
      normalized.signal?.removeEventListener('abort', abort);
      resolve(results);
    };

    const schedule = () => {
      if (settled || scheduling) return;
      if (normalized.signal?.aborted) return abort();
      scheduling = true;
      let earliestWake = Number.POSITIVE_INFINITY;

      try {
        while (active < normalized.concurrency) {
          const now = normalized.now();
          const selection = selectRunnable(queue, sourceStates, normalized, now);
          earliestWake = Math.min(earliestWake, selection.earliestWake);
          if (selection.queueIndex < 0) break;

          const [item] = queue.splice(selection.queueIndex, 1);
          const state = getSourceState(sourceStates, item.task.source);
          const limit = sourceLimit(normalized.sourceRateLimits, item.task.source);
          state.active += 1;
          state.nextStartAt = now + limit.minIntervalMs;
          active += 1;
          void runTask(item, normalized).then(outcome => {
            active -= 1;
            state.active -= 1;
            if (settled) return;
            if (outcome.retry) {
              const readyAt = normalized.now() + outcome.delayMs;
              state.blockedUntil = Math.max(state.blockedUntil, readyAt);
              queue.push({ ...item, attempt: item.attempt + 1, readyAt });
            } else {
              results[item.index] = outcome.result;
              completed += 1;
            }
            finish();
            schedule();
          }, error => {
            active -= 1;
            state.active -= 1;
            if (settled) return;
            settled = true;
            normalized.signal?.removeEventListener('abort', abort);
            reject(error);
          });
        }
      } catch (error) {
        settled = true;
        normalized.signal?.removeEventListener('abort', abort);
        reject(error);
      } finally {
        scheduling = false;
      }

      finish();
      if (!settled && active < normalized.concurrency && queue.length > 0 &&
          Number.isFinite(earliestWake) && earliestWake < scheduledWakeAt) {
        scheduledWakeAt = earliestWake;
        const version = ++wakeVersion;
        const delayMs = Math.max(0, earliestWake - normalized.now());
        void normalized.sleep(delayMs, normalized.signal).then(
          () => {
            if (settled || version !== wakeVersion) return;
            scheduledWakeAt = Number.POSITIVE_INFINITY;
            schedule();
          },
          error => { if (!settled && version === wakeVersion) { settled = true; reject(error); } },
        );
      }
    };

    if (results.length === 0) finish();
    else schedule();
  });
}

function normalizeOptions<TSource extends PropertyKey>(options: DiscoveryExecutorOptions<TSource>): NormalizedOptions<TSource> {
  const concurrency = positiveInteger(options.concurrency ?? 4, 'concurrency');
  const maxTasks = positiveInteger(options.maxTasks ?? DEFAULT_MAX_TASKS, 'maxTasks');
  const maxAttempts = positiveInteger(options.retry?.maxAttempts ?? 1, 'retry.maxAttempts');
  const baseDelayMs = nonNegativeFinite(options.retry?.baseDelayMs ?? 250, 'retry.baseDelayMs');
  const maxDelayMs = nonNegativeFinite(options.retry?.maxDelayMs ?? 30_000, 'retry.maxDelayMs');
  if (maxDelayMs < baseDelayMs) throw new RangeError('retry.maxDelayMs must be at least retry.baseDelayMs');
  return {
    concurrency,
    maxTasks,
    sourceRateLimits: options.sourceRateLimits,
    signal: options.signal,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? abortableSleep,
    retry: {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      shouldRetry: options.retry?.shouldRetry,
      retryAfterMs: options.retry?.retryAfterMs ?? retryAfterFromError,
    },
  };
}

function materializeTasks<T, TSource extends PropertyKey>(
  tasks: Iterable<DiscoveryTask<T, TSource>>,
  maxTasks: number,
): Array<QueuedTask<T, TSource>> {
  const queue: Array<QueuedTask<T, TSource>> = [];
  for (const task of tasks) {
    if (queue.length >= maxTasks) throw new RangeError(`Discovery task count exceeds maxTasks (${maxTasks})`);
    if (!task || typeof task.run !== 'function') throw new TypeError('Each discovery task must provide a run function');
    queue.push({ task, index: queue.length, attempt: 1, readyAt: Number.NEGATIVE_INFINITY });
  }
  return queue;
}

function selectRunnable<T, TSource extends PropertyKey>(
  queue: Array<QueuedTask<T, TSource>>,
  states: Map<TSource, SourceState>,
  options: NormalizedOptions<TSource>,
  now: number,
): { queueIndex: number; earliestWake: number } {
  let earliestWake = Number.POSITIVE_INFINITY;
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    const state = getSourceState(states, item.task.source);
    const limit = sourceLimit(options.sourceRateLimits, item.task.source);
    if (state.active >= limit.concurrency) continue;
    const readyAt = Math.max(item.readyAt, state.nextStartAt, state.blockedUntil);
    if (readyAt <= now) return { queueIndex: index, earliestWake };
    earliestWake = Math.min(earliestWake, readyAt);
  }
  return { queueIndex: -1, earliestWake };
}

function sourceLimit<TSource extends PropertyKey>(
  limits: SourceRateLimits<TSource> | undefined,
  source: TSource,
): Required<SourceRateLimit> {
  let configured: SourceRateLimit | undefined;
  if (typeof limits === 'function') configured = limits(source);
  else if (limits && typeof (limits as ReadonlyMap<TSource, SourceRateLimit>).get === 'function') {
    configured = (limits as ReadonlyMap<TSource, SourceRateLimit>).get(source);
  } else if (limits) configured = (limits as Partial<Record<TSource, SourceRateLimit>>)[source];
  return {
    concurrency: positiveInteger(configured?.concurrency ?? 1, `sourceRateLimits[${String(source)}].concurrency`),
    minIntervalMs: nonNegativeFinite(configured?.minIntervalMs ?? 0, `sourceRateLimits[${String(source)}].minIntervalMs`),
  };
}

function getSourceState<TSource extends PropertyKey>(states: Map<TSource, SourceState>, source: TSource): SourceState {
  let state = states.get(source);
  if (!state) {
    state = { active: 0, nextStartAt: Number.NEGATIVE_INFINITY, blockedUntil: Number.NEGATIVE_INFINITY };
    states.set(source, state);
  }
  return state;
}

type TaskOutcome<T, TSource extends PropertyKey> =
  | { retry: true; delayMs: number }
  | { retry: false; result: DiscoveryExecutionResult<T, TSource> };

async function runTask<T, TSource extends PropertyKey>(
  item: QueuedTask<T, TSource>,
  options: NormalizedOptions<TSource>,
): Promise<TaskOutcome<T, TSource>> {
  const context: DiscoveryTaskContext<TSource> = {
    source: item.task.source,
    index: item.index,
    attempt: item.attempt,
    signal: options.signal,
  };
  try {
    throwIfAborted(options.signal);
    const value = await item.task.run(context);
    return {
      retry: false,
      result: { status: 'fulfilled', source: item.task.source, index: item.index, attempts: item.attempt, value },
    };
  } catch (error) {
    if (options.signal?.aborted) throw new DiscoveryExecutionAbortedError(options.signal.reason);
    const retryContext = { ...context, error };
    if (item.attempt < options.retry.maxAttempts && (options.retry.shouldRetry?.(retryContext) ?? true)) {
      const retryAfterMs = options.retry.retryAfterMs?.(error, options.now());
      const backoff = Math.min(options.retry.maxDelayMs, options.retry.baseDelayMs * (2 ** (item.attempt - 1)));
      return { retry: true, delayMs: Math.max(backoff, validDelay(retryAfterMs)) };
    }
    return {
      retry: false,
      result: { status: 'rejected', source: item.task.source, index: item.index, attempts: item.attempt, reason: error },
    };
  }
}

/** Extracts Retry-After metadata from common error shapes. Seconds and HTTP dates are supported. */
export function retryAfterFromError(error: unknown, nowMs = Date.now()): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    retryAfterMs?: unknown;
    retryAfter?: unknown;
    headers?: { get?: (name: string) => string | null };
    response?: { headers?: { get?: (name: string) => string | null } };
  };
  if (typeof candidate.retryAfterMs === 'number') return validDelay(candidate.retryAfterMs);
  const raw = candidate.retryAfter ?? candidate.headers?.get?.('retry-after') ?? candidate.response?.headers?.get?.('retry-after');
  if (typeof raw === 'number') return validDelay(raw * 1_000);
  if (typeof raw !== 'string') return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return validDelay(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? validDelay(date - nowMs) : undefined;
}

function validDelay(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(value, MAX_TIMER_DELAY_MS)) : 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DiscoveryExecutionAbortedError(signal.reason);
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DiscoveryExecutionAbortedError(signal?.reason));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
