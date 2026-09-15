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
      { tagName: 'INPUT', type: 'text', name: 'first_name', id: 'first_name', required: true, getAttribute: vi.fn(attribute => attribute === 'autocomplete' ? 'given-name' : attribute === 'aria-label' ? 'Candidate given name' : null), closest: vi.fn(() => null) },
      { tagName: 'INPUT', type: 'file', name: 'resume', id: 'resume', required: true, getAttribute: vi.fn(() => null), closest: vi.fn(() => null) },
      { tagName: 'SELECT', type: '', name: 'work_authorization', id: 'work_authorization', required: true, options: [{ value: '', text: 'Select' }, { value: 'yes', text: 'Yes' }], getAttribute: vi.fn(() => null), closest: vi.fn(() => null) },
    ];
    const fieldsLocator = { evaluateAll: vi.fn(async (mapper: (elements: typeof controls) => unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null, getElementById: () => null }, configurable: true });
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
    expect(snapshot).toMatchObject({
      provider: 'GREENHOUSE',
      step: 2,
      stepIdentity: 'greenhouse-step-2',
      hasNextStep: false,
      fields: [
        expect.objectContaining({ id: 'first_name', kind: 'TEXT', inputType: 'text', semanticKey: 'given-name', required: true, autocomplete: 'given-name', accessibleName: 'Candidate given name', enabled: true }),
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

  it('classifies native multiple selects for the shared multi-select capability', async () => {
    const controls = [{ tagName: 'SELECT', type: '', name: 'skills', id: 'skills', multiple: true, required: false,
      options: [{ value: 'ts', text: 'TypeScript' }, { value: 'sql', text: 'SQL' }],
      getAttribute: vi.fn(() => null), closest: vi.fn(() => null) }];
    const fieldsLocator = { evaluateAll: vi.fn(async (mapper: (elements: typeof controls) => unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null, getElementById: () => null }, configurable: true });
      try { return mapper(controls); } finally { Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true }); }
    }) };
    page.locator.mockImplementation((selector: string) => {
      if (selector.includes('input[name]')) return fieldsLocator;
      if (selector.includes('button:not([disabled])')) return { count: vi.fn(async () => 0) };
      return { first: vi.fn(() => ({ getAttribute: vi.fn(async () => null) })) };
    });
    await expect(new GreenhousePlaywrightFormPort(page as never).snapshot()).resolves.toMatchObject({
      fields: [expect.objectContaining({ id: 'skills', kind: 'MULTISELECT', options: ['TypeScript', 'SQL'] })],
    });
  });

  it('extracts grouped native radio values for safe option validation', async () => {
    const radio = { tagName: 'INPUT', type: 'radio', name: 'work_type', id: 'work_type_remote', value: 'remote', required: true,
      getAttribute: vi.fn(() => null), closest: vi.fn(() => null) };
    const otherRadio = { ...radio, id: 'work_type_hybrid', value: 'hybrid' };
    const controls = [radio, otherRadio];
    const fieldsLocator = { evaluateAll: vi.fn(async (mapper: (elements: typeof controls) => unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', { value: {
        querySelector: () => null, getElementById: () => null,
        querySelectorAll: () => [radio, otherRadio],
      }, configurable: true });
      try { return mapper(controls); } finally { Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true }); }
    }) };
    page.locator.mockImplementation((selector: string) => {
      if (selector.includes('input[name]')) return fieldsLocator;
      if (selector.includes('button:not([disabled])')) return { count: vi.fn(async () => 0) };
      return { first: vi.fn(() => ({ getAttribute: vi.fn(async () => null) })) };
    });
    await expect(new GreenhousePlaywrightFormPort(page as never).snapshot()).resolves.toMatchObject({
      fields: [expect.objectContaining({ id: 'work_type', kind: 'RADIO', options: ['remote', 'hybrid'] })],
    });
  });

  it('checks a native radio option when selectOption is unsupported', async () => {
    const select = { selectOption: vi.fn().mockRejectedValue(new Error('not a select')), getAttribute: vi.fn(async () => null) };
    const radio = { check: vi.fn(async () => undefined) };
    page.locator.mockImplementation((selector: string) => selector.includes('input[type="radio"]') ? radio : select);
    await new GreenhousePlaywrightFormPort(page as never).select('authorization', 'Yes');
    expect(radio.check).toHaveBeenCalledOnce();
  });

  it('preserves hidden dynamic-control state for shared fail-closed extraction', async () => {
    const controls = [{ tagName: 'INPUT', type: 'text', name: 'conditional', id: 'conditional', required: false,
      getAttribute: vi.fn((attribute: string) => attribute === 'aria-hidden' ? 'true' : null),
      getClientRects: vi.fn(() => [{ width: 0, height: 0 }]), closest: vi.fn(() => null) }];
    const fieldsLocator = { evaluateAll: vi.fn(async (mapper: (elements: typeof controls) => unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null, getElementById: () => null }, configurable: true });
      try { return mapper(controls); } finally { Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true }); }
    }) };
    page.locator.mockImplementation((selector: string) => selector.includes('input[name]') ? fieldsLocator
      : { first: vi.fn(() => ({ getAttribute: vi.fn(async () => null) })), count: vi.fn(async () => 0) });
    await expect(new GreenhousePlaywrightFormPort(page as never).snapshot()).resolves.toMatchObject({
      fields: [expect.objectContaining({ id: 'conditional', visible: false })],
    });
  });
});
