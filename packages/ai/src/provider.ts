import OpenAI from 'openai';

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AICompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

const DEFAULT_MAX_TOKENS = 4096;
const MAX_COMPLETION_TOKENS = 32_768;
const MAX_JSON_RESPONSE_LENGTH = 2_000_000;

export interface AIProvider {
  complete(messages: AIMessage[], options?: AICompletionOptions): Promise<string>;
  completeJSON<T>(messages: AIMessage[], options?: AICompletionOptions): Promise<T>;
}

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private defaultModel: string;

  constructor() {
    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) {
      throw new Error('AI_API_KEY environment variable is required');
    }
    this.client = new OpenAI({ apiKey });
    this.defaultModel = process.env.AI_MODEL || 'gpt-4o';
  }

  async complete(messages: AIMessage[], options: AICompletionOptions = {}): Promise<string> {
    if (messages.length === 0) throw new Error('At least one AI message is required');
    if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) {
      throw new RangeError('temperature must be between 0 and 2');
    }
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_COMPLETION_TOKENS) {
      throw new RangeError(`maxTokens must be an integer between 1 and ${MAX_COMPLETION_TOKENS}`);
    }

    const response = await this.client.chat.completions.create({
      model: options.model || this.defaultModel,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.3,
      max_tokens: maxTokens,
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('No response from AI provider');
    return content;
  }

  async completeJSON<T>(messages: AIMessage[], options: AICompletionOptions = {}): Promise<T> {
    const content = await this.complete(messages, { ...options, jsonMode: true });
    if (content.length > MAX_JSON_RESPONSE_LENGTH) {
      throw new Error('AI JSON response exceeded the allowed size');
    }
    try {
      return JSON.parse(content) as T;
    } catch {
      throw new Error('AI provider returned invalid JSON');
    }
  }
}

// Factory
let providerInstance: AIProvider | null = null;

export function getAIProvider(): AIProvider {
  if (!providerInstance) {
    const provider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
    switch (provider) {
      case 'openai':
        providerInstance = new OpenAIProvider();
        break;
      default:
        throw new Error(`Unsupported AI provider: ${provider}`);
    }
  }
  return providerInstance;
}
