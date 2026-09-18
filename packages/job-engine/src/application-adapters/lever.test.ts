import { describe, expect, it, vi } from 'vitest';
import { leverApplicationHost, LeverApplicationAdapter, type LeverFormPort } from './lever';

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
  it('accepts only HTTPS Lever application hosts', () => {
    expect(leverApplicationHost('https://jobs.lever.co/acme/apply')).toBe('jobs.lever.co');
    expect(leverApplicationHost('https://attacker.lever.co/acme/apply')).toBeNull();
    expect(leverApplicationHost('http://jobs.lever.co/acme/apply')).toBeNull();
    expect(leverApplicationHost('https://user:secret@jobs.lever.co/acme/apply')).toBeNull();
    expect(leverApplicationHost('https://jobs.lever.co:8443/acme/apply')).toBeNull();
    expect(leverApplicationHost('https://boards.greenhouse.io/acme/apply')).toBeNull();
  });
  it('fills only approved profile fields and advances an error-free step', async () => {
    const form = port({
      provider: 'LEVER', step: 1, stepIdentity: 'lever-step-1',
      hasNextStep: true,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    });

    await expect(new LeverApplicationAdapter().fillCurrentStep(form, { email: 'ada@example.invalid' }, [], 'fixture-owner'))
      .resolves.toMatchObject({ filledFieldIds: ['email'], advanced: true });
    expect(form.fill).toHaveBeenCalledWith('email', 'ada@example.invalid');
    expect(form.advance).toHaveBeenCalledOnce();
  });

  it('fails closed when a Lever adapter receives a cross-provider snapshot', async () => {
    const form = port({
      provider: 'GREENHOUSE', step: 1, stepIdentity: 'greenhouse-step-1', hasNextStep: true,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    });
    const result = await new LeverApplicationAdapter().fillCurrentStep(form, { email: 'ada@example.invalid' });
    expect(result.fields).toEqual([]);
    expect(result.advanced).toBe(false);
    expect(form.fill).not.toHaveBeenCalled();
    expect(form.advance).not.toHaveBeenCalled();
  });

  it('halts instead of answering verification, uploads, or eligibility questions', async () => {
    const form = port({
      provider: 'LEVER', step: 1, stepIdentity: 'lever-step-1',
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

  it('keeps named ARIA combobox controls in the provider-neutral snapshot contract', async () => {
    const form = port({
      provider: 'LEVER', step: 1, stepIdentity: 'lever-step-1', hasNextStep: false,
      fields: [{ id: 'location', name: 'location', label: 'Location', kind: 'COMBOBOX', required: true, options: ['Remote'] }],
    });
    const result = await new LeverApplicationAdapter().fillCurrentStep(form, {});
    expect(result.fields).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'location', kind: 'COMBOBOX' })]));
    expect(result.requiredBlockingFieldIds).toContain('location');
  });
});
