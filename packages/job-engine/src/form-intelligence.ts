import { classifyHumanVerification, type HumanVerificationKind } from '@jobagent/security';

export type ApplicationFormFieldKind = 'TEXT' | 'TEXTAREA' | 'SELECT' | 'RADIO' | 'CHECKBOX' | 'FILE' | 'COMBOBOX' | 'MULTISELECT' | 'HIDDEN';
export type ApplicationFormCapability = 'FILL_TEXT' | 'SELECT_OPTION' | 'SET_CHECKED' | 'UPLOAD_DOCUMENT' | 'REVIEW_ONLY';
export type ApplicationFormProfileKey = 'firstName' | 'lastName' | 'email' | 'phone' | 'location' | 'linkedinUrl' | 'websiteUrl';
export type ApplicationFormProvider = 'GREENHOUSE' | 'LEVER' | 'UNKNOWN';

export interface ApplicationFormField {
  /** Provider DOM control key, used only to interact with the current page. */
  id: string;
  /** Stable semantic key persisted as the application-question identity. */
  identity?: string;
  /** Compatibility alias used by durable question/answer evidence consumers. */
  questionIdentity?: string;
  name: string;
  label: string;
  /** Computed accessible name from ARIA/native semantics when a visible label is absent. */
  accessibleName?: string;
  kind: ApplicationFormFieldKind;
  capability?: ApplicationFormCapability;
  /** Native input type or provider-neutral semantic hint (for example date or tel). */
  inputType?: string;
  required: boolean;
  options?: readonly string[];
  /** Value already present in the control before this fill pass. */
  currentValue?: string | readonly string[] | boolean;
  autocomplete?: string;
  enabled?: boolean;
  visible?: boolean;
  /** Provider-extracted semantic key, never a DOM index. */
  semanticKey?: string;
  /** Stable occurrence key for repeated controls such as two phone fields. */
  occurrenceKey?: string;
  validationErrors?: readonly string[];
  verification?: HumanVerificationKind;
}

export interface ApplicationFormSnapshot {
  provider?: ApplicationFormProvider;
  step: number;
  stepIdentity?: string;
  fields: readonly ApplicationFormField[];
  hasNextStep: boolean;
  validationErrors?: readonly { fieldId?: string; message: string }[];
}

export interface ApplicationFormPort<TSnapshot extends ApplicationFormSnapshot = ApplicationFormSnapshot> {
  snapshot(): Promise<TSnapshot>;
  fill(fieldId: string, value: string): Promise<void>;
  select(fieldId: string, value: string | readonly string[]): Promise<void>;
  setChecked(fieldId: string, checked: boolean): Promise<void>;
  uploadDocument?(fieldId: string, document: { fileName: string; mimeType: string; checksumSha256: string; bytes: Uint8Array }): Promise<void>;
  validate(): Promise<readonly { fieldId?: string; message: string }[]>;
  advance(): Promise<void>;
}

export interface FormDetector<TPort extends ApplicationFormPort = ApplicationFormPort> {
  detect(port: TPort): Promise<ApplicationFormSnapshot>;
}
export interface FieldExtractor { extract(snapshot: ApplicationFormSnapshot): readonly ApplicationFormField[]; }
export interface FieldMapper { map(fields: readonly ApplicationFormField[]): ApplicationFormAssessment[]; }

export interface ApprovedApplicationAnswer {
  answerId: string;
  questionIdentity: string;
  ownerId: string;
  value: string | readonly string[] | boolean;
  source: 'USER_PROFILE' | 'USER_INPUT' | 'COVER_LETTER' | 'AI_SUGGESTION';
  approved: boolean;
  approvedAt?: Date;
  /** Explicit owner approval actor; AI output alone can never satisfy this. */
  approvedBy?: string;
  provenance?: Readonly<Record<string, unknown>>;
  version: number;
}

