import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { isRecord, pick, validateBody } from '../middleware/validate';
import { nextScheduledRun, SchedulerError } from '../services/scheduler';

const router = Router();
router.use(authenticate);

const SEARCH_PROFILE_FIELDS = [
  'name', 'country', 'states', 'cities', 'remoteTypes', 'targetRoles', 'seniority', 'experienceMin',
  'experienceMax', 'skills', 'technologies', 'salaryMin', 'salaryMax', 'salaryCurrency', 'employmentTypes',
  'industries', 'excludedCompanies', 'preferredCompanies', 'sources', 'minMatchScore', 'minATSScore',
  'maxApplicationsPerDay', 'schedule', 'customCron', 'isActive',
  'discoveryAccounts', 'timeZone',
] as const;
const arrays = ['states', 'cities', 'remoteTypes', 'targetRoles', 'seniority', 'skills', 'technologies', 'employmentTypes', 'industries', 'excludedCompanies', 'preferredCompanies', 'sources'];
function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function isBoundedText(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length <= max && !hasControlCharacters(value);
}

export function validateProfile(body: unknown, partial: boolean): string | null {
  if (!isRecord(body)) return 'Request body must be an object';
  if (!partial && (typeof body.name !== 'string' || !body.name.trim())) return 'name is required';
  if ('name' in body && (!isBoundedText(body.name) || !body.name.trim())) return 'name must be between 1 and 200 characters';
  for (const field of arrays) if (field in body && (!Array.isArray(body[field]) || body[field].some((value: unknown) => !isBoundedText(value)))) return `${field} must be an array of bounded strings`;
  if ('discoveryAccounts' in body && (!Array.isArray(body.discoveryAccounts) || body.discoveryAccounts.some((value: unknown) => {
    if (!isRecord(value) || (value.source !== 'GREENHOUSE' && value.source !== 'LEVER' && value.source !== 'ASHBY')) return true;
    return !isBoundedText(value.account) || !value.account.trim();
  }))) return 'discoveryAccounts must contain valid provider/account objects';
  const schedules = new Set(['ONCE', 'HOURLY', 'EVERY_3_HOURS', 'DAILY', 'WEEKLY', 'CUSTOM']);
  if ('schedule' in body && (typeof body.schedule !== 'string' || !schedules.has(body.schedule))) return 'schedule is invalid';
  if ('customCron' in body && body.customCron !== null && (typeof body.customCron !== 'string' || body.customCron.length > 100)) return 'customCron is invalid';
  const schedule = typeof body.schedule === 'string' ? body.schedule : undefined;
  const customCron = typeof body.customCron === 'string' ? body.customCron.trim() : undefined;
  if (schedule === 'CUSTOM' && !customCron) return 'customCron is required for CUSTOM schedules';
  if (schedule && schedule !== 'CUSTOM' && customCron) return 'customCron is only valid for CUSTOM schedules';
  if ('timeZone' in body) {
    if (!isBoundedText(body.timeZone, 100)) return 'timeZone is invalid';
    try { new Intl.DateTimeFormat('en-US', { timeZone: body.timeZone }).format(); } catch { return 'timeZone is invalid'; }
  }
  if (schedule === 'CUSTOM' && customCron) {
    try { nextScheduledRun('CUSTOM', customCron, new Date(), typeof body.timeZone === 'string' ? body.timeZone : 'UTC'); }
    catch (error) { if (error instanceof SchedulerError) return 'customCron is invalid'; throw error; }
  }
  for (const field of ['minMatchScore', 'minATSScore']) if (field in body && (!Number.isInteger(body[field]) || body[field] < 0 || body[field] > 100)) return `${field} must be an integer from 0 to 100`;
  for (const field of ['experienceMin', 'experienceMax', 'maxApplicationsPerDay']) if (field in body && body[field] !== null && (!Number.isInteger(body[field]) || body[field] < 0)) return `${field} must be a non-negative integer`;
  for (const field of ['salaryMin', 'salaryMax']) if (field in body && body[field] !== null && (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0)) return `${field} must be a non-negative number`;
  return null;
}

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profiles = await withTenant(req.user!.userId, tx => tx.searchProfile.findMany({ where: { userId: req.user!.userId }, orderBy: { createdAt: 'desc' } }));
    return res.json({ success: true, data: profiles });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to fetch search profiles' });
  }
});

router.post('/', validateBody({}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const validationError = validateProfile(req.body, false);
    if (validationError) return res.status(400).json({ success: false, error: validationError });
    const profile = await withTenant(req.user!.userId, tx => tx.searchProfile.create({ data: { userId: req.user!.userId, ...pick(req.body, SEARCH_PROFILE_FIELDS), name: req.body.name.trim() } as any }));
    return res.status(201).json({ success: true, data: profile });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to create search profile' });
  }
});

router.put('/:id', validateBody({}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const validationError = validateProfile(req.body, true);
    if (validationError) return res.status(400).json({ success: false, error: validationError });
    const data = pick(req.body, SEARCH_PROFILE_FIELDS);
    if (Object.keys(data).length === 0) return res.status(400).json({ success: false, error: 'No supported fields supplied' });
    if (typeof data.name === 'string') data.name = data.name.trim();
    const result = await withTenant(req.user!.userId, async tx => {
      const updated = await tx.searchProfile.updateMany({ where: { id: req.params.id, userId: req.user!.userId }, data });
      if (updated.count === 0) return null;
      return tx.searchProfile.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
    });
    if (!result) return res.status(404).json({ success: false, error: 'Search profile not found' });
    const profile = result;
    return res.json({ success: true, data: profile });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to update search profile' });
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await withTenant(req.user!.userId, tx => tx.searchProfile.deleteMany({ where: { id: req.params.id, userId: req.user!.userId } }));
    if (result.count === 0) return res.status(404).json({ success: false, error: 'Search profile not found' });
    return res.json({ success: true, message: 'Deleted' });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to delete search profile' });
  }
});

export { router as searchProfileRoutes };
