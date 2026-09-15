import { describe, expect, it } from 'vitest';
import { deriveAutomationAlerts } from './automation';

describe('automation operational alerts', () => {
  it('derives bounded actionable alerts from persisted and queue metrics', () => {
    const alerts = deriveAutomationAlerts({
      queueMetrics: [{ waiting: 120, oldestWaitingMs: 16 * 60 * 1_000, failed: 2 }],
      retryMetrics: { jobsWithRetries: 10 },
      browserSessions: [{ status: 'ACTIVE', _count: { _all: 10 } }],
      pendingVerification: { pendingCount: 1, oldestAgeMs: 24 * 60 * 60 * 1_000 },
    });
    expect(alerts.map(alert => alert.code)).toEqual([
      'QUEUE_BACKLOG', 'QUEUE_FAILURES', 'JOB_RETRIES', 'HUMAN_VERIFICATION_AGING', 'BROWSER_SESSIONS_ACTIVE',
    ]);
    expect(alerts.find(alert => alert.code === 'QUEUE_FAILURES')).toMatchObject({ severity: 'CRITICAL', value: 2 });
  });

  it('does not emit alerts for healthy or unavailable queue metrics', () => {
    expect(deriveAutomationAlerts({
      queueMetrics: null,
      retryMetrics: { jobsWithRetries: 0 },
      browserSessions: [],
      pendingVerification: { pendingCount: 0, oldestAgeMs: 0 },
    })).toEqual([]);
  });
});
