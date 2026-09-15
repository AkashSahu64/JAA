import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { isRecord, pick, validateBody } from '../middleware/validate';
import { logRouteError } from '../observability/structured-log';

const router = Router();
router.use(authenticate);

const PROFILE_FIELDS = [
  'fullName', 'email', 'phone', 'locationCountry', 'locationState', 'locationCity', 'linkedIn', 'github',
  'portfolio', 'otherLinks', 'currentRole', 'yearsOfExperience', 'targetRoles', 'seniority', 'professionalSummary',
  'careerObjective', 'experience', 'education', 'certifications', 'skills', 'projects', 'languages', 'workAuthorized',
  'visaRequired', 'visaType', 'sponsorshipNeeded', 'securityClearance', 'salaryPreference', 'locationPreferences',
  'noticePeriod', 'availability', 'additionalData',
] as const;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function isBoundedProfileText(value: unknown, max = 20_000): value is string {
  return typeof value === 'string' && value.length <= max && !hasControlCharacters(value);
}

export function validateProfile(body: unknown): string | null {
  if (!isRecord(body)) return 'Request body must be an object';
  for (const field of ['fullName', 'email', 'phone', 'locationCountry', 'locationState', 'locationCity', 'linkedIn', 'github', 'portfolio', 'currentRole', 'seniority', 'professionalSummary', 'careerObjective', 'visaType', 'securityClearance', 'noticePeriod', 'availability']) {
    if (field in body && body[field] !== null && !isBoundedProfileText(body[field])) return `${field} must be a bounded string`;
  }
  if ('yearsOfExperience' in body && (typeof body.yearsOfExperience !== 'number' || !Number.isFinite(body.yearsOfExperience) || body.yearsOfExperience < 0 || body.yearsOfExperience > 100)) return 'yearsOfExperience must be between 0 and 100';
  if ('targetRoles' in body && (!Array.isArray(body.targetRoles) || body.targetRoles.length > 100 || body.targetRoles.some((value: unknown) => !isBoundedProfileText(value, 200)))) return 'targetRoles must be an array of bounded strings';
  for (const field of ['workAuthorized', 'visaRequired', 'sponsorshipNeeded']) if (field in body && typeof body[field] !== 'boolean') return `${field} must be a boolean`;
  return null;
}

function normalizeProfile(body: Record<string, any>, userEmail: string, creating: boolean) {
  const data = pick(body, PROFILE_FIELDS);
  if (creating) {
    data.fullName = typeof data.fullName === 'string' ? data.fullName.trim() : '';
    data.email = typeof data.email === 'string' && data.email.trim() ? data.email.trim() : userEmail;
  }
  return data;
}

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await withTenant(req.user!.userId, tx => tx.userProfile.findUnique({ where: { userId: req.user!.userId } }));
    return res.json({ success: true, data: profile });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
});

router.post('/', validateBody({}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const validationError = validateProfile(req.body);
    if (validationError) return res.status(400).json({ success: false, error: validationError });
    const userId = req.user!.userId;
    const profile = await withTenant(userId, async tx => {
      if (await tx.userProfile.findUnique({ where: { userId }, select: { id: true } })) return null;
      return tx.userProfile.create({ data: { userId, ...normalizeProfile(req.body, req.user!.email, true) } as any });
    });
    if (!profile) return res.status(409).json({ success: false, error: 'Profile already exists. Use PUT to update.' });
    return res.status(201).json({ success: true, data: profile });
  } catch (error) {
    logRouteError('profile.creation_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to create profile' });
  }
});

router.put('/', validateBody({}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const validationError = validateProfile(req.body);
    if (validationError) return res.status(400).json({ success: false, error: validationError });
    const data = normalizeProfile(req.body, req.user!.email, false);
    if (Object.keys(data).length === 0) return res.status(400).json({ success: false, error: 'No supported fields supplied' });
    const profile = await withTenant(req.user!.userId, async tx => {
      const existing = await tx.userProfile.findUnique({ where: { userId: req.user!.userId }, select: { id: true } });
      if (!existing) return tx.userProfile.create({ data: { userId: req.user!.userId, ...normalizeProfile(req.body, req.user!.email, true) } as any });
      return tx.userProfile.update({ where: { userId: req.user!.userId }, data });
    });
    return res.json({ success: true, data: profile });
  } catch (error) {
    logRouteError('profile.update_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    return res.status(500).json({ success: false, error: 'Failed to update profile' });
  }
});

export { router as profileRoutes };