export interface AnswerResolver {
  resolve(input: {
    field: ApplicationFormField;
    assessment: ApplicationFormAssessment;
    ownerId?: string;
    profile?: Readonly<Partial<Record<ApplicationFormProfileKey, string>>>;
    approvedAnswers?: readonly ApprovedApplicationAnswer[];
  }): string | readonly string[] | boolean | undefined;
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
  questionIdentity?: string;
  disposition: ApplicationFormDisposition;
  profileKey?: ApplicationFormProfileKey;
  verification?: HumanVerificationKind;
  capability: ApplicationFormCapability;
  reason: string;
}

const profileFields: Readonly<Record<string, ApplicationFormProfileKey>> = {
  first_name: 'firstName', firstname: 'firstName', given_name: 'firstName', first: 'firstName',
  last_name: 'lastName', lastname: 'lastName', family_name: 'lastName', last: 'lastName',
  email: 'email', email_address: 'email', emailaddress: 'email',
  phone: 'phone', phone_number: 'phone', mobile: 'phone', mobile_phone: 'phone', telephone: 'phone', tel: 'phone',
  location: 'location', city: 'location', current_location: 'location',
  linkedin: 'linkedinUrl', linkedin_url: 'linkedinUrl', linkedin_profile: 'linkedinUrl',
  website: 'websiteUrl', website_url: 'websiteUrl', personal_website: 'websiteUrl', portfolio: 'websiteUrl',
};
const sensitivePatterns = [/race|ethnic|gender|sex(?:_|$)|pronoun|disab|veteran|religion|date_of_birth|birthdate|age(?:_|$)|ssn|social_security/];
const highRiskPatterns = [/work_authori|authorized_to_work|visa|sponsor|citizen|salary|compensation|pay_expect|criminal|conviction|background|security_clearance|signature|certif|agree|consent|terms|legal_acknowledg/];
const customAnswerPatterns = [/why|describe|explain|cover_letter|motivation|additional_information|anything_else|comments|message/];
const hostileInstructionPatterns = [/ignore_(?:safety|policy|instructions?)/, /reveal_(?:your_)?(?:password|credential|secret)/, /bypass_(?:captcha|mfa|authentication|security)/, /(?:fabricate|invent)_/, /upload_(?:an_)?unauthorized/];
const MAX_VALIDATION_MESSAGE_LENGTH = 1_000;
const MAX_STEP_IDENTITY_LENGTH = 200;
const MAX_FORM_FIELDS = 500;
const MAX_VALIDATION_ERRORS = 200;
const MAX_FIELD_IDENTITY_LENGTH = 512;
const MAX_ANSWER_TEXT_LENGTH = 20_000;
const MAX_ANSWER_OPTIONS = 100;
const MAX_ANSWER_OPTION_LENGTH = 500;
const SAFE_FIELD_IDENTITY = /^[A-Za-z0-9._:-]{1,512}$/;
const FORM_FIELD_KINDS: readonly ApplicationFormFieldKind[] = ['TEXT', 'TEXTAREA', 'SELECT', 'RADIO', 'CHECKBOX', 'FILE', 'COMBOBOX', 'MULTISELECT', 'HIDDEN'];

function isKnownFieldKind(value: unknown): value is ApplicationFormFieldKind {
  return typeof value === 'string' && (FORM_FIELD_KINDS as readonly string[]).includes(value);
}

function trustedFieldIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_FIELD_IDENTITY_LENGTH && SAFE_FIELD_IDENTITY.test(value);
}

function isSafeControlId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= MAX_FIELD_IDENTITY_LENGTH
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function safeValidationMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const message = value.trim();
  return message ? (message.length > MAX_VALIDATION_MESSAGE_LENGTH ? `${message.slice(0, MAX_VALIDATION_MESSAGE_LENGTH)}…` : message) : undefined;
}

function safeValidationErrors(value: unknown): Array<{ fieldId?: string; message: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_VALIDATION_ERRORS).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const message = safeValidationMessage(record.message);
    if (!message) return [];
    const fieldId = typeof record.fieldId === 'string' && record.fieldId.trim() ? record.fieldId : undefined;
    return [{ ...(fieldId ? { fieldId } : {}), message }];
  });
}

