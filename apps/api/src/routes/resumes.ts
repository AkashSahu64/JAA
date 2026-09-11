import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { prisma, withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { sanitizeFileName } from '@jobagent/security';
import { ResumeParser } from '@jobagent/resume-engine';
import { createAutomationJob } from '../services/automation-jobs';
import { DocumentStorage, DocumentStorageError } from '../services/document-storage';
import {
  CandidateFactError,
  decideResumeCandidateFact,
  listResumeCandidateFacts,
  replaceResumeCandidateFacts,
} from '../services/candidate-facts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowedTypes: Record<string, Set<string>> = {
      '.pdf': new Set(['application/pdf']),
      '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
      '.txt': new Set(['text/plain']),
    };
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes[ext]?.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOCX, and TXT files are allowed'));
    }
  },
});

const router = Router();
router.use(authenticate);

const parser = new ResumeParser();
const documentStorage = new DocumentStorage();

// POST /api/resumes/upload - Upload master resume
router.post('/upload', upload.single('resume'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const uploadedFile = req.file;
    if (!uploadedFile) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const requestedName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (requestedName.length > 200) {
      return res.status(400).json({ success: false, error: 'Resume name must be at most 200 characters' });
    }
    const fileName = sanitizeFileName(uploadedFile.originalname);
    const stored = await documentStorage.storeResume({
      userId: req.user!.userId,
      fileName,
      mimeType: uploadedFile.mimetype,
      buffer: uploadedFile.buffer,
    });
    let persisted = false;
    try {
      const parsed = await parser.parseBuffer(uploadedFile.buffer, fileName);
      const resume = await withTenant(req.user!.userId, async (tx) => {
        if (req.body.isMaster === 'true' || req.body.isMaster === true) {
          await tx.resume.updateMany({ where: { userId: req.user!.userId, isMaster: true }, data: { isMaster: false } });
        }
        const created = await tx.resume.create({
          data: {
            userId: req.user!.userId,
            name: requestedName || 'Master Resume',
            isMaster: req.body.isMaster === 'true' || req.body.isMaster === true,
            content: parsed.text,
            fileName,
            mimeType: stored.mimeType,
            parsedData: JSON.parse(JSON.stringify({
              sections: parsed.sections,
              metadata: parsed.metadata,
            })),
          },
        });
        await tx.objectMetadata.create({
          data: {
            userId: req.user!.userId,
            resumeId: created.id,
            bucket: stored.bucket,
            objectKey: stored.objectKey,
            versionId: stored.versionId,
            kind: 'RESUME_SOURCE',
            fileName: stored.fileName,
            mimeType: stored.mimeType,
            byteSize: BigInt(stored.byteSize),
            checksumSha256: stored.checksumSha256,
            encryptionKeyRef: stored.encryptionKeyRef,
            scanStatus: stored.scanStatus,
            scanDetails: stored.scanDetails,
            provenance: { source: 'RESUME_UPLOAD' },
          },
        });
        return created;
      });
      persisted = true;
      const facts = await replaceResumeCandidateFacts(resume.id, req.user!.userId);

      return res.status(201).json({
        success: true,
        data: {
          id: resume.id,
          name: resume.name,
          isMaster: resume.isMaster,
          fileName: resume.fileName,
          sections: parsed.sections.map((s: { name: string }) => s.name),
          textLength: parsed.text.length,
          factsPendingApproval: facts.filter((fact) => !fact.approved).length,
        },
      });
    } catch (error) {
      if (!persisted) await documentStorage.delete(stored).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof DocumentStorageError) {
      const status = error.code === 'SCAN_UNAVAILABLE' || error.code === 'STORAGE_UNAVAILABLE' ? 503 : 400;
      return res.status(status).json({ success: false, error: error.message });
    }
    console.error('Resume upload error:', error);
    return res.status(500).json({ success: false, error: 'Failed to upload resume' });
  }
});

// GET /api/resumes - List resumes
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const resumes = await prisma.resume.findMany({
      where: { userId: req.user!.userId },
      select: {
        id: true,
        name: true,
        isMaster: true,
        fileName: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { sourceFacts: { where: { approved: false } } } },
        versions: {
          select: { id: true, company: true, role: true, atsScoreOverall: true, generatedAt: true },
          orderBy: { generatedAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, data: resumes });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch resumes' });
  }
});

// GET /api/resumes/:id/facts - List parsed facts with exact citations
router.get('/:id/facts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const resume = await prisma.resume.findFirst({ where: { id: req.params.id, userId: req.user!.userId }, select: { id: true } });
    if (!resume) return res.status(404).json({ success: false, error: 'Resume not found' });
    const facts = await listResumeCandidateFacts(resume.id, req.user!.userId);
    return res.json({ success: true, data: facts });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to fetch candidate facts' });
  }
});

