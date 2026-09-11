import { getAIProvider, AIMessage } from '../provider';

export interface ATSAnalysisResult {
  overall: number;
  keywordAlignment: number;
  requiredSkillCoverage: number;
  jobTitleAlignment: number;
  experienceRelevance: number;
  formattingCompatibility: number;
  sectionDetection: number;
  parsingSafety: number;
  quantifiableAchievements: number;
  readabilityScore: number;
  issues: Array<{
    type: string;
    severity: 'critical' | 'warning' | 'info';
    message: string;
    location?: string;
    suggestion?: string;
  }>;
  recommendations: string[];
}

export class ATSAnalyzerAgent {
  async analyze(
    resumeContent: string,
    jobTitle: string,
    jobDescription: string,
    requiredSkills: string[]
  ): Promise<ATSAnalysisResult> {
    const ai = getAIProvider();

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: `You are an ATS (Applicant Tracking System) compatibility analyzer. Analyze a resume against a job description and score its ATS compatibility.

Scoring weights:
- Keyword alignment: 30%
- Required skill coverage: 20%
- Job title alignment: 10%
- Experience relevance: 10%
- Formatting compatibility: 10%
- Section detection: 5%
- Parsing safety: 5%
- Quantifiable achievements: 5%
- Readability/content quality: 5%

Detect issues:
- Missing keywords
- Keyword stuffing
- Missing required skills
- Missing job title match
- Tables that parse poorly
- Multi-column risks
- Missing standard sections (Contact, Experience, Education, Skills)
- Contact info issues
- Inconsistent dates
- Poor readability

Label this as an INTERNAL ESTIMATED SCORE, not a guarantee.

Return valid JSON matching the ATSAnalysisResult schema. Score each dimension 0-100.`
      },
      {
        role: 'user',
        content: `JOB:
Title: ${jobTitle}
Required Skills: ${requiredSkills.join(', ')}

Job Description:
${jobDescription.slice(0, 3000)}

RESUME:
${resumeContent}`
      }
    ];

    return ai.completeJSON<ATSAnalysisResult>(messages, { temperature: 0.1 });
  }
}
