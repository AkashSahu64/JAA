import { Router, Response } from 'express';
import { getAIProvider, AIMessage } from '@jobagent/ai';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { isRecord } from '../middleware/validate';

const router = Router();
router.use(authenticate);

const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4_000;
const SYSTEM_PROMPT = `You are JobAgent, a concise career assistant. Help with job-search strategy,
resume wording, application preparation, and interview practice. Never invent facts about the user,
their resume, applications, employers, or job listings. Ask for missing context and clearly distinguish
suggestions from known facts. Do not claim that an application was submitted or an action was executed.`;

router.post('/chat', async (req: AuthenticatedRequest, res: Response) => {
  if (!isRecord(req.body) || !Array.isArray(req.body.messages)) {
    return res.status(400).json({ success: false, error: 'messages must be an array' });
  }

  const messages = parseMessages(req.body.messages);
  if (!messages) {
    return res.status(400).json({
      success: false,
      error: `Provide 1-${MAX_MESSAGES} valid messages of at most ${MAX_MESSAGE_LENGTH} characters`,
    });
  }

  try {
    const reply = await getAIProvider().complete(
      [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      { temperature: 0.3, maxTokens: 1_000 }
    );
    return res.json({ success: true, data: { reply } });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('AI_API_KEY') || message.includes('Unsupported AI provider')) {
      return res.status(503).json({ success: false, error: 'AI assistant is not configured' });
    }
    console.error('AI chat error:', error);
    return res.status(502).json({ success: false, error: 'AI provider request failed' });
  }
});

function parseMessages(value: unknown[]): AIMessage[] | null {
  if (value.length === 0 || value.length > MAX_MESSAGES) return null;
  const messages: AIMessage[] = [];
  for (const item of value) {
    if (!isRecord(item) || (item.role !== 'user' && item.role !== 'assistant')) return null;
    if (typeof item.content !== 'string') return null;
    const content = item.content.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH) return null;
    messages.push({ role: item.role, content });
  }
  return messages;
}

export { router as aiRoutes };
