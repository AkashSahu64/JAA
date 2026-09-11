import { getAIProvider, AIMessage } from '../provider';

export type QuestionRiskLevel = 'SAFE' | 'PROFILE_DERIVED' | 'SENSITIVE' | 'HIGH_RISK';

export interface QuestionClassification {
  question: string;
  riskLevel: QuestionRiskLevel;
  answer: string | null;
  source: string | null;
  confidence: number;
  requiresHuman: boolean;
  reasoning: string;
}

const HIGH_RISK_PATTERNS = [
  'criminal', 'disability', 'race', 'gender', 'religion', 'national origin',
  'sexual orientation', 'veteran', 'pregnant', 'age discrimination',
  'security clearance', 'legal declaration', 'under oath', 'certify that',
  'i declare', 'i certify', 'penalty of perjury'
];

const SAFE_FIELD_MAP: Record<string, string> = {
  'full name': 'personalInfo.fullName',
  'name': 'personalInfo.fullName',
  'email': 'personalInfo.email',
  'phone': 'personalInfo.phone',
  'linkedin': 'personalInfo.linkedIn',
  'github': 'personalInfo.github',
  'portfolio': 'personalInfo.portfolio',
  'website': 'personalInfo.portfolio',
};

export class QuestionAnswerAgent {
  async classifyAndAnswer(
    question: string,
    profileData: Record<string, unknown>
  ): Promise<QuestionClassification> {
    // Check for high-risk patterns first
    const lowerQuestion = question.toLowerCase();
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (lowerQuestion.includes(pattern)) {
        return {
          question,
          riskLevel: 'HIGH_RISK',
          answer: null,
          source: null,
          confidence: 0,
          requiresHuman: true,
          reasoning: `Question contains high-risk pattern: "${pattern}". Requires human review.`
        };
      }
    }

    // Check for direct safe field matches
    for (const [key, path] of Object.entries(SAFE_FIELD_MAP)) {
      if (lowerQuestion.includes(key)) {
        const value = getNestedValue(profileData, path);
        if (value) {
          return {
            question,
            riskLevel: 'SAFE',
            answer: String(value),
            source: path,
            confidence: 0.95,
            requiresHuman: false,
            reasoning: `Direct profile field match: ${path}`
          };
        }
      }
    }

    // Use AI for more complex questions
    const ai = getAIProvider();
    const messages: AIMessage[] = [
      {
        role: 'system',
        content: `You are a job application question classifier. Given a question and a candidate profile, determine:

1. Risk level: SAFE, PROFILE_DERIVED, SENSITIVE, or HIGH_RISK
2. Whether the answer is available in the profile
3. The answer (if available and safe)
4. The source field in the profile
5. Confidence (0-1)
6. Whether human review is required

Rules:
- NEVER fabricate answers
- HIGH_RISK: legal declarations, criminal history, disability, demographics, salary expectations without configured preference
- SENSITIVE: work authorization details, visa specifics, relocation details
- PROFILE_DERIVED: can be answered from profile data
- SAFE: basic contact info, links, straightforward profile fields

Return JSON: { "riskLevel": "...", "answer": "..." or null, "source": "..." or null, "confidence": 0.0-1.0, "requiresHuman": true/false, "reasoning": "..." }`
      },
      {
        role: 'user',
        content: `Question: ${question}\n\nProfile Data:\n${JSON.stringify(profileData, null, 2).slice(0, 3000)}`
      }
    ];

    const result = await ai.completeJSON<{
      riskLevel: QuestionRiskLevel;
      answer: string | null;
      source: string | null;
      confidence: number;
      requiresHuman: boolean;
      reasoning: string;
    }>(messages, { temperature: 0.1 });

    return {
      question,
      ...result
    };
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((current: unknown, key: string) => {
    if (current && typeof current === 'object') {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