function isApplicationFormField(value: unknown): value is ApplicationFormField {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const field = value as Record<string, unknown>;
  return isSafeControlId(field.id) && typeof field.name === 'string' && typeof field.label === 'string'
    && typeof field.kind === 'string' && typeof field.required === 'boolean';
}

export function normalizeApplicationFormSnapshot(value: unknown): ApplicationFormSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { provider: 'UNKNOWN', step: 0, fields: [], hasNextStep: false };
  }
  const snapshot = value as Record<string, unknown>;
  const provider = snapshot.provider === 'GREENHOUSE' || snapshot.provider === 'LEVER'
    ? snapshot.provider : 'UNKNOWN';
  const step = typeof snapshot.step === 'number' && Number.isSafeInteger(snapshot.step) && snapshot.step >= 0
    ? snapshot.step : 0;
  return {
    provider,
    step,
    fields: Array.isArray(snapshot.fields) ? snapshot.fields.slice(0, MAX_FORM_FIELDS) as ApplicationFormField[] : [],
    hasNextStep: snapshot.hasNextStep === true,
    ...(typeof snapshot.stepIdentity === 'string' && snapshot.stepIdentity.trim()
      && snapshot.stepIdentity.length <= MAX_STEP_IDENTITY_LENGTH
      ? { stepIdentity: snapshot.stepIdentity.trim() } : {}),
    ...(Array.isArray(snapshot.validationErrors)
      ? { validationErrors: snapshot.validationErrors as ApplicationFormSnapshot['validationErrors'] } : {}),
  };
}

export function normalizeApplicationFormText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function boundedIdentityPart(value: unknown, maxLength = 256): string {
  if (typeof value !== 'string') return '';
  return normalizeApplicationFormText(value).slice(0, maxLength);
}

function isApprovedAnswerValue(value: unknown): value is string | readonly string[] | boolean {
  return (typeof value === 'string' && value.length <= MAX_ANSWER_TEXT_LENGTH)
    || typeof value === 'boolean'
    || (Array.isArray(value) && value.length <= MAX_ANSWER_OPTIONS
      && value.every(item => typeof item === 'string' && item.length <= MAX_ANSWER_OPTION_LENGTH));
}

function isBoundedAnswerProvenance(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32) return false;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.length <= 8_192;
  } catch {
    return false;
  }
}

function isTrustedApprovedAnswer(candidate: unknown, ownerId: string, questionIdentity: string): candidate is ApprovedApplicationAnswer {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const answer = candidate as Partial<ApprovedApplicationAnswer>;
  const provenance = answer.provenance;
  const provenanceSource = provenance && typeof provenance === 'object' && !Array.isArray(provenance)
    ? (provenance as Record<string, unknown>).source : undefined;
  return typeof answer.answerId === 'string' && Boolean(answer.answerId.trim())
    && typeof answer.version === 'number' && Number.isSafeInteger(answer.version) && answer.version > 0
    && answer.ownerId === ownerId && answer.questionIdentity === questionIdentity
    && answer.approved === true && answer.approvedAt instanceof Date && Number.isFinite(answer.approvedAt.getTime())
    && answer.approvedBy === ownerId && isApprovedAnswerValue(answer.value)
    && (answer.source === 'USER_PROFILE' || answer.source === 'USER_INPUT' || answer.source === 'COVER_LETTER' || answer.source === 'AI_SUGGESTION')
    && isBoundedAnswerProvenance(answer.provenance)
    && provenanceSource === answer.source;
}

