import { afterEach, describe, expect, it } from 'vitest';
import { getAIProvider, OpenAIProvider } from './provider';

describe('AI provider configuration', () => {
  afterEach(() => {
    delete process.env.AI_API_KEY;
    delete process.env.AI_PROVIDER;
  });

  it('normalizes whitespace and case consistently with production startup validation', () => {
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = '  OpenAI  ';
    expect(getAIProvider()).toBeInstanceOf(OpenAIProvider);
  });
});
