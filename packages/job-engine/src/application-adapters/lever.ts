import {
  ApplicationFormAdapter,
  normalizeApplicationFormSnapshot,
  type ApplicationFormField,
  type ApplicationFormFillResult,
  type FormDetector,
  type ApplicationFormPort,
  type ApplicationFormProfileKey,
  type ApplicationFormSnapshot,
} from '../form-intelligence';
import { safeProviderApplicationHost } from './provider-host';

export type LeverField = ApplicationFormField;

export interface LeverFormSnapshot extends ApplicationFormSnapshot {
  provider?: ApplicationFormSnapshot['provider'];
  stepIdentity?: string;
  fields: readonly LeverField[];
}

export type ApprovedLeverProfile = Readonly<Partial<Record<ApplicationFormProfileKey, string>>>;
export type LeverFormPort = ApplicationFormPort<LeverFormSnapshot>;
export type LeverFillResult = ApplicationFormFillResult;

export function leverApplicationHost(url: string): string | null {
  return safeProviderApplicationHost(url, ['jobs.lever.co']);
}

const leverDetector: FormDetector<LeverFormPort> = {
  detect: async port => {
    const raw = await port.snapshot();
    const hasProvider = Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'provider'));
    if (hasProvider && (raw as ApplicationFormSnapshot).provider !== 'LEVER') {
      return { provider: 'UNKNOWN', step: 0, stepIdentity: 'default', fields: [], hasNextStep: false, validationErrors: [] };
    }
    const snapshot = normalizeApplicationFormSnapshot(raw);
    return snapshot.provider === 'UNKNOWN' ? { ...snapshot, provider: 'LEVER' } : snapshot;
  },
};

/** Lever provider boundary; this owns only Lever transport while generic policy remains shared. */
export class LeverApplicationAdapter extends ApplicationFormAdapter<LeverFormPort> {
  constructor() {
    super(leverDetector);
  }
}
