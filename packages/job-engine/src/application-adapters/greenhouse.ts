import {
  ApplicationFormAdapter,
  normalizeApplicationFormSnapshot,
  type ApplicationFormAssessment,
  type ApplicationFormField,
  type ApplicationFormProfileKey,
  type ApplicationFormFillResult,
  type ApplicationFormPort,
  type ApplicationFormSnapshot,
  type FormDetector,
} from '../form-intelligence';
import { safeProviderApplicationHost } from './provider-host';

export type GreenhouseField = ApplicationFormField;

export interface GreenhouseFormSnapshot extends ApplicationFormSnapshot {
  provider?: ApplicationFormSnapshot['provider'];
  stepIdentity?: string;
  fields: readonly GreenhouseField[];
}

export type ApprovedGreenhouseProfile = Readonly<Partial<Record<ApplicationFormProfileKey, string>>>;
export type GreenhouseFormPort = ApplicationFormPort<GreenhouseFormSnapshot>;
export type GreenhouseFillResult = ApplicationFormFillResult;

export function greenhouseApplicationHost(url: string): string | null {
  return safeProviderApplicationHost(url, ['boards.greenhouse.io', 'job-boards.greenhouse.io']);
}

const greenhouseDetector: FormDetector<GreenhouseFormPort> = {
  detect: async port => {
    const raw = await port.snapshot();
    const hasProvider = Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'provider'));
    if (hasProvider && (raw as ApplicationFormSnapshot).provider !== 'GREENHOUSE') {
      return { provider: 'UNKNOWN', step: 0, stepIdentity: 'default', fields: [], hasNextStep: false, validationErrors: [] };
    }
    const snapshot = normalizeApplicationFormSnapshot(raw);
    return snapshot.provider === 'UNKNOWN' ? { ...snapshot, provider: 'GREENHOUSE' } : snapshot;
  },
};

/** Greenhouse provider boundary; shared policy and answer handling live in form-intelligence. */
export class GreenhouseApplicationAdapter extends ApplicationFormAdapter<GreenhouseFormPort> {
  constructor() {
    super(greenhouseDetector);
  }

  inspect(snapshot: GreenhouseFormSnapshot): ApplicationFormAssessment[] {
    return super.inspect(snapshot);
  }
}