// POST /api/resumes/:id/facts/:factId/decision - Approve or reject one parsed fact
router.post('/:id/facts/:factId/decision', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const decision = req.body?.decision;
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      return res.status(400).json({ success: false, error: 'decision must be APPROVE or REJECT' });
    }
    const fact = await decideResumeCandidateFact({
      resumeId: req.params.id,
      factId: req.params.factId,
      userId: req.user!.userId,
      decision,
    });
    return res.json({ success: true, data: fact, rejected: decision === 'REJECT' });
  } catch (error) {
    if (error instanceof CandidateFactError) {
      return res.status(error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400)
        .json({ success: false, error: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to record candidate fact decision' });
  }
});

// POST /api/resumes/:id/tailor - Queue a truthful, fact-cited tailored resume.
router.post('/:id/tailor', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const resumeId = req.params.id.trim();
    const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId.trim() : '';
    if (!resumeId || !jobId) return res.status(400).json({ success: false, error: 'resume and job identifiers are required' });
    const [resume, job] = await Promise.all([
      prisma.resume.findFirst({ where: { id: resumeId, userId: req.user!.userId }, select: { id: true } }),
      prisma.job.findUnique({ where: { id: jobId }, select: { id: true } }),
    ]);
    if (!resume || !job) return res.status(404).json({ success: false, error: 'Resume or job not found' });
    const queued = await createAutomationJob({
      userId: req.user!.userId,
      type: 'TAILOR_RESUME',
      payload: { resumeId, jobId },
      payloadVersion: 1,
      correlationId: `${resumeId}:${jobId}`,
      idempotencyKey: `tailor-resume:${req.user!.userId}:${resumeId}:${jobId}`,
      maxAttempts: 3,
    });
    return res.status(queued.replayed ? 200 : 202).json({ success: true, data: { id: queued.id, status: queued.status, replayed: queued.replayed } });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to queue resume tailoring' });
  }
});

// POST /api/resumes/:id/versions/:versionId/evaluate-ats - Queue deterministic ATS evaluation.
router.post('/:id/versions/:versionId/evaluate-ats', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const resumeId = req.params.id.trim();
    const resumeVersionId = req.params.versionId.trim();
    if (!resumeId || !resumeVersionId) return res.status(400).json({ success: false, error: 'resume and version identifiers are required' });
    const version = await prisma.resumeVersion.findFirst({
      where: { id: resumeVersionId, resumeId, resume: { userId: req.user!.userId } },
      select: { id: true },
    });
    if (!version) return res.status(404).json({ success: false, error: 'Resume version not found' });
    const queued = await createAutomationJob({
      userId: req.user!.userId,
      type: 'EVALUATE_ATS',
      payload: { resumeVersionId },
      payloadVersion: 1,
      correlationId: resumeVersionId,
      idempotencyKey: `evaluate-ats:${req.user!.userId}:${resumeVersionId}`,
      maxAttempts: 3,
    });
    return res.status(queued.replayed ? 200 : 202).json({ success: true, data: { id: queued.id, status: queued.status, replayed: queued.replayed } });
  } catch {
    return res.status(500).json({ success: false, error: 'Failed to queue ATS evaluation' });
  }
});

router.get('/:id/download', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const resume = await prisma.resume.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: { objectMetadata: { select: { bucket: true, objectKey: true, versionId: true, fileName: true, mimeType: true, scanStatus: true, deletedAt: true } } },
    });
    const object = resume?.objectMetadata;
    if (!object || object.scanStatus !== 'CLEAN' || object.deletedAt) return res.status(404).json({ success: false, error: 'Resume document not found' });
    const url = await documentStorage.signedDownloadUrl(object);
    return res.json({ success: true, data: { url, expiresInSeconds: 300 } });
  } catch (error) {
    if (error instanceof DocumentStorageError) return res.status(503).json({ success: false, error: error.message });
    return res.status(500).json({ success: false, error: 'Failed to prepare resume download' });
  }
});

// GET /api/resumes/:id - Get resume detail
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const resume = await prisma.resume.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        versions: { orderBy: { generatedAt: 'desc' } },
      },
    });
    if (!resume) {
      return res.status(404).json({ success: false, error: 'Resume not found' });
    }
    // Don't send rawFile in response
    const { rawFile, ...resumeData } = resume;
    return res.json({ success: true, data: resumeData });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch resume' });
  }
});

// GET /api/resumes/:id/versions - List versions
router.get('/:id/versions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const versions = await prisma.resumeVersion.findMany({
      where: {
        resumeId: req.params.id,
        resume: { userId: req.user!.userId },
      },
      orderBy: { generatedAt: 'desc' },
    });
    return res.json({ success: true, data: versions });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch versions' });
  }
});

export { router as resumeRoutes };
