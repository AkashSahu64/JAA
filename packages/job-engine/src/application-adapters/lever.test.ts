import { describe, expect, it, vi } from 'vitest';
import { LeverApplicationAdapter, type LeverFormPort } from './lever';

function port(snapshot: Awaited<ReturnType<LeverFormPort['snapshot']>>) {
  return {
    snapshot: vi.fn(async () => snapshot),
    fill: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    setChecked: vi.fn(async () => undefined),
    validate: vi.fn(async () => []),
    advance: vi.fn(async () => undefined),
  } satisfies LeverFormPort;
}

describe('LeverApplicationAdapter', () => {
  it('fills only approved profile fields and advances an error-free step', async () => {
    const form = port({
      step: 1,
      hasNextStep: true,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    });

    await expect(new LeverApplicationAdapter().fillCurrentStep(form, { email: 'ada@example.invalid' }))
      .resolves.toMatchObject({ filledFieldIds: ['email'], advanced: true });
    expect(form.fill).toHaveBeenCalledWith('email', 'ada@example.invalid');
    expect(form.advance).toHaveBeenCalledOnce();
  });

  it('halts instead of answering verification, uploads, or eligibility questions', async () => {
    const form = port({
      step: 1,
      hasNextStep: true,
      fields: [
        { id: 'captcha', name: 'captcha', label: 'Security check', kind: 'TEXT', required: true },
        { id: 'resume', name: 'resume', label: 'Resume', kind: 'FILE', required: true },
        { id: 'visa', name: 'work_authorization', label: 'Authorized to work?', kind: 'SELECT', required: true },
      ],
    });

    const result = await new LeverApplicationAdapter().fillCurrentStep(form, {});
    expect(result.advanced).toBe(false);
    expect(result.assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: 'captcha', disposition: 'HUMAN_VERIFICATION_REQUIRED' }),
      expect.objectContaining({ fieldId: 'resume', disposition: 'UNSUPPORTED' }),
      expect.objectContaining({ fieldId: 'visa', disposition: 'HIGH_RISK' }),
    ]));
    expect(form.fill).not.toHaveBeenCalled();
  });
});
