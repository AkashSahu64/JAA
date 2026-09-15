import { describe, expect, it } from 'vitest';
import { summarizeExecutionDurations, summarizePendingVerificationAges } from './automation';

describe('automation observability summaries', () => {
  it('summarizes bounded pending human-verification age', () => {
    const now = new Date('2026-09-15T00:00:00.000Z');
    expect(summarizePendingVerificationAges([
      { createdAt: new Date('2026-09-14T23:00:00.000Z') },
      { createdAt: new Date('2026-09-14T22:00:00.000Z') },
      { createdAt: new Date('invalid') },
      { createdAt: new Date('2026-09-15T01:00:00.000Z') },
    ], now)).toEqual({ pendingCount: 2, oldestAgeMs: 7_200_000, averageAgeMs: 5_400_000, maxAgeMs: 7_200_000 });
  });

  it('returns an empty summary for an invalid clock', () => {
    expect(summarizePendingVerificationAges([{ createdAt: new Date() }], new Date('invalid'))).toEqual({ pendingCount: 0, oldestAgeMs: 0, averageAgeMs: 0, maxAgeMs: 0 });
  });

  it('summarizes only completed, non-negative execution windows', () => {
    const start = new Date('2026-09-14T00:00:00Z');
    expect(summarizeExecutionDurations([
      { startedAt: start, completedAt: new Date(start.getTime() + 100) },
      { startedAt: new Date(start.getTime() + 200), completedAt: null },
      { startedAt: new Date('invalid'), completedAt: new Date(start.getTime() + 300) },
      { startedAt: new Date(start.getTime() + 500), completedAt: new Date(start.getTime() + 400) },
    ])).toEqual({ sampleCount: 1, averageMs: 100, maxMs: 100 });
  });

  it('returns zero metrics for empty input', () => {
    expect(summarizeExecutionDurations([])).toEqual({ sampleCount: 0, averageMs: 0, maxMs: 0 });
  });
});
