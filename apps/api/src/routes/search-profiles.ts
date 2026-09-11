import { Router, Response } from 'express';
import { prisma } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { isRecord, pick, validateBody } from '../middleware/validate';

const router = Router();
router.use(authenticate);

const SEARCH_PROFILE_FIELDS = [
  'name', 'country', 'states', 'cities', 'remoteTypes', 'targetRoles', 'seniority', 'experienceMin',
  'experienceMax', 'skills', 'technologies', 'salaryMin', 'salaryMax', 'salaryCurrency', 'employmentTypes',
  'industries', 'excludedCompanies', 'preferredCompanies', 'sources', 'minMatchScore', 'minATSScore',
  'maxApplicationsPerDay', 'schedule', 'customCron', 'isActive',
] as const;
const arrays = ['states', 'cities', 'remoteTypes', 'targetRoles', 'seniority', 'skills', 'technologies', 'employmentTypes', 'industries', 'excludedCompanies', 'preferredCompanies', 'sources'];

function validateProfile(body: unknown, partial: boolean): string | null {
  if (!isRecord(body)) return 'Request body must be an object';
  if (!partial && (typeof body.name !== 'string' || !body.name.trim())) return 'name is required';
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200)) return 'name must be between 1 and 200 characters';
  for (const field of arrays) if (field in body && (!Array.isArray(body[field]) || body[field].some((value: unknown) => typeof value !== 'string'))) return `${field} must be an array of strings`;
  for (const field of ['minMatchScore', 'minATSScore']) if (field in body && (!Number.isInteger(body[field]) || body[field] < 0 || body[field] > 100)) return `${field} must be an integer from 0 to 100`;
  for (const field of ['experienceMin', 'experienceMax', 'maxApplicationsPerDay']) if (field in body && body[field] !== null && (!Number.isInteger(body[field]) || body[field] < 0)) return `${field} must be a non-negative integer`;
  for (const field of ['salaryMin', 'salaryMax']) if (field in body && body[field] !== null && (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0)) return `${field} must be a non-negative number`;
  return null;
}

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profiles = await prisma.searchProfile.findMany({ where: { userId: req.user!.userId }, orderBy: { createdAt: 'desc' } });
    return res.json({ success: true, data: profiles });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to fetch search profiles' });
  }
});

router.post('/', validateBody({}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const validationError = validateProfile(req.body, false);
    if (validationError) return res.status(400).json({ success: false, error: validationError });
    const profile = await prisma.searchProfile.create({ data: { userId: req.user!.userId, ...pick(req.body, SEARCH_PROFILE_FIELDS), name: req.body.name.trim() } as any });
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
    const result = await prisma.searchProfile.updateMany({ where: { id: req.params.id, userId: req.user!.userId }, data });
    if (result.count === 0) return res.status(404).json({ success: false, error: 'Search profile not found' });
    const profile = await prisma.searchProfile.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
    return res.json({ success: true, data: profile });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to update search profile' });
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await prisma.searchProfile.deleteMany({ where: { id: req.params.id, userId: req.user!.userId } });
    if (result.count === 0) return res.status(404).json({ success: false, error: 'Search profile not found' });
    return res.json({ success: true, message: 'Deleted' });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to delete search profile' });
  }
});

export { router as searchProfileRoutes };
