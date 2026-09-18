import { withTenant } from '@jobagent/database';
import type { AutomationOperationalAlert } from '../routes/automation';

const ALERT_WINDOW_MS = 5 * 60 * 1_000;

export async function persistAutomationAlerts(
  userId: string,
  alerts: readonly AutomationOperationalAlert[],
  correlationId: string,
  now = new Date(),
): Promise<void> {
  if (!alerts.length) return;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Alert timestamp is invalid');
  await withTenant(userId, async tx => {
    for (const alert of alerts) {
      const window = Math.floor(now.getTime() / ALERT_WINDOW_MS);
      await tx.outboxEvent.upsert({
        where: { idempotencyKey: `automation-alert:${userId}:${alert.code}:${window}` },
        create: {
          userId,
          aggregateType: 'AutomationOperations',
          aggregateId: userId,
          eventType: 'automation.alert',
          payload: { code: alert.code, severity: alert.severity, message: alert.message, value: alert.value, threshold: alert.threshold },
          schemaVersion: 1,
          correlationId,
          idempotencyKey: `automation-alert:${userId}:${alert.code}:${window}`,
          occurredAt: now,
          availableAt: now,
        },
        update: {},
      });
    }
  });
}
