import { describe, expect, it, vi } from 'vitest';

const page = {
  locator: vi.fn(),
  waitForLoadState: vi.fn(async () => undefined),
};

vi.mock('playwright', () => ({}));

import { GreenhousePlaywrightFormPort } from './greenhouse-form-port';

describe('GreenhousePlaywrightFormPort', () => {
  it('maps a captured Greenhouse fixture into normalized safe fields', async () => {
    const controls = [
      { tagName: 'INPUT', type: 'text', name: 'first_name', id: 'first_name', required: true, getAttribute: vi.fn(attribute => attribute === 'autocomplete' ? 'given-name' : null), closest: vi.fn(() => null) },
      { tagName: 'INPUT', type: 'file', name: 'resume', id: 'resume', required: true, getAttribute: vi.fn(() => null), closest: vi.fn(() => null) },
      { tagName: 'SELECT', type: '', name: 'work_authorization', id: 'work_authorization', required: true, options: [{ value: '', text: 'Select' }, { value: 'yes', text: 'Yes' }], getAttribute: vi.fn(() => null), closest: vi.fn(() => null) },
    ];
    const fieldsLocator = { evaluateAll: vi.fn(async (mapper: (elements: typeof controls) => unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null }, configurable: true });
      try { return mapper(controls); } finally { Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true }); }
    }) };
    const nextLocator = { count: vi.fn(async () => 0) };
    const buttonBaseLocator = { count: vi.fn(async () => 0) };
    const stepLocator = { first: vi.fn(() => ({ getAttribute: vi.fn(async () => '2') })) };
    page.locator.mockImplementation((selector: string) => {
      if (selector.includes('input[name]')) return fieldsLocator;
      if (selector.includes('button:not([disabled]):has-text')) return buttonBaseLocator;
      return stepLocator;
    });

    const snapshot = await new GreenhousePlaywrightFormPort(page as never).snapshot();
    expect(snapshot).toEqual({
      step: 2,
      hasNextStep: false,
      fields: [
        expect.objectContaining({ id: 'first_name', kind: 'TEXT', required: true, autocomplete: 'given-name', enabled: true }),
        expect.objectContaining({ id: 'resume', kind: 'FILE', required: true }),
        expect.objectContaining({ id: 'work_authorization', kind: 'SELECT', options: ['Yes'] }),
      ],
    });
  });

  it('does not treat a final submit control as a next-step control', async () => {
    const fieldsLocator = { evaluateAll: vi.fn(async () => []) };
    const finalSubmitLocator = { count: vi.fn(async () => 0) };
    const stepLocator = { first: vi.fn(() => ({ getAttribute: vi.fn(async () => null) })) };
    page.locator.mockImplementation((selector: string) => {
      if (selector.includes('input[name]')) return fieldsLocator;
      if (selector.includes('button:not([disabled]):has-text')) return finalSubmitLocator;
      return stepLocator;
    });

    await expect(new GreenhousePlaywrightFormPort(page as never).snapshot())
      .resolves.toMatchObject({ hasNextStep: false });
    expect(page.locator).not.toHaveBeenCalledWith('button[type="submit"], input[type="submit"]');
  });
});
