import { getAIProvider, AIMessage } from '../provider';

export interface CoverLetterResult {
  content: string;
  style: 'SHORT' | 'STANDARD' | 'HIGHLY_PERSONALIZED';
}

export class CoverLetterAgent {
  async generate(
    profileSummary: string,
    experience: string,
    jobTitle: string,
    jobDescription: string,
    company: string,
    style: 'SHORT' | 'STANDARD' | 'HIGHLY_PERSONALIZED' = 'STANDARD'
  ): Promise<CoverLetterResult> {
    const ai = getAIProvider();

    const lengthGuidance = {
      SHORT: '150-200 words, concise and to the point',
      STANDARD: '250-350 words, balanced detail',
      HIGHLY_PERSONALIZED: '350-500 words, deeply personalized with company research'
    };

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: `You are a professional cover letter writer. Create a compelling, authentic cover letter.

Rules:
- NEVER fabricate experience or skills
- Avoid generic AI-sounding language
- Be specific about how the candidate's background matches the role
- Reference actual experience from the profile
- Show genuine interest in the company and role
- Length: ${lengthGuidance[style]}

Return JSON: { "content": "the cover letter text", "style": "${style}" }`
      },
      {
        role: 'user',
        content: `Company: ${company}
Position: ${jobTitle}

Job Description:
${jobDescription.slice(0, 2000)}

Candidate Summary:
${profileSummary}

Relevant Experience:
${experience}`
      }
    ];

    return ai.completeJSON<CoverLetterResult>(messages, { temperature: 0.5 });
  }
}
