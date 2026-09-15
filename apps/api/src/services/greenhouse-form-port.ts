import type { Locator, Page } from 'playwright';
import type { GreenhouseFormPort, GreenhouseFormSnapshot } from '@jobagent/job-engine';

const greenhouseFieldSelector = 'input[name], input[id], textarea[name], textarea[id], select[name], select[id], [role="combobox"][name], [role="combobox"][id], [role="combobox"][data-field]';
const validationSelector = '[aria-invalid="true"], .field-error, .error-message, .errors, [role="alert"]';
function exactOptionText(value: string): RegExp {
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*$`);
}
const nextStepSelectors = [
  'button:not([disabled])[data-g-progression="next"]:visible',
  'button:not([disabled])[data-step-action="next"]:visible',
  'button:not([disabled]):has-text("Next"):visible',
  'button:not([disabled]):has-text("Continue"):visible',
  'input[type="submit"][value="Next"]:not([disabled]):visible',
  'input[type="submit"][value="Continue"]:not([disabled]):visible',
].join(', ');

function selectorFor(fieldId: string): string {
  const value = JSON.stringify(fieldId);
  return `[name=${value}], [id=${value}], [data-field=${value}]:is(input, textarea, select, [role="combobox"])`;
}

export class GreenhousePlaywrightFormPort implements GreenhouseFormPort {
  constructor(private readonly page: Page) {}

  async snapshot(): Promise<GreenhouseFormSnapshot> {
    const fields = await this.page.locator(greenhouseFieldSelector).evaluateAll(elements => elements.map(element => {
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const clean = (value: string | null | undefined) => value?.trim() ?? '';
      const tagName = control.tagName;
      const type = tagName === 'INPUT' ? (control as HTMLInputElement).type.toLowerCase() : '';
      const declaredName = control.getAttribute('name')?.trim() || '';
      const id = control.name || declaredName || control.id || control.getAttribute('data-field') || '';
      const name = control.name || declaredName || control.id || control.getAttribute('data-field') || '';
      const explicitLabel = control.id
        ? document.querySelector(`label[for=${JSON.stringify(control.id)}]`)?.textContent
        : undefined;
      const enclosingLabel = control.closest('label')?.textContent;
      const describedBy = (control.getAttribute('aria-describedby') ?? '').split(/\s+/)
        .filter(Boolean)
        .map(reference => document.getElementById(reference)?.textContent ?? '')
        .join(' ');
      const labelledBy = (control.getAttribute('aria-labelledby') ?? '').split(/\s+/)
        .filter(Boolean)
        .map(reference => document.getElementById(reference)?.textContent ?? '')
        .join(' ');
      const accessibleName = clean(labelledBy) || clean(control.getAttribute('aria-label')) || undefined;
      const fieldsetLabel = control.closest('fieldset')?.querySelector('legend')?.textContent;
      const multiple = tagName === 'SELECT' && (control as HTMLSelectElement).multiple;
      const radioGroup = type === 'radio'
        ? [...document.querySelectorAll('input[type="radio"]')].filter(candidate => (candidate as HTMLInputElement).name === id)
        : [];
      const currentValue = type === 'checkbox' ? (control as HTMLInputElement).checked
        : type === 'radio' ? (radioGroup.find(candidate => (candidate as HTMLInputElement).checked) as HTMLInputElement | undefined)?.value.trim() ?? ''
          : tagName === 'SELECT' ? [...(control as HTMLSelectElement).options].filter(option => option.selected).map(option => option.text.trim()).filter(Boolean)
            : clean(control.value);
      const isFirstRadio = type !== 'radio' || radioGroup[0] === control;
      const radioOptions = type === 'radio' ? radioGroup.map(candidate => (candidate as HTMLInputElement).value.trim()).filter(Boolean) : undefined;
      const options = tagName === 'SELECT'
        ? [...(control as HTMLSelectElement).options].filter(option => option.value).map(option => option.text.trim())
        : type === 'radio' ? radioOptions
          : control.getAttribute('role') === 'combobox'
          ? [...document.querySelectorAll(`[id=${JSON.stringify(control.getAttribute('aria-controls') ?? '')}] [role="option"]`)]
            .map(option => option.textContent?.trim() ?? '').filter(Boolean)
        : undefined;
      return {
        id: isFirstRadio ? id : '',
        name,
        label: type === 'radio' ? clean(fieldsetLabel) || clean(explicitLabel) || clean(enclosingLabel) || accessibleName || clean(describedBy) || name
          : clean(explicitLabel) || clean(enclosingLabel) || accessibleName || clean(fieldsetLabel) || clean(describedBy) || name,
        accessibleName,
        kind: (tagName === 'TEXTAREA' ? 'TEXTAREA'
          : multiple ? 'MULTISELECT'
            : tagName === 'SELECT' ? 'SELECT'
            : type === 'radio' ? 'RADIO'
              : type === 'checkbox' ? 'CHECKBOX'
                : type === 'file' ? 'FILE'
                : type === 'hidden' ? 'HIDDEN' : 'TEXT') as GreenhouseFormSnapshot['fields'][number]['kind'],
        inputType: type || undefined,
        required: control.required || control.getAttribute('aria-required') === 'true',
        enabled: !control.disabled,
        visible: control.getAttribute('aria-hidden') !== 'true'
          && control.getAttribute('hidden') === null
          && (typeof (element as Element).getClientRects !== 'function' || (element as Element).getClientRects().length > 0),
        options,
        currentValue,
        autocomplete: control.getAttribute('autocomplete')?.trim() || undefined,
        semanticKey: control.getAttribute('data-field')?.trim() || control.getAttribute('autocomplete')?.trim() || name,
      };
    }).filter(field => Boolean(field.id)));
    const hasNextStep = await this.nextStepButton().count() > 0;
    const step = await this.currentStep();
    return { provider: 'GREENHOUSE', step, stepIdentity: `greenhouse-step-${step}`, fields, hasNextStep };
  }

  async fill(fieldId: string, value: string): Promise<void> {
    await this.control(fieldId).fill(value);
  }

  async select(fieldId: string, value: string | readonly string[]): Promise<void> {
    const control = this.control(fieldId);
    const values = Array.isArray(value) ? value : [value];
    await control.selectOption(values.map(option => ({ label: option }))).catch(async () => {
      await control.selectOption(values).catch(async () => {
        if (await control.getAttribute('role') === 'combobox') {
          if (values.length !== 1) throw new Error('Greenhouse combobox selection requires one option');
          const controls = await control.getAttribute('aria-controls');
          if (!controls) throw new Error('Greenhouse combobox has no option list');
          const option = this.page.locator(`[id=${JSON.stringify(controls)}] [role="option"]`).filter({ hasText: exactOptionText(values[0]!) }).first();
          if (!await option.count()) throw new Error('Greenhouse combobox option was not found');
          await control.click();
          await option.click();
          return;
        }
        if (values.length !== 1) throw new Error('Greenhouse radio selection requires one option');
        await this.radioControl(fieldId, values[0]!).check();
      });
    });
  }

  async setChecked(fieldId: string, checked: boolean): Promise<void> {
    await this.control(fieldId).setChecked(checked);
  }

  async uploadDocument(fieldId: string, document: { fileName: string; mimeType: string; checksumSha256: string; bytes: Uint8Array }): Promise<void> {
    await this.control(fieldId).setInputFiles({ name: document.fileName, mimeType: document.mimeType, buffer: Buffer.from(document.bytes) });
  }

  async validate(): Promise<readonly { fieldId?: string; message: string }[]> {
    return this.page.locator(validationSelector)
      .evaluateAll(elements => elements.map(element => ({
        fieldId: element.getAttribute('data-field')
          ?? element.closest('[data-field]')?.getAttribute('data-field')
          ?? element.getAttribute('for')
          ?? undefined,
        message: element.textContent?.trim() ?? '',
      })).filter(error => error.message));
  }

  async advance(): Promise<void> {
    const next = this.nextStepButton();
    if (!await next.count()) throw new Error('Greenhouse form has no next-step control');
    await next.first().click();
    await this.page.waitForLoadState('domcontentloaded');
  }

  private control(fieldId: string): Locator {
    return this.page.locator(selectorFor(fieldId));
  }

  private radioControl(fieldId: string, value: string): Locator {
    const field = JSON.stringify(fieldId);
    const option = JSON.stringify(value);
    return this.page.locator(`input[type="radio"][name=${field}][value=${option}], input[type="radio"][id=${field}][value=${option}]`);
  }

  private nextStepButton(): Locator {
    return this.page.locator(nextStepSelectors);
  }

  private async currentStep(): Promise<number> {
    const locator = this.page.locator('[data-step], [aria-current="step"]');
    const step = locator.first();
    const count = 'count' in step && typeof step.count === 'function' ? await step.count() : 1;
    if (!count) return 1;
    const value = await step.getAttribute('data-step').catch(() => null);
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  }
}
