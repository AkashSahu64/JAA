import type { Locator, Page } from 'playwright';
import type { LeverFormPort, LeverFormSnapshot } from '@jobagent/job-engine';

const leverFieldSelector = 'input[name], input[id], textarea[name], textarea[id], select[name], select[id], [role="combobox"][name], [role="combobox"][id], [role="combobox"][data-field], [role="combobox"][aria-label], [role="combobox"][aria-labelledby]';

type FieldKind = 'TEXT' | 'TEXTAREA' | 'SELECT' | 'RADIO' | 'CHECKBOX' | 'FILE' | 'COMBOBOX' | 'MULTISELECT' | 'HIDDEN';

function exactOptionText(value: string): RegExp {
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*$`);
}

function fieldKind(tagName: string, type: string): FieldKind {
  if (tagName === 'TEXTAREA') return 'TEXTAREA';
  if (tagName === 'SELECT') return 'SELECT';
  if (type === 'radio') return 'RADIO';
  if (type === 'checkbox') return 'CHECKBOX';
  if (type === 'file') return 'FILE';
  if (type === 'hidden') return 'HIDDEN';
  return 'TEXT';
}

function selectorFor(fieldId: string): string {
  const value = JSON.stringify(fieldId);
  return `[name=${value}], [id=${value}], [data-field=${value}]:is(input, textarea, select, [role="combobox"])`;
}

export class LeverPlaywrightFormPort implements LeverFormPort {
  constructor(private readonly page: Page) {}

  async snapshot(): Promise<LeverFormSnapshot> {
    const fields = await this.page.locator(leverFieldSelector).evaluateAll(elements => elements.map(element => {
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const tagName = control.tagName;
      const type = tagName === 'INPUT' ? (control as HTMLInputElement).type.toLowerCase() : '';
      const declaredName = control.getAttribute('name')?.trim() || '';
      const ariaLabel = control.getAttribute('aria-label')?.trim() || '';
      const labelledBy = control.getAttribute('aria-labelledby');
      const ariaLabelledByText = labelledBy
        ? labelledBy.split(/\s+/).map(reference => document.getElementById(reference)?.textContent ?? '').join(' ').trim()
        : '';
      // Some Lever custom controls intentionally expose no name/id. Use their
      // accessible name as a semantic fallback; generic intelligence assigns
      // occurrence identity for duplicates, so this never depends on ordering.
      const semanticFallback = ariaLabel || ariaLabelledByText;
      const id = control.name || declaredName || control.id || control.getAttribute('data-field') || semanticFallback;
      const name = control.name || declaredName || control.id || control.getAttribute('data-field') || semanticFallback;
      const label = control.id
        ? document.querySelector(`label[for=${JSON.stringify(control.id)}]`)?.textContent
        : control.closest('label')?.textContent;
      const accessibleLabel = labelledBy
        ? ariaLabelledByText
        : undefined;
      const accessibleName = accessibleLabel?.trim() || ariaLabel || undefined;
      const multiple = tagName === 'SELECT' && (control as HTMLSelectElement).multiple;
      const radioGroup = type === 'radio'
        ? [...document.querySelectorAll('input[type="radio"]')].filter(candidate => (candidate as HTMLInputElement).name === id)
        : [];
      const currentValue = type === 'checkbox' ? (control as HTMLInputElement).checked
        : type === 'radio' ? (radioGroup.find(candidate => (candidate as HTMLInputElement).checked) as HTMLInputElement | undefined)?.value.trim() ?? ''
          : tagName === 'SELECT' ? [...(control as HTMLSelectElement).options].filter(option => option.selected).map(option => option.text.trim()).filter(Boolean)
            : typeof control.value === 'string' ? control.value.trim() : '';
      const role = control.getAttribute('role');
      const isFirstRadio = type !== 'radio' || radioGroup[0] === control;
      const radioOptions = type === 'radio' ? radioGroup.map(candidate => (candidate as HTMLInputElement).value.trim()).filter(Boolean) : undefined;
      return {
        id: isFirstRadio ? id : '',
        name,
        label: type === 'radio' ? control.closest('fieldset')?.querySelector('legend')?.textContent?.trim() || label?.trim() || accessibleName || name
          : label?.trim() || accessibleName || name,
        accessibleName,
        // Keep this classification inside the page callback: Playwright serializes
        // the callback and cannot capture the module-local fieldKind helper.
        kind: (multiple ? 'MULTISELECT' : role === 'combobox' ? 'COMBOBOX'
          : tagName === 'TEXTAREA' ? 'TEXTAREA'
            : tagName === 'SELECT' ? 'SELECT'
              : type === 'radio' ? 'RADIO'
                : type === 'checkbox' ? 'CHECKBOX'
                  : type === 'file' ? 'FILE'
                    : type === 'hidden' ? 'HIDDEN' : 'TEXT') as FieldKind,
        required: control.required || control.getAttribute('aria-required') === 'true',
        enabled: !control.disabled,
        visible: control.getAttribute('aria-hidden') !== 'true'
          && control.getAttribute('hidden') === null
          && (typeof (element as Element).getClientRects !== 'function' || (element as Element).getClientRects().length > 0),
        inputType: type || undefined,
        semanticKey: control.getAttribute('data-field')?.trim() || control.getAttribute('autocomplete')?.trim() || name,
        options: type === 'radio' ? radioOptions
          : tagName === 'SELECT'
          ? [...(control as HTMLSelectElement).options].filter(option => option.value).map(option => option.text.trim())
          : role === 'combobox'
            ? [...document.querySelectorAll(`[id=${JSON.stringify(control.getAttribute('aria-controls') ?? '')}] [role="option"]`)]
              .map(option => option.textContent?.trim() ?? '').filter(Boolean)
            : undefined,
        currentValue,
        autocomplete: control.getAttribute('autocomplete')?.trim() || undefined,
      };
    }).filter(field => Boolean(field.id)));
    const step = await this.currentStep();
    return { provider: 'LEVER', step, stepIdentity: `lever-step-${step}`, fields, hasNextStep: await this.nextStepButton().count() > 0 };
  }

  async fill(fieldId: string, value: string): Promise<void> { await this.control(fieldId).fill(value); }
  async select(fieldId: string, value: string | readonly string[]): Promise<void> {
    const values = Array.isArray(value) ? value : [value];
    const control = this.control(fieldId);
    await control.selectOption(values.map(option => ({ label: option }))).catch(async () => {
      await control.selectOption(values).catch(async () => {
        if (await control.getAttribute('role') === 'combobox') {
          if (values.length !== 1) throw new Error('Lever combobox selection requires one option');
          const controls = await control.getAttribute('aria-controls');
          if (!controls) throw new Error('Lever combobox has no option list');
          const option = this.page.locator(`[id=${JSON.stringify(controls)}] [role="option"]`).filter({ hasText: exactOptionText(values[0]!) }).first();
          if (!await option.count()) throw new Error('Lever combobox option was not found');
          await control.click();
          await option.click();
          return;
        }
        if (values.length !== 1) throw new Error('Lever radio selection requires one option');
        await this.radioControl(fieldId, values[0]!).check();
      });
    });
  }
  async setChecked(fieldId: string, checked: boolean): Promise<void> { await this.control(fieldId).setChecked(checked); }
  async uploadDocument(fieldId: string, document: { fileName: string; mimeType: string; checksumSha256: string; bytes: Uint8Array }): Promise<void> {
    await this.control(fieldId).setInputFiles({ name: document.fileName, mimeType: document.mimeType, buffer: Buffer.from(document.bytes) });
  }
  async validate(): Promise<readonly { fieldId?: string; message: string }[]> {
    return this.page.locator('[aria-invalid="true"], .field-error, .error-message').evaluateAll(elements => elements.map(element => {
      const direct = element.getAttribute('data-field') ?? element.closest('[data-field]')?.getAttribute('data-field');
      const errorId = element.id;
      const describedControl = errorId
        ? [...document.querySelectorAll('[aria-errormessage]')].find(control =>
          control.getAttribute('aria-errormessage')?.split(/\s+/).includes(errorId))
        : undefined;
      const control = describedControl as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
      const fieldId = direct ?? control?.name ?? control?.id ?? undefined;
      return { fieldId, message: element.textContent?.trim() ?? '' };
    }).filter(error => error.message));
  }
  async advance(): Promise<void> {
    const next = this.nextStepButton();
    if (!await next.count()) throw new Error('Lever form has no next-step control');
    await next.first().click();
    await this.page.waitForLoadState('domcontentloaded');
  }

  private control(fieldId: string): Locator { return this.page.locator(selectorFor(fieldId)); }
  private radioControl(fieldId: string, value: string): Locator {
    const field = JSON.stringify(fieldId);
    const option = JSON.stringify(value);
    return this.page.locator(`input[type="radio"][name=${field}][value=${option}], input[type="radio"][id=${field}][value=${option}]`);
  }
  private nextStepButton(): Locator {
    return this.page.locator([
      'button:not([disabled]):has-text("Next"):visible',
      'button:not([disabled]):has-text("Continue"):visible',
      'input[type="submit"][value="Next"]:not([disabled]):visible',
      'input[type="submit"][value="Continue"]:not([disabled]):visible',
    ].join(', '));
  }
  private async currentStep(): Promise<number> {
    const step = this.page.locator('[data-step], [aria-current="step"]').first();
    if (typeof step.count === 'function' && !await step.count()) return 1;
    const values = await Promise.all([
      step.getAttribute('data-step'),
      step.getAttribute('aria-posinset'),
      step.getAttribute('data-step-index'),
    ]);
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
    return 1;
  }
}
