/**
 * Provider-neutral application orchestration surface.
 *
 * Provider adapters own page/form behavior; this module is the stable API
 * consumed by provider entry points. The implementation remains shared so
 * policy, document authorization, verification, and audit behavior cannot
 * drift between providers.
 */
export {
  ProviderApplicationService,
  type ExecuteProviderApplicationInput,
  type ProviderApplicationOutcome,
} from './greenhouse-application';
