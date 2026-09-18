export const QUEUE_NAMES = [
  'discovery',
  'analysis',
  'documents',
  'applications',
  'notifications',
  'maintenance',
] as const;

export type QueueName = typeof QUEUE_NAMES[number];

/**
 * Routing is an exact-match table keyed by the automation job types the worker actually
 * dispatches. It is deliberately not prefix matching: prefix matching silently sent
 * EXECUTE_AUTHORIZED_SUBMISSION, EVALUATE_ATS, EVALUATE_APPLICATION_QUALITY and both
 * COMPLETE_*_APPLICATION types to `maintenance`, where no handler consumes them, so real
 * submissions were enqueued onto a queue that never runs them.
 *
 * Every type in createProductionAutomationJobHandlers() must appear here. Adding a handler
 * without a route is caught by the routing test in apps/api.
 */
const JOB_TYPE_QUEUE_ROUTES: Readonly<Record<string, QueueName>> = {
  // Discovery
  DISCOVER_JOBS: 'discovery',
  // Analysis and document tailoring
  ANALYZE_JOB: 'analysis',
  MATCH_JOB: 'analysis',
  TAILOR_RESUME: 'analysis',
  EVALUATE_ATS: 'analysis',
  EVALUATE_APPLICATION_QUALITY: 'analysis',
  // Application execution and confirmation
  COMPLETE_GREENHOUSE_APPLICATION: 'applications',
  COMPLETE_LEVER_APPLICATION: 'applications',
  EXECUTE_AUTHORIZED_SUBMISSION: 'applications',
  VERIFY_SUBMISSION_CONFIRMATION: 'applications',
  RESUME_APPLICATION_AFTER_VERIFICATION: 'applications',
  // Notifications
  EMAIL_OUTCOME: 'notifications',
  SYNC_EMAIL_CONNECTION: 'notifications',
};

/** Routes whose job types are operational rather than candidate-facing. */
export const MAINTENANCE_JOB_TYPES: readonly string[] = [
  'LEASE_RECONCILIATION',
  'OUTBOX_SWEEP',
  'RETENTION_SWEEP',
];

/**
 * An unrecognized type is quarantined on `maintenance` rather than guessed at: no
 * candidate-facing handler runs there, so an unknown type is inert instead of being
 * executed on the wrong queue.
 */
export function queueForJobType(type: string): QueueName {
  const normalized = type.trim().toUpperCase();
  return JOB_TYPE_QUEUE_ROUTES[normalized] ?? 'maintenance';
}

/** Exposed so tests can assert the table covers every registered automation job handler. */
export function routedJobTypes(): readonly string[] {
  return Object.keys(JOB_TYPE_QUEUE_ROUTES);
}

export function deadLetterQueueName(name: QueueName): string {
  return `${name}.dead-letter`;
}

export function bullPriority(priority: number): number {
  const bounded = Math.max(-1_000_000, Math.min(1_000_000, priority));
  return 1_000_001 - bounded;
}
