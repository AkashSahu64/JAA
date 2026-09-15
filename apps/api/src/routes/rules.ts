import { Router, Response } from 'express';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { isRecord, pick, validateBody } from '../middleware/validate';

const router = Router();
router.use(authenticate);
const RULE_FIELDS = ['name', 'conditions', 'action', 'priority', 'enabled'] as const;
const RULE_ACTIONS = new Set(['REVIEW', 'APPLY', 'SKIP', 'NOTIFY']);

function validateRule(body: unknown, partial: boolean): string | null {
  if (!isRecord(body)) return 'Request body must be an object';
  if (!partial && (typeof body.name !== 'string' || !body.name.trim())) return 'name is required';
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200)) return 'name must be between 1 and 200 characters';
  if ('conditions' in body && !Array.isArray(body.conditions)) return 'conditions must be an array';
  if ('action' in body && (typeof body.action !== 'string' || !RULE_ACTIONS.has(body.action))) return 'Invalid rule action';
  if ('priority' in body && (!Number.isInteger(body.priority) || body.priority < -1000 || body.priority > 1000)) return 'priority must be an integer from -1000 to 1000';
  if ('enabled' in body && typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
  return null;
}

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rules = await withTenant(req.user!.userId, tx => tx.userRule.findMany({ where: { userId: req.user!.userId }, orderBy: { priority: 'desc' } }));
    return res.json({ success: true, data: rules });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to fetch rules' });
  }
});

router.post('/', validateBody({}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const validationError = validateRule(req.body, false);
    if (validationError) return res.status(400).json({ success: false, error: validationError });
    const data = pick(req.body, RULE_FIELDS);
    const rule = await withTenant(req.user!.userId, tx => tx.userRule.create({
      data: { userId: req.user!.userId, name: req.body.name.trim(), conditions: data.conditions ?? [], action: data.action ?? 'REVIEW', priority: data.priority ?? 0, enabled: data.enabled ?? true },
    }));
    return res.status(201).json({ success: true, data: rule });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to create rule' });
  }
});

router.put('/:id', validateBody({}), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const validationError = validateRule(req.body, true);
    if (validationError) return res.status(400).json({ success: false, error: validationError });
    const data = pick(req.body, RULE_FIELDS);
    if (Object.keys(data).length === 0) return res.status(400).json({ success: false, error: 'No supported fields supplied' });
    if (typeof data.name === 'string') data.name = data.name.trim();
    const rule = await withTenant(req.user!.userId, async tx => {
      const updated = await tx.userRule.updateMany({ where: { id: req.params.id, userId: req.user!.userId }, data });
      if (updated.count === 0) return null;
      return tx.userRule.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
    });
    if (!rule) return res.status(404).json({ success: false, error: 'Rule not found' });
    return res.json({ success: true, data: rule });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to update rule' });
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await withTenant(req.user!.userId, tx => tx.userRule.deleteMany({ where: { id: req.params.id, userId: req.user!.userId } }));
    if (result.count === 0) return res.status(404).json({ success: false, error: 'Rule not found' });
    return res.json({ success: true, message: 'Rule deleted' });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to delete rule' });
  }
});

export { router as ruleRoutes };
