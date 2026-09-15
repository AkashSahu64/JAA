import type { LeverFormPort } from '@jobagent/job-engine';
import { LeverApplicationAdapter } from '@jobagent/job-engine';
import type { Page } from 'playwright';
import { ProviderApplicationService, type ExecuteProviderApplicationInput } from './provider-application';
import { LeverPlaywrightFormPort } from './lever-form-port';

type BrowserSessionPort = ConstructorParameters<typeof ProviderApplicationService>[0];
type LeverFormPortFactory = (page: Page) => LeverFormPort;

export type ExecuteLeverApplicationInput = Omit<ExecuteProviderApplicationInput, 'provider'>;

/**
 * Lever's trusted worker entry point. It reuses the generic fail-closed policy
 * workflow while retaining a provider-specific DOM port and host allowlist.
 */
export class LeverApplicationService {
  private readonly service: ProviderApplicationService;

  constructor(
    browserSessions?: BrowserSessionPort,
    formPort: LeverFormPortFactory = page => new LeverPlaywrightFormPort(page),
  ) {
    this.service = new ProviderApplicationService(
      browserSessions,
      page => formPort(page),
    );
  }

  async execute(input: ExecuteLeverApplicationInput): Promise<Awaited<ReturnType<ProviderApplicationService['execute']>>> {
    return this.service.execute({ ...input, provider: 'LEVER' });
  }
}

export { LeverApplicationAdapter };
