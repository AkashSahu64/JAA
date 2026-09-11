export const QUEUE_NAMES = [
  'discovery',
  'analysis',
  'documents',
  'applications',
  'notifications',
  'maintenance',
] as const;

export type QueueName = typeof QUEUE_NAMES[number];

const routes: ReadonlyArray<[QueueName, readonly string[]]> = [
  ['discovery', ['DISCOVER', 'SEARCH', 'SOURCE', 'NORMALIZE', 'DEDUPE']],
  ['analysis', ['ANALYZE', 'ANALYSIS', 'MATCH', 'QUALIFY', 'TAILOR', 'ATS']],
  ['documents', ['DOCUMENT', 'RESUME', 'COVER_LETTER', 'UPLOAD']],
  ['applications', ['APPLICATION', 'APPLY', 'BROWSER', 'FORM', 'SUBMIT', 'VERIFY']],
  ['notifications', ['NOTIFY', 'NOTIFICATION', 'EMAIL', 'OUTCOME']],
];

export function queueForJobType(type: string): QueueName {
  const normalized = type.trim().toUpperCase();
  return routes.find(([, prefixes]) => prefixes.some((prefix) => normalized.startsWith(prefix)))?.[0] ?? 'maintenance';
}

export function deadLetterQueueName(name: QueueName): string {
  return `${name}.dead-letter`;
}

export function bullPriority(priority: number): number {
  const bounded = Math.max(-1_000_000, Math.min(1_000_000, priority));
  return 1_000_001 - bounded;
}
