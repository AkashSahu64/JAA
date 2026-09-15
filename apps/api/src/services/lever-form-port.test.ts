import { describe, expect, it, vi } from 'vitest';

const page = { locator: vi.fn(), waitForLoadState: vi.fn(async () => undefined) };
vi.mock('playwright', () => ({}));
import { LeverPlaywrightFormPort } from './lever-form-port';

describe('LeverPlaywrightFormPort', () => {
  it('maps a Lever fixture into normalized generic fields', async () => {
    const controls = [
      { tagName: 'INPUT', type: 'text', name: 'full_name', id: 'full_name', required: true, getAttribute: vi.fn((name: string) => name === 'data-field' ? 'candidate-name' : name === 'aria-label' ? 'Candidate full name' : null), closest: vi.fn(() => null) },
      { tagName: 'SELECT', type: '', name: 'location', id: 'location', required: false, options: [{ value: '', text: 'Choose' }, { value: 'remote', text: 'Remote' }], getAttribute: vi.fn(() => null), closest: vi.fn(() => null) },
    ];
    const fields = { evaluateAll: vi.fn(async (mapper: (elements: typeof controls) => unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null, getElementById: () => null }, configurable: true });
      try { return mapper(controls); } finally { Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true }); }
    }) };
    const next = { count: vi.fn(async () => 0) };
    const buttons = { count: vi.fn(async () => 0) };
    const step = { first: vi.fn(() => ({ getAttribute: vi.fn(async () => '3') })) };
    page.locator.mockImplementation((selector: string) => selector.includes('input[name]') ? fields : selector.includes('button:not([disabled]):has-text') ? buttons : step);

    await expect(new LeverPlaywrightFormPort(page as never).snapshot()).resolves.toMatchObject({
      provider: 'LEVER',
      step: 3,
      stepIdentity: 'lever-step-3',
      hasNextStep: false,
      fields: [
        expect.objectContaining({ id: 'full_name', kind: 'TEXT', required: true, inputType: 'text', semanticKey: 'candidate-name', accessibleName: 'Candidate full name' }),
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

  it('checks a native radio option when selectOption is unsupported', async () => {
    const select = { selectOption: vi.fn().mockRejectedValue(new Error('not a select')), getAttribute: vi.fn(async () => null) };
    const radio = { check: vi.fn(async () => undefined) };
    page.locator.mockImplementation((selector: string) => selector.includes('input[type="radio"]') ? radio : select);
    await new LeverPlaywrightFormPort(page as never).select('authorization', 'Yes');
    expect(radio.check).toHaveBeenCalledOnce();
  });

  it('transports the exact approved document payload to Lever file controls', async () => {
    const control = { setInputFiles: vi.fn(async () => undefined) };
    page.locator.mockImplementation(() => control);
    await new LeverPlaywrightFormPort(page as never).uploadDocument('resume', {
      fileName: 'approved-resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64), bytes: new Uint8Array([37, 80, 68, 70]),
    });
    expect(control.setInputFiles).toHaveBeenCalledWith(expect.objectContaining({ name: 'approved-resume.pdf', mimeType: 'application/pdf' }));
    const payload = (control.setInputFiles.mock.calls as unknown as Array<[{ buffer: Uint8Array }]>)[0]![0];
    expect(Buffer.from(payload.buffer).toString('ascii')).toBe('%PDF');
  });

  it('selects an approved value from a custom ARIA combobox', async () => {
    const option = { count: vi.fn(async () => 1), click: vi.fn(async () => undefined) };
    const filter = vi.fn((_criteria: { hasText?: RegExp }) => ({ first: vi.fn(() => option) }));
    const control = {
      selectOption: vi.fn().mockRejectedValue(new Error('not a native select')),
      getAttribute: vi.fn(async (name: string) => name === 'role' ? 'combobox' : name === 'aria-controls' ? 'role-options' : null),
      click: vi.fn(async () => undefined),
    };
    page.locator.mockImplementation((selector: string) => selector.includes('role-options') ? { filter } : control);
    await new LeverPlaywrightFormPort(page as never).select('role-choice', 'Engineer');
    expect(control.click).toHaveBeenCalledOnce();
    expect(option.click).toHaveBeenCalledOnce();
    const matcher = filter.mock.calls[0]?.[0]?.hasText;
    expect(matcher).toBeInstanceOf(RegExp);
    expect((matcher as RegExp).test('Engineer')).toBe(true);
    expect((matcher as RegExp).test('Senior Engineer')).toBe(false);
  });

  it('extracts a custom ARIA combobox and its rendered options', async () => {
    const controls = [{
      tagName: 'DIV', type: '', name: '', id: 'role-choice', required: true,
      getAttribute: vi.fn((name: string) => name === 'role' ? 'combobox' : name === 'data-field' ? 'target-role' : name === 'aria-controls' ? 'role-options' : null),
      closest: vi.fn(() => null),
    }];
    const fields = { evaluateAll: vi.fn(async (mapper: (elements: typeof controls) => unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null, getElementById: () => null, querySelectorAll: () => [{ textContent: 'Engineer' }, { textContent: 'Designer' }] }, configurable: true });
      try { return mapper(controls); } finally { Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true }); }
    }) };
    const step = { first: vi.fn(() => ({ getAttribute: vi.fn(async () => null) })) };
    page.locator.mockImplementation((selector: string) => selector.includes('input[name]') ? fields
      : selector.includes('[data-step]') ? step : { count: vi.fn(async () => 0) });

    await expect(new LeverPlaywrightFormPort(page as never).snapshot()).resolves.toMatchObject({
      fields: [expect.objectContaining({ id: 'role-choice', name: 'role-choice', kind: 'COMBOBOX', semanticKey: 'target-role', options: ['Engineer', 'Designer'] })],
    });
  });

  it('marks hidden dynamic controls so shared intelligence can fail closed', async () => {
    const controls = [{
      tagName: 'INPUT', type: 'text', name: 'conditional', id: 'conditional', required: false,
      getAttribute: vi.fn((name: string) => name === 'aria-hidden' ? 'true' : null),
      getClientRects: vi.fn(() => [{ width: 0, height: 0 }]),
      closest: vi.fn(() => null),
    }];
    const fields = { evaluateAll: vi.fn(async (mapper: (elements: typeof controls) => unknown) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null, getElementById: () => null }, configurable: true });
      try { return mapper(controls); } finally { Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true }); }
    }) };
    const step = { first: vi.fn(() => ({ getAttribute: vi.fn(async () => null) })) };
    page.locator.mockImplementation((selector: string) => selector.includes('input[name]') ? fields
      : selector.includes('[data-step]') ? step : { count: vi.fn(async () => 0) });

    await expect(new LeverPlaywrightFormPort(page as never).snapshot()).resolves.toMatchObject({
      fields: [expect.objectContaining({ id: 'conditional', visible: false })],
    });
  });
});