export function stableQuestionIdentity(
  provider: ApplicationFormProvider,
  field: Pick<ApplicationFormField, 'name' | 'label' | 'accessibleName' | 'kind' | 'autocomplete' | 'options' | 'semanticKey' | 'occurrenceKey'>,
  stepIdentity = 'default',
): string {
  const safeProvider = provider === 'GREENHOUSE' || provider === 'LEVER' ? provider : 'UNKNOWN';
  const safeStepIdentity = typeof stepIdentity === 'string' && stepIdentity.trim()
    && stepIdentity.length <= MAX_STEP_IDENTITY_LENGTH ? stepIdentity.trim() : 'default';
  const semanticName = boundedIdentityPart(field.semanticKey)
    || boundedIdentityPart(field.autocomplete)
    || boundedIdentityPart(field.name);
  // Prefer the computed accessible name: visible label wrappers are commonly
  // re-rendered by providers, while ARIA semantics remain the stable question
  // identity when present.
  const label = boundedIdentityPart(field.accessibleName) || boundedIdentityPart(field.label);
  const occurrence = boundedIdentityPart(field.occurrenceKey, 64);
  const safeKind = isKnownFieldKind(field.kind) ? field.kind : 'UNKNOWN';
  return [safeProvider, boundedIdentityPart(safeStepIdentity, MAX_STEP_IDENTITY_LENGTH) || 'default', safeKind,
    semanticName || 'unnamed', label || 'unlabelled', occurrence || 'one'].join(':');
}

function fingerprint(field: ApplicationFormField): string {
  return `${normalizeApplicationFormText(field.semanticKey ?? '')}_${normalizeApplicationFormText(field.name)}_${normalizeApplicationFormText(field.label)}_${normalizeApplicationFormText(field.accessibleName ?? '')}_${normalizeApplicationFormText(field.inputType ?? '')}`;
}
function profileKeyFor(field: ApplicationFormField): ApplicationFormProfileKey | undefined {
  return profileFields[normalizeApplicationFormText(field.name)]
    ?? profileFields[normalizeApplicationFormText(field.label)]
    ?? profileFields[normalizeApplicationFormText(field.accessibleName ?? '')]
    ?? profileFields[normalizeApplicationFormText(field.autocomplete ?? '')];
}
function verificationFor(field: ApplicationFormField): HumanVerificationKind | undefined {
  if (field.verification) return field.verification;
  const value = fingerprint(field);
  return classifyHumanVerification({
    captcha: /captcha|recaptcha|hcaptcha/.test(value), mfa: /mfa|one_time|verification_code|authenticator/.test(value),
    antiBot: /anti_bot|bot_check|challenge/.test(value), authentication: /sign_in|login|password/.test(value),
  })?.kind;
}

