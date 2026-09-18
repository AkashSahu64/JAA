import { describe, expect, it } from 'vitest';
import { queueForJobType, routedJobTypes } from '@jobagent/queue';
import { createProductionAutomationJobHandlers } from './automation-job-handlers';

/**
 * The queue routing table and the worker's handler map are two halves of one contract, and
 * they live in different packages. When they drift, a job type is durably enqueued but no
 * worker ever runs it — the failure is silent, because the row simply stays AVAILABLE.
 *
 * This is not hypothetical: prefix-based routing previously sent
 * EXECUTE_AUTHORIZED_SUBMISSION, EVALUATE_ATS, EVALUATE_APPLICATION_QUALITY and both
 * COMPLETE_*_APPLICATION types to the maintenance queue, where nothing consumes them.
 */
describe('automation job routing covers every registered handler', () => {
  it('routes every dispatchable job type away from the maintenance quarantine queue', () => {
    const handlerTypes = [...createProductionAutomationJobHandlers().keys()];

    expect(handlerTypes.length).toBeGreaterThan(0);
    for (const type of handlerTypes) {
      expect(queueForJobType(type), `${type} has a handler but no queue route`).not.toBe('maintenance');
    }
  });

  it('declares a route for exactly the job types that have handlers', () => {
    const handlerTypes = [...createProductionAutomationJobHandlers().keys()].sort();
    expect([...routedJobTypes()].sort()).toEqual(handlerTypes);
  });
});
