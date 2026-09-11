import { randomUUID } from 'node:crypto';
import { JobAnalysisAgent, JobAnalysisResult } from './job-analysis';
import { MatchingAgent, MatchScoreResult, ProfileForMatching, JobForMatching } from './matching';
import type { TailoredResumeResult } from './resume-tailoring';
import type { ATSAnalysisResult } from './ats-analyzer';

import { CoverLetterAgent, CoverLetterResult } from './cover-letter';
import { QuestionAnswerAgent, QuestionClassification } from './question-answerer';

export interface PipelineResult {
  runId: string;
  jobId: string;
  analysis?: JobAnalysisResult;
  matchScore?: MatchScoreResult;
  tailoredResume?: TailoredResumeResult;
  atsScore?: ATSAnalysisResult;
  coverLetter?: CoverLetterResult;
  questionAnswers?: QuestionClassification[];
  errors: Array<{ step: string; error: string }>;
  completedSteps: string[];
}

export class SupervisorAgent {
  private jobAnalysis = new JobAnalysisAgent();
  private matching = new MatchingAgent();
  private coverLetter = new CoverLetterAgent();
  private questionAnswerer = new QuestionAnswerAgent();

  async runPipeline(
    job: { id: string; title: string; description: string; company: string; skills: string[]; requirements: string[]; location?: string; remoteType?: string; seniority?: string; experienceMin?: number; experienceMax?: number; salaryMin?: number; salaryMax?: number; employmentType?: string },
    profile: ProfileForMatching,
    masterResume: string,
    profileData: Record<string, unknown>,
    options: { generateCoverLetter?: boolean; minMatchScore?: number; minATSScore?: number; atsThreshold?: number } = {}
  ): Promise<PipelineResult> {
    const runId = randomUUID();
    const result: PipelineResult = {
      runId,
      jobId: job.id,
      errors: [],
      completedSteps: [],
    };

    // Step 1: Analyze JD
    try {
      result.analysis = (await this.jobAnalysis.analyze(job.title, job.description, job.company)).analysis;
      result.completedSteps.push('JD_ANALYSIS');
    } catch (error) {
      result.errors.push({ step: 'JD_ANALYSIS', error: String(error) });
      return result; // Can't continue without analysis
    }

    // Step 2: Calculate match
    try {
      const jobForMatching: JobForMatching = {
        title: job.title,
        company: job.company,
        location: job.location,
        remoteType: job.remoteType,
        requirements: job.requirements,
        skills: job.skills,
        seniority: job.seniority,
        experienceMin: job.experienceMin,
        experienceMax: job.experienceMax,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        employmentType: job.employmentType,
        description: job.description,
      };
      result.matchScore = await this.matching.calculateMatch(profile, jobForMatching);
      result.completedSteps.push('MATCHING');

      // Check minimum match score
      if (options.minMatchScore !== undefined && result.matchScore.overall < options.minMatchScore) {
        return result; // Skip if below threshold
      }
    } catch (error) {
      result.errors.push({ step: 'MATCHING', error: String(error) });
      return result;
    }

    // Resume tailoring is intentionally delegated to the durable API workflow. That workflow
    // loads tenant-scoped approved facts and verifies every generated claim before persistence.
    result.errors.push({
      step: 'RESUME_TAILORING',
      error: 'Resume tailoring requires durable approved candidate facts',
    });

    // ATS analysis can run only against a claim-verified durable resume version.

    // Step 5: Cover letter (optional)
    if (options.generateCoverLetter) {
      try {
        const profileSummary = (profileData as any)?.professionalProfile?.professionalSummary || '';
        const experience = (profileData as any)?.experience?.map((e: any) =>
          `${e.position} at ${e.company}: ${e.achievements?.join(', ') || ''}`
        ).join('\n') || '';

        result.coverLetter = await this.coverLetter.generate(
          profileSummary,
          experience,
          job.title,
          job.description,
          job.company
        );
        result.completedSteps.push('COVER_LETTER');
      } catch (error) {
        result.errors.push({ step: 'COVER_LETTER', error: String(error) });
      }
    }

    return result;
  }

  async answerQuestions(
    questions: string[],
    profileData: Record<string, unknown>
  ): Promise<QuestionClassification[]> {
    const results: QuestionClassification[] = [];
    for (const question of questions) {
      try {
        const result = await this.questionAnswerer.classifyAndAnswer(question, profileData);
        results.push(result);
      } catch (error) {
        results.push({
          question,
          riskLevel: 'HIGH_RISK',
          answer: null,
          source: null,
          confidence: 0,
          requiresHuman: true,
          reasoning: `Error classifying question: ${error}`
        });
      }
    }
    return results;
  }
}
