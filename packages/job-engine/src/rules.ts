export interface RuleCondition {
  field: string;
  operator: 'gte' | 'lte' | 'eq' | 'neq' | 'contains' | 'not_contains' | 'in' | 'not_in';
  value: string | number | boolean | string[];
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  action: 'AUTO_APPLY' | 'SKIP' | 'REVIEW' | 'QUEUE';
  priority: number;
}

export interface RuleContext {
  matchScore?: number;
  atsScore?: number;
  jobTitle?: string;
  company?: string;
  location?: string;
  remoteType?: string;
  salaryMin?: number;
  salaryMax?: number;
  experienceRequired?: number;
  userExperience?: number;
  seniority?: string;
  hasCaptcha?: boolean;
  hasSensitiveQuestions?: boolean;
  [key: string]: unknown;
}

export class RulesEngine {
  private rules: Rule[] = [];

  setRules(rules: Rule[]): void {
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  evaluate(context: RuleContext): { action: string; matchedRule: Rule | null; allResults: Array<{ rule: Rule; matched: boolean }> } {
    const allResults: Array<{ rule: Rule; matched: boolean }> = [];
    
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      
      const matched = this.evaluateConditions(rule.conditions, context);
      allResults.push({ rule, matched });
      
      if (matched) {
        return { action: rule.action, matchedRule: rule, allResults };
      }
    }

    return { action: 'REVIEW', matchedRule: null, allResults };
  }

  private evaluateConditions(conditions: RuleCondition[], context: RuleContext): boolean {
    return conditions.every(condition => this.evaluateCondition(condition, context));
  }

  private evaluateCondition(condition: RuleCondition, context: RuleContext): boolean {
    const value = context[condition.field];
    if (value === undefined || value === null) return false;

    switch (condition.operator) {
      case 'gte':
        return Number(value) >= Number(condition.value);
      case 'lte':
        return Number(value) <= Number(condition.value);
      case 'eq':
        return value === condition.value;
      case 'neq':
        return value !== condition.value;
      case 'contains':
        return String(value).toLowerCase().includes(String(condition.value).toLowerCase());
      case 'not_contains':
        return !String(value).toLowerCase().includes(String(condition.value).toLowerCase());
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(String(value));
      case 'not_in':
        return Array.isArray(condition.value) && !condition.value.includes(String(value));
      default:
        return false;
    }
  }
}
