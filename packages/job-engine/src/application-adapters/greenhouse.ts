import {
  assessApplicationForm,
  type ApplicationFormAssessment,
  type ApplicationFormField,
  type ApplicationFormProfileKey,
} from '../form-intelligence';

export type GreenhouseField = ApplicationFormField;

export interface GreenhouseFormSnapshot {
  step: number;
  fields: readonly GreenhouseField[];
  hasNextStep: boolean;
}

export interface ApprovedGreenhouseProfile {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly location?: string;
  readonly linkedinUrl?: string;
  readonly websiteUrl?: string;
}

export interface GreenhouseFormPort {
  snapshot(): Promise<GreenhouseFormSnapshot>;
  fill(fieldId: string, value: string): Promise<void>;
  select(fieldId: string, value: string): Promise<void>;
  setChecked(fieldId: string, checked: boolean): Promise<void>;
  validate(): Promise<readonly { fieldId?: string; message: string }[]>;
  advance(): Promise<void>;
}

export interface GreenhouseFillResult {
  step: number;
  fields: readonly GreenhouseField[];
  filledFieldIds: string[];
  requiredBlockingFieldIds: string[];
  assessments: ApplicationFormAssessment[];
  validationErrors: readonly { fieldId?: string; message: string }[];
  advanced: boolean;
}

function usableValue(
  profile: ApprovedGreenhouseProfile,
  key: ApplicationFormProfileKey,
): string | undefined {
  const value = profile[key]?.trim();
  return value || undefined;
}

export class GreenhouseApplicationAdapter {
  inspect(snapshot: GreenhouseFormSnapshot): ApplicationFormAssessment[] {
    return assessApplicationForm(snapshot.fields)
      .filter(assessment => snapshot.fields.some(field =>
        field.id === assessment.fieldId && field.kind !== 'HIDDEN',
      ));
  }

  async fillCurrentStep(
    port: GreenhouseFormPort,
    profile: ApprovedGreenhouseProfile,
  ): Promise<GreenhouseFillResult> {
    const snapshot = await port.snapshot();
    const assessments = this.inspect(snapshot);
    const filledFieldIds: string[] = [];
    for (const assessment of assessments) {
      if (assessment.disposition !== 'PROFILE_DERIVED' || !assessment.profileKey) continue;
      const value = usableValue(profile, assessment.profileKey);
      if (!value) continue;
      const field = snapshot.fields.find(candidate => candidate.id === assessment.fieldId);
      if (!field) continue;
      if (field.kind === 'SELECT') {
        if (!field.options?.some(option => option.trim() === value)) continue;
        await port.select(field.id, value);
      } else if (field.kind === 'CHECKBOX') {
        continue;
      } else {
        await port.fill(field.id, value);
      }
      filledFieldIds.push(field.id);
    }
    const validationErrors = await port.validate();
    const requiredBlockingFieldIds = snapshot.fields
      .filter(field => field.required && (
        !assessments.some(assessment =>
          assessment.fieldId === field.id && assessment.disposition === 'PROFILE_DERIVED',
        ) || !filledFieldIds.includes(field.id)
      ))
      .map(field => field.id);
    const advanced = snapshot.hasNextStep && !validationErrors.length && !requiredBlockingFieldIds.length;
    if (advanced) await port.advance();
    return {
      step: snapshot.step,
      fields: snapshot.fields,
      filledFieldIds,
      requiredBlockingFieldIds,
      assessments,
      validationErrors,
      advanced,
    };
  }
}
