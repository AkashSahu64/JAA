import type { Locator, Page } from 'playwright';
import type { GreenhouseFormPort, GreenhouseFormSnapshot } from '@jobagent/job-engine';

const greenhouseFieldSelector = 'input[name], input[id], textarea[name], textarea[id], select[name], select[id]';

function text(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function fieldKind(tagName: string, type: string): 'TEXT' | 'TEXTAREA' | 'SELECT' | 'CHECKBOX' | 'FILE' | 'HIDDEN' {
  if (tagName === 'TEXTAREA') return 'TEXTAREA';
  if (tagName === 'SELECT') return 'SELECT';
  if (type === 'checkbox') return 'CHECKBOX';
  if (type === 'file') return 'FILE';
  if (type === 'hidden') return 'HIDDEN';
  return 'TEXT';
}

function selectorFor(fieldId: string): string {
  const value = JSON.stringify(fieldId);
  return `[name=${value}], [id=${value}]`;
}

export class GreenhousePlaywrightFormPort implements GreenhouseFormPort {
  constructor(private readonly page: Page) {}

  async snapshot(): Promise<GreenhouseFormSnapshot> {
    const fields = await this.page.locator(greenhouseFieldSelector).evaluateAll(elements => elements.map(element => {
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const tagName = control.tagName;
      const type = tagName === 'INPUT' ? (control as HTMLInputElement).type.toLowerCase() : '';
      const id = control.name || control.id;
      const name = control.name || control.id;
      const label = control.id
        ? document.querySelector(`label[for=${JSON.stringify(control.id)}]`)?.textContent
        : control.closest('label')?.textContent;
      const options = tagName === 'SELECT'
        ? [...(control as HTMLSelectElement).options].filter(option => option.value).map(option => option.text.trim())
        : undefined;
      return {
        id,
        name,
        label: label?.trim() || control.getAttribute('aria-label')?.trim() || name,
        kind: fieldKind(tagName, type),
        required: control.required || control.getAttribute('aria-required') === 'true',
        enabled: !control.disabled,
        options,
        autocomplete: control.getAttribute('autocomplete')?.trim() || undefined,
      };
    }).filter(field => Boolean(field.id)));
    const hasNextStep = await this.nextStepButton().count() > 0;
    return { step: await this.currentStep(), fields, hasNextStep };
  }

  async fill(fieldId: string, value: string): Promise<void> {
    await this.control(fieldId).fill(value);
  }

  async select(fieldId: string, value: string): Promise<void> {
    await this.control(fieldId).selectOption({ label: value }).catch(async () => {
      await this.control(fieldId).selectOption(value);
    });
  }

  async setChecked(fieldId: string, checked: boolean): Promise<void> {
    await this.control(fieldId).setChecked(checked);
  }

  async validate(): Promise<readonly { fieldId?: string; message: string }[]> {
    return this.page.locator('[aria-invalid="true"], .field-error, .error-message')
      .evaluateAll(elements => elements.map(element => ({
        fieldId: element.getAttribute('data-field') ?? element.closest('[data-field]')?.getAttribute('data-field') ?? undefined,
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

  private nextStepButton(): Locator {
    return this.page.locator([
      'button:not([disabled]):has-text("Next")',
      'button:not([disabled]):has-text("Continue")',
      'input[type="submit"][value="Next"]:not([disabled])',
      'input[type="submit"][value="Continue"]:not([disabled])',
    ].join(', '));
  }

  private async currentStep(): Promise<number> {
    const value = await this.page.locator('[data-step], [aria-current="step"]').first().getAttribute('data-step').catch(() => null);
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  }
}