export function assessApplicationFormField(field: ApplicationFormField): ApplicationFormAssessment {
  const questionIdentity = field.identity ?? field.questionIdentity;
  if (!isKnownFieldKind(field.kind)) return { fieldId: field.id, questionIdentity, disposition: 'UNSUPPORTED', capability: 'REVIEW_ONLY', reason: 'Unknown control types cannot be safely completed' };
  const verification = verificationFor(field);
  const capability = field.capability ?? (field.kind === 'FILE' ? 'UPLOAD_DOCUMENT'
    : field.kind === 'CHECKBOX' ? 'SET_CHECKED'
      : field.kind === 'SELECT' || field.kind === 'RADIO' || field.kind === 'COMBOBOX' || field.kind === 'MULTISELECT' ? 'SELECT_OPTION'
        : field.kind === 'HIDDEN' || field.visible === false ? 'REVIEW_ONLY' : 'FILL_TEXT');
  if (verification) return { fieldId: field.id, questionIdentity, disposition: 'HUMAN_VERIFICATION_REQUIRED', verification, capability: 'REVIEW_ONLY', reason: `${verification} requires a human acknowledgement` };
  if (field.kind === 'HIDDEN' || field.visible === false) return { fieldId: field.id, questionIdentity, disposition: 'UNSUPPORTED', capability: 'REVIEW_ONLY', reason: 'Hidden controls are not application-answer fields' };
  if (field.enabled === false) return { fieldId: field.id, questionIdentity, disposition: 'UNSUPPORTED', capability: 'REVIEW_ONLY', reason: 'Disabled controls cannot be safely completed' };
  if (field.kind === 'FILE') return { fieldId: field.id, questionIdentity, disposition: 'UNSUPPORTED', capability, reason: 'Document upload requires the document evidence system' };
  const value = fingerprint(field);
  if (hostileInstructionPatterns.some(pattern => pattern.test(value))) return { fieldId: field.id, questionIdentity, disposition: 'UNSUPPORTED', capability: 'REVIEW_ONLY', reason: 'Untrusted webpage instructions cannot affect application policy' };
  if (sensitivePatterns.some(pattern => pattern.test(value))) return { fieldId: field.id, questionIdentity, disposition: 'SENSITIVE', capability, reason: 'Sensitive personal information requires explicit user handling' };
  if (highRiskPatterns.some(pattern => pattern.test(value))) return { fieldId: field.id, questionIdentity, disposition: 'HIGH_RISK', capability, reason: 'High-risk legal, eligibility, or compensation answer requires review' };
  if (customAnswerPatterns.some(pattern => pattern.test(value))) return { fieldId: field.id, questionIdentity, disposition: 'AMBIGUOUS', capability, reason: 'Custom narrative application question is not automatically answered' };
  const profileKey = profileKeyFor(field);
  if (profileKey) return { fieldId: field.id, questionIdentity, disposition: 'PROFILE_DERIVED', profileKey, capability, reason: 'Mapped to an approved profile field' };
  if (!field.required && field.kind === 'CHECKBOX') return { fieldId: field.id, questionIdentity, disposition: 'SAFE', capability, reason: 'Optional unchecked control is left unchanged' };
  return { fieldId: field.id, questionIdentity, disposition: 'AMBIGUOUS', capability, reason: 'Custom application question is not automatically answered' };
}

export function assessApplicationForm(fields: readonly ApplicationFormField[]): ApplicationFormAssessment[] { return fields.map(assessApplicationFormField); }

