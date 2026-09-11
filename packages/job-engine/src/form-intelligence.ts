import { classifyHumanVerification, type HumanVerificationKind } from '@jobagent/security';

export type ApplicationFormFieldKind = 'TEXT' | 'TEXTAREA' | 'SELECT' | 'CHECKBOX' | 'FILE' | 'HIDDEN';
export type ApplicationFormProfileKey = 'firstName' | 'lastName' | 'email' | 'phone' | 'location' | 'linkedinUrl' | 'websiteUrl';

export interface ApplicationFormField {
  id: string;
  name: string;
  label: string;
  kind: ApplicationFormFieldKind;
  required: boolean;
  options?: readonly string[];
  /** Browser-standard autofill semantic, used only as a narrow fallback for opaque IDs. */
  autocomplete?: string;
  /** Whether the provider currently permits interaction with the control. */
  enabled?: boolean;
  verification?: HumanVerificationKind;
}

export type ApplicationFormDisposition =
  | 'SAFE'
  | 'PROFILE_DERIVED'
  | 'AMBIGUOUS'
  | 'SENSITIVE'
  | 'HIGH_RISK'
  | 'UNSUPPORTED'
  | 'HUMAN_VERIFICATION_REQUIRED';

export interface ApplicationFormAssessment {
  fieldId: string;
  disposition: ApplicationFormDisposition;
  profileKey?: ApplicationFormProfileKey;
  verification?: HumanVerificationKind;
  reason: string;
}

const profileFields: Readonly<Record<string, ApplicationFormProfileKey>> = {
  first_name: 'firstName',
  firstname: 'firstName',
  given_name: 'firstName',
  first: 'firstName',
  last_name: 'lastName',
  lastname: 'lastName',
  family_name: 'lastName',
  last: 'lastName',
  email: 'email',
  email_address: 'email',
  emailaddress: 'email',
  phone: 'phone',
  phone_number: 'phone',
  mobile: 'phone',
  mobile_phone: 'phone',
  telephone: 'phone',
  tel: 'phone',
  location: 'location',
  city: 'location',
  current_location: 'location',
  linkedin: 'linkedinUrl',
  linkedin_url: 'linkedinUrl',
  linkedin_profile: 'linkedinUrl',
  website: 'websiteUrl',
  website_url: 'websiteUrl',
  personal_website: 'websiteUrl',
  portfolio: 'websiteUrl',
};

const sensitivePatterns = [
  /race|ethnic|gender|sex(?:_|$)|pronoun|disab|veteran|religion|date_of_birth|birthdate|age(?:_|$)|ssn|social_security/,
];
const highRiskPatterns = [
  /work_authori|authorized_to_work|visa|sponsor|citizen|salary|compensation|pay_expect|criminal|conviction|background|security_clearance|signature|certif|agree|consent|terms|legal_acknowledg/,
];
const customAnswerPatterns = [
  /why|describe|explain|cover_letter|motivation|additional_information|anything_else|comments|message/,
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function fingerprint(field: ApplicationFormField): string {
  return `${normalize(field.name)}_${normalize(field.label)}`;
}

function profileKeyFor(field: ApplicationFormField): ApplicationFormProfileKey | undefined {
  return profileFields[normalize(field.name)]
    ?? profileFields[normalize(field.label)]
    ?? profileFields[normalize(field.autocomplete ?? '')];
}

function verificationFor(field: ApplicationFormField): HumanVerificationKind | undefined {
  if (field.verification) return field.verification;
  const value = fingerprint(field);
  return classifyHumanVerification({
    captcha: /captcha|recaptcha|hcaptcha/.test(value),
    mfa: /mfa|one_time|verification_code|authenticator/.test(value),
    antiBot: /anti_bot|bot_check|challenge/.test(value),
    authentication: /sign_in|login|password/.test(value),
  })?.kind;
}

export function assessApplicationFormField(field: ApplicationFormField): ApplicationFormAssessment {
  const verification = verificationFor(field);
  if (verification) return {
    fieldId: field.id,
    disposition: 'HUMAN_VERIFICATION_REQUIRED',
    verification,
    reason: `${verification} requires a human acknowledgement`,
  };
  if (field.kind === 'HIDDEN') return {
    fieldId: field.id,
    disposition: 'UNSUPPORTED',
    reason: 'Hidden controls are not application-answer fields',
  };
  if (field.enabled === false) return {
    fieldId: field.id,
    disposition: 'UNSUPPORTED',
    reason: 'Disabled controls cannot be safely completed',
  };
  if (field.kind === 'FILE') return {
    fieldId: field.id,
    disposition: 'UNSUPPORTED',
    reason: 'Document upload requires the document evidence system',
  };
  const value = fingerprint(field);
  if (sensitivePatterns.some(pattern => pattern.test(value))) return {
    fieldId: field.id,
    disposition: 'SENSITIVE',
    reason: 'Sensitive personal information requires explicit user handling',
  };
  if (highRiskPatterns.some(pattern => pattern.test(value))) return {
    fieldId: field.id,
    disposition: 'HIGH_RISK',
    reason: 'High-risk legal, eligibility, or compensation answer requires review',
  };
  if (customAnswerPatterns.some(pattern => pattern.test(value))) return {
    fieldId: field.id,
    disposition: 'AMBIGUOUS',
    reason: 'Custom narrative application question is not automatically answered',
  };
  const profileKey = profileKeyFor(field);
  if (profileKey) return {
    fieldId: field.id,
    disposition: 'PROFILE_DERIVED',
    profileKey,
    reason: 'Mapped to an approved profile field',
  };
  if (!field.required && field.kind === 'CHECKBOX') return {
    fieldId: field.id,
    disposition: 'SAFE',
    reason: 'Optional unchecked control is left unchanged',
  };
  return {
    fieldId: field.id,
    disposition: 'AMBIGUOUS',
    reason: 'Custom application question is not automatically answered',
  };
}

export function assessApplicationForm(fields: readonly ApplicationFormField[]): ApplicationFormAssessment[] {
  return fields.map(assessApplicationFormField);
}
