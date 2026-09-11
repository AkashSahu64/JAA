import { describe, expect, it } from 'vitest';
import { assessApplicationForm, assessApplicationFormField } from './form-intelligence';

describe('application form intelligence', () => {
  it('maps only low-risk profile fields', () => {
    expect(assessApplicationFormField({
      id: 'email', name: 'email', label: 'Email address', kind: 'TEXT', required: true,
    })).toEqual(expect.objectContaining({
      disposition: 'PROFILE_DERIVED', profileKey: 'email',
    }));
  });

  it.each([
    ['sex_at_birth', 'Sex at birth', 'SENSITIVE'],
    ['age_range', 'Age range', 'SENSITIVE'],
    ['disability_status', 'Disability status', 'SENSITIVE'],
    ['work_authorization', 'Are you authorized to work?', 'HIGH_RISK'],
    ['race', 'Race or ethnicity', 'SENSITIVE'],
    ['resume', 'Resume', 'UNSUPPORTED'],
    ['custom_question', 'Why do you want this role?', 'AMBIGUOUS'],
  ] as const)('fails closed for %s', (name, label, disposition) => {
    expect(assessApplicationFormField({
      id: name, name, label, kind: name === 'resume' ? 'FILE' : 'TEXT', required: true,
    })).toMatchObject({ disposition });
  });

  it('requires a human for anti-bot and authentication controls', () => {
    expect(assessApplicationForm([
      { id: 'captcha', name: 'g-recaptcha-response', label: 'Security check', kind: 'TEXT', required: true },
      { id: 'password', name: 'password', label: 'Sign in password', kind: 'TEXT', required: true },
    ])).toEqual([
      expect.objectContaining({ disposition: 'HUMAN_VERIFICATION_REQUIRED', verification: 'CAPTCHA' }),
      expect.objectContaining({ disposition: 'HUMAN_VERIFICATION_REQUIRED', verification: 'AUTH' }),
    ]);
  });

  it('maps opaque controls only through browser-standard autocomplete semantics', () => {
    expect(assessApplicationFormField({
      id: 'field_7b90', name: 'field_7b90', label: 'Candidate contact', autocomplete: 'email', kind: 'TEXT', required: true,
    })).toMatchObject({ disposition: 'PROFILE_DERIVED', profileKey: 'email' });
    expect(assessApplicationFormField({
      id: 'field_7b91', name: 'field_7b91', label: 'Candidate contact', kind: 'TEXT', required: true,
    })).toMatchObject({ disposition: 'AMBIGUOUS' });
  });

  it.each([
    ['email', 'salary expectation', 'email'],
    ['email', 'work authorization', 'email'],
    ['field', 'Verification code', 'one-time-code'],
  ])('does not let semantic metadata override a high-risk or verification field', (name, label, autocomplete) => {
    expect(assessApplicationFormField({
      id: name, name, label, autocomplete, kind: 'TEXT', required: true,
    })).not.toMatchObject({ disposition: 'PROFILE_DERIVED' });
  });

  it('does not trust autocomplete metadata on a narrative question', () => {
    expect(assessApplicationFormField({
      id: 'question_9', name: 'question_9', label: 'Why do you want this role?', autocomplete: 'email', kind: 'TEXTAREA', required: true,
    })).toMatchObject({ disposition: 'AMBIGUOUS' });
  });

  it('keeps optional custom questions visible for review instead of treating them as safe', () => {
    expect(assessApplicationFormField({
      id: 'motivation', name: 'motivation', label: 'Why this role?', kind: 'TEXTAREA', required: false,
    })).toMatchObject({ disposition: 'AMBIGUOUS' });
  });

  it('does not classify a hidden or disabled known profile control as answerable', () => {
    expect(assessApplicationFormField({
      id: 'email', name: 'email', label: 'Email', kind: 'HIDDEN', required: true,
    })).toMatchObject({ disposition: 'UNSUPPORTED' });
    expect(assessApplicationFormField({
      id: 'email_disabled', name: 'email', label: 'Email', kind: 'TEXT', required: true, enabled: false,
    })).toMatchObject({ disposition: 'UNSUPPORTED' });
  });
});
