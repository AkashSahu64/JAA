import { describe, expect, it, vi } from 'vitest';
import { greenhouseApplicationHost, GreenhouseApplicationAdapter, type GreenhouseFormPort } from './greenhouse';

function port(snapshot: Awaited<ReturnType<GreenhouseFormPort['snapshot']>>) {
  return {
    snapshot: vi.fn(async () => snapshot),
    fill: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    setChecked: vi.fn(async () => undefined),
    validate: vi.fn(async () => []),
    advance: vi.fn(async () => undefined),
  } satisfies GreenhouseFormPort;
}

describe('GreenhouseApplicationAdapter', () => {
  it('accepts only HTTPS Greenhouse application hosts', () => {
    expect(greenhouseApplicationHost('https://boards.greenhouse.io/acme/apply')).toBe('boards.greenhouse.io');
    expect(greenhouseApplicationHost('https://attacker.greenhouse.io/acme/apply')).toBeNull();
    expect(greenhouseApplicationHost('http://boards.greenhouse.io/acme/apply')).toBeNull();
    expect(greenhouseApplicationHost('https://user:secret@boards.greenhouse.io/acme/apply')).toBeNull();
    expect(greenhouseApplicationHost('https://boards.greenhouse.io:8443/acme/apply')).toBeNull();
    expect(greenhouseApplicationHost('https://example.invalid/apply')).toBeNull();
  });
  it('fills only mapped approved profile data and advances a valid basic step', async () => {
    const form = port({
      provider: 'GREENHOUSE', step: 1, stepIdentity: 'greenhouse-step-1',
      hasNextStep: true,
      fields: [
        { id: 'first', name: 'first_name', label: 'First name', kind: 'TEXT', required: true },
        { id: 'last', name: 'last_name', label: 'Last name', kind: 'TEXT', required: true },
        { id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true },
      ],
    });
    const result = await new GreenhouseApplicationAdapter().fillCurrentStep(form, {
      firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.invalid',
    }, [], 'fixture-owner');

    expect(form.fill).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ filledFieldIds: ['first', 'last', 'email'], advanced: true });
    expect(form.advance).toHaveBeenCalledOnce();
  });

  it('fails closed when a Greenhouse adapter receives a cross-provider snapshot', async () => {
    const form = port({
      provider: 'LEVER', step: 1, stepIdentity: 'lever-step-1', hasNextStep: true,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    });
    const result = await new GreenhouseApplicationAdapter().fillCurrentStep(form, { email: 'ada@example.invalid' });
    expect(result.fields).toEqual([]);
    expect(result.advanced).toBe(false);
    expect(form.fill).not.toHaveBeenCalled();
    expect(form.advance).not.toHaveBeenCalled();
  });

  it('halts for custom required answers, uploads, and verification without fabricating data', async () => {
    const form = port({
      step: 2,
      hasNextStep: true,
      fields: [
        { id: 'eligibility', name: 'work_authorization', label: 'Are you authorized to work?', kind: 'SELECT', required: true },
        { id: 'resume', name: 'resume', label: 'Resume', kind: 'FILE', required: true },
        { id: 'captcha', name: 'g-recaptcha-response', label: 'Security check', kind: 'TEXT', required: true },
      ],
    });
    const result = await new GreenhouseApplicationAdapter().fillCurrentStep(form, {});

    expect(result.assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: 'eligibility', disposition: 'HIGH_RISK' }),
      expect.objectContaining({ fieldId: 'resume', disposition: 'UNSUPPORTED' }),
      expect.objectContaining({ fieldId: 'captcha', disposition: 'HUMAN_VERIFICATION_REQUIRED', verification: 'CAPTCHA' }),
    ]));
    expect(result.advanced).toBe(false);
    expect(form.fill).not.toHaveBeenCalled();
    expect(form.advance).not.toHaveBeenCalled();
  });

  it('does not advance when an approved required profile field has no usable value', async () => {
    const form = port({
      provider: 'GREENHOUSE', step: 1, stepIdentity: 'greenhouse-step-1',
      hasNextStep: true,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    });

    const result = await new GreenhouseApplicationAdapter().fillCurrentStep(form, {});

    expect(result).toMatchObject({ requiredBlockingFieldIds: ['email'], advanced: false });
    expect(form.fill).not.toHaveBeenCalled();
    expect(form.advance).not.toHaveBeenCalled();
  });

  it('does not advance when browser validation reports errors', async () => {
    const form = port({
      provider: 'GREENHOUSE', step: 1, stepIdentity: 'greenhouse-step-1',
      hasNextStep: true,
      fields: [{ id: 'email', name: 'email', label: 'Email', kind: 'TEXT', required: true }],
    });
    (form.validate as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ fieldId: 'email', message: 'Invalid email' }]);

    const result = await new GreenhouseApplicationAdapter().fillCurrentStep(form, { email: 'ada@example.invalid' });
    expect(result).toMatchObject({ advanced: false, validationErrors: [{ fieldId: 'email' }] });
    expect(form.advance).not.toHaveBeenCalled();
  });

  it('uses autocomplete for opaque fields but leaves unmatched required selects for review', async () => {
    const form = port({
      step: 2,
      hasNextStep: true,
      fields: [
        { id: 'opaque_email', name: 'question_1', label: 'Contact', autocomplete: 'email', kind: 'TEXT', required: true },
        { id: 'location', name: 'location', label: 'Location', kind: 'SELECT', required: true, options: ['Remote'] },
      ],
    });

    const result = await new GreenhouseApplicationAdapter().fillCurrentStep(form, {
      email: 'ada@example.invalid', location: 'London',
    }, [], 'fixture-owner');

    expect(form.fill).toHaveBeenCalledWith('opaque_email', 'ada@example.invalid');
    expect(form.select).not.toHaveBeenCalled();
    expect(result).toMatchObject({ filledFieldIds: ['opaque_email'], requiredBlockingFieldIds: ['location'], advanced: false });
  });
});
