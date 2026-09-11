import { describe, expect, it, vi } from 'vitest';

const page = { locator: vi.fn(), waitForLoadState: vi.fn(async () => undefined) };
vi.mock('playwright', () => ({}));
import { LeverPlaywrightFormPort } from './lever-form-port';

describe('LeverPlaywrightFormPort', () => {
  it('maps a Lever fixture into normalized generic fields', async () => {
    const controls = [
      { tagName: 'INPUT', type: 'text', name: 'full_name', id: 'full_name', required: true, getAttribute: vi.fn(() => null), closest: vi.fn(() => null) },
      { tagName: 'SELECT', type: '', name: 'location', id: 'location', required: false, options: [{ value: '', text: 'Choose' }, { value: 'remote', text: 'Remote' }], getAttribute: vi.fn(() => null), closest: vi.fn(() => null) },
    ];
    const fields = { evaluateAll: vi.fn(async (mapper: (elements: typeof controls) => unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null }, configurable: true });
      try { return mapper(controls); } finally { Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true }); }
    }) };
    const next = { count: vi.fn(async () => 0) };
    const buttons = { count: vi.fn(async () => 0) };
    const step = { first: vi.fn(() => ({ getAttribute: vi.fn(async () => '3') })) };
    page.locator.mockImplementation((selector: string) => selector.includes('input[name]') ? fields : selector.includes('button:not([disabled]):has-text') ? buttons : step);

    await expect(new LeverPlaywrightFormPort(page as never).snapshot()).resolves.toEqual({
      step: 3,
      hasNextStep: false,
      fields: [
        expect.objectContaining({ id: 'full_name', kind: 'TEXT', required: true }),
        expect.objectContaining({ id: 'location', kind: 'SELECT', options: ['Remote'] }),
      ],
    });
  });

  it('does not recognize a final submit control as a next-step control', async () => {
    const fields = { evaluateAll: vi.fn(async () => []) };
    const buttons = { count: vi.fn(async () => 0) };
    const step = { first: vi.fn(() => ({ getAttribute: vi.fn(async () => null) })) };
    page.locator.mockImplementation((selector: string) => selector.includes('input[name]') ? fields : selector.includes('button:not([disabled]):has-text') ? buttons : step);

    await expect(new LeverPlaywrightFormPort(page as never).snapshot()).resolves.toMatchObject({ hasNextStep: false });
    expect(page.locator).not.toHaveBeenCalledWith('button[type="submit"], input[type="submit"]');
  });
});