export const defaultFormDetector: FormDetector = {
  detect: async port => normalizeApplicationFormSnapshot(await port.snapshot()),
};
export const defaultFieldExtractor: FieldExtractor = {
  extract: snapshot => {
    const visible = (Array.isArray(snapshot.fields) ? snapshot.fields.slice(0, MAX_FORM_FIELDS) : []).filter(isApplicationFormField)
      .filter(field => field.kind !== 'HIDDEN' && field.visible !== false);
    const validationByField = new Map<string, string[]>();
    for (const error of safeValidationErrors(snapshot.validationErrors)) {
      if (!error.fieldId) continue;
      const messages = validationByField.get(error.fieldId) ?? [];
      if (!messages.includes(error.message)) messages.push(error.message);
      validationByField.set(error.fieldId, messages);
    }
    const totals = new Map<string, number>();
    for (const field of visible) {
      const key = `${normalizeApplicationFormText(field.semanticKey ?? '')}|${normalizeApplicationFormText(field.name)}|${normalizeApplicationFormText(field.label)}|${normalizeApplicationFormText(field.accessibleName ?? '')}|${field.kind}`;
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    const duplicateOccurrences = new Map<number, string>();
    for (const [key, total] of totals) {
      if (total < 2) continue;
      const indexes = visible.map((field, index) => ({ field, index }))
        .filter(({ field }) => `${normalizeApplicationFormText(field.semanticKey ?? '')}|${normalizeApplicationFormText(field.name)}|${normalizeApplicationFormText(field.label)}|${normalizeApplicationFormText(field.accessibleName ?? '')}|${field.kind}` === key)
        .sort((left, right) => {
          // The provider control id is only a final tie-breaker for truly
          // identical repeated controls; it is never included in identity.
          const stable = (field: ApplicationFormField) => [field.semanticKey, field.name, field.label, field.accessibleName, field.autocomplete, field.inputType, field.id]
            .map(value => normalizeApplicationFormText(value ?? '')).join('|');
          return stable(left.field).localeCompare(stable(right.field));
        });
      indexes.forEach(({ index }, occurrence) => duplicateOccurrences.set(index, `duplicate-${occurrence + 1}`));
    }
    return visible.map((field, index) => {
      const occurrenceKey = field.occurrenceKey ?? duplicateOccurrences.get(index);
      // Identity aliases are webpage-controlled snapshot data. Even a bounded
      // alias could collide with an approved answer for another question, so
      // derive the durable identity only from semantic field metadata.
      const identity = stableQuestionIdentity(snapshot.provider ?? 'UNKNOWN', { ...field, occurrenceKey }, snapshot.stepIdentity ?? `step-${snapshot.step}`);
      const fieldValidationErrors: readonly unknown[] = Array.isArray(field.validationErrors) ? field.validationErrors.slice(0, MAX_VALIDATION_ERRORS) : [];
      const validationErrors = [...fieldValidationErrors.map(safeValidationMessage).filter((message): message is string => Boolean(message)), ...(validationByField.get(field.id) ?? [])]
        .filter((message, messageIndex, messages) => messages.indexOf(message) === messageIndex);
      return { ...field, occurrenceKey, identity, questionIdentity: identity, validationErrors };
    });
  },
};
export const defaultFieldMapper: FieldMapper = { map: fields => assessApplicationForm(fields) };
export const approvedAnswerResolver: AnswerResolver = {
  resolve({ field, assessment, ownerId, profile, approvedAnswers }) {
    if (assessment.disposition === 'PROFILE_DERIVED' && assessment.profileKey) {
      const value = profile?.[assessment.profileKey]?.trim();
      if (value) return value;
    }
    const questionIdentity = field.identity ?? field.questionIdentity ?? assessment.questionIdentity;
    if (!ownerId || !questionIdentity) return undefined;
    const answer = approvedAnswers
      ?.filter(candidate => isTrustedApprovedAnswer(candidate, ownerId, questionIdentity))
      .sort((left, right) => right.version - left.version
        || (right.approvedAt!.getTime() - left.approvedAt!.getTime()))[0];
    return answer?.value;
  },
};

export interface ApplicationFormFillResult {
  step: number;
  stepIdentity: string;
  fields: readonly ApplicationFormField[];
  hasNextStep: boolean;
  filledFieldIds: string[];
  requiredBlockingFieldIds: string[];
  assessments: ApplicationFormAssessment[];
  validationErrors: readonly { fieldId?: string; message: string }[];
  advanced: boolean;
}

export class ApplicationFormAdapter<TPort extends ApplicationFormPort = ApplicationFormPort> {
  constructor(
    private readonly detector: FormDetector<TPort> = defaultFormDetector as FormDetector<TPort>,
    private readonly extractor: FieldExtractor = defaultFieldExtractor,
    private readonly mapper: FieldMapper = defaultFieldMapper,
    private readonly answers: AnswerResolver = approvedAnswerResolver,
  ) {}

  inspect(snapshot: ApplicationFormSnapshot): ApplicationFormAssessment[] {
    return this.mapper.map(this.fieldsFor(normalizeApplicationFormSnapshot(snapshot)));
  }

  async fillCurrentStep(
    port: TPort,
    profile: Readonly<Partial<Record<ApplicationFormProfileKey, string>>>,
    approvedAnswers: readonly ApprovedApplicationAnswer[] = [],
    ownerId?: string,
  ): Promise<ApplicationFormFillResult> {
    const snapshot = normalizeApplicationFormSnapshot(await this.detector.detect(port));
    const fields = this.fieldsFor(snapshot);
    const assessments = this.mapper.map(fields);
    const filledFieldIds: string[] = [];
    for (const assessment of assessments) {
      if (assessment.disposition === 'UNSUPPORTED' || assessment.disposition === 'HUMAN_VERIFICATION_REQUIRED') continue;
      const field = fields.find(candidate => candidate.id === assessment.fieldId);
      if (!field) continue;
      const value = this.answers.resolve({ field, assessment, ownerId, profile, approvedAnswers });
      if (value === undefined || value === '') continue;
      if (field.kind === 'SELECT' || field.kind === 'COMBOBOX') {
        if (typeof value === 'boolean') continue;
        if (typeof value !== 'string' && (!Array.isArray(value) || !value.every(option => typeof option === 'string'))) continue;
        const values = Array.isArray(value) ? value : [value];
        if (field.kind === 'COMBOBOX' && values.length !== 1) continue;
        if (!field.options || values.some(option => !field.options!.some(candidate => candidate.trim() === option.trim()))) continue;
        await port.select(field.id, value);
      } else if (field.kind === 'MULTISELECT') {
        if (typeof value !== 'string' && (!Array.isArray(value) || !value.every(option => typeof option === 'string'))) continue;
        const values = Array.isArray(value) ? value : [value];
        if (!field.options || values.some(option => !field.options!.some(candidate => candidate.trim() === option.trim()))) continue;
        await port.select(field.id, values);
      } else if (field.kind === 'CHECKBOX') {
        if (typeof value !== 'boolean') continue;
        await port.setChecked(field.id, value);
      } else if (field.kind === 'RADIO') {
        if (typeof value !== 'string' || !field.options?.some(option => option.trim() === value.trim())) continue;
        await port.select(field.id, value);
      } else {
        if (typeof value !== 'string') continue;
        await port.fill(field.id, value);
      }
      filledFieldIds.push(field.id);
    }
    // Conditional controls can be rendered as a consequence of a prior
    // selection/fill. Reinspect before deciding whether the step is complete;
    // otherwise a newly required field could be missed by the first snapshot.
    const refreshedSnapshot = normalizeApplicationFormSnapshot(await this.detector.detect(port));
    const refreshedFields = this.fieldsFor(refreshedSnapshot);
    // The refreshed snapshot is authoritative: controls removed by a
    // conditional branch must not remain as stale blockers.
    const currentFields = refreshedFields;
    const currentAssessments = this.mapper.map(currentFields);
    const validationErrors = [...safeValidationErrors(snapshot.validationErrors), ...safeValidationErrors(refreshedSnapshot.validationErrors), ...safeValidationErrors(await port.validate())]
      .filter((error, index, errors) => errors.findIndex(candidate => candidate.fieldId === error.fieldId && candidate.message === error.message) === index)
      .slice(0, MAX_VALIDATION_ERRORS);
    const requiredBlockingFieldIds = currentFields
      .filter(field => field.required && !filledFieldIds.includes(field.id) && !hasUsableCurrentValue(field))
      .map(field => field.id);
    const advanced = refreshedSnapshot.hasNextStep && !validationErrors.length && !requiredBlockingFieldIds.length;
    if (advanced) await port.advance();
    return { step: refreshedSnapshot.step, stepIdentity: refreshedSnapshot.stepIdentity ?? `step-${refreshedSnapshot.step}`, fields: currentFields, hasNextStep: refreshedSnapshot.hasNextStep, filledFieldIds, requiredBlockingFieldIds, assessments: currentAssessments, validationErrors, advanced };
  }

  private fieldsFor(snapshot: ApplicationFormSnapshot): ApplicationFormField[] {
    return this.extractor.extract(snapshot).map(field => ({
      ...field,
      identity: stableQuestionIdentity(snapshot.provider ?? 'UNKNOWN', field, snapshot.stepIdentity ?? `step-${snapshot.step}`),
      questionIdentity: stableQuestionIdentity(snapshot.provider ?? 'UNKNOWN', field, snapshot.stepIdentity ?? `step-${snapshot.step}`),
    }));
  }
}

function hasUsableCurrentValue(field: ApplicationFormField): boolean {
  if (field.kind === 'CHECKBOX') return field.currentValue === true;
  if (typeof field.currentValue === 'string') return field.currentValue.trim().length > 0;
  return Array.isArray(field.currentValue) && field.currentValue.length > 0;
}
