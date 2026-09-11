import { spawnSync } from 'node:child_process';

const command = process.execPath;
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0);
const env = { ...process.env, DATABASE_INTEGRATION: '1' };
const dockerBin = 'C:\\Program Files\\Docker\\Docker\\resources\\bin';
env.PATH = process.platform === 'win32' ? `${dockerBin};${env.PATH ?? ''}` : env.PATH;
if (!env.DATABASE_URL) {
  env.DATABASE_URL = 'postgresql://jobagent:jobagent-local@localhost:5432/jobagent';
}
const result = spawnSync(
  command,
  [
    vitest,
    'run',
    'packages/database/src/foundation.integration.test.ts',
    'packages/database/src/discovery-hardening.integration.test.ts',
    'apps/api/src/services/application-state-machine.integration.test.ts',
    'apps/api/src/services/application-creation.integration.test.ts',
    'apps/api/src/services/human-verification.integration.test.ts',
    'apps/api/src/services/browser-session-manager.integration.test.ts',
    'apps/api/src/services/greenhouse-application.integration.test.ts',
    'apps/api/src/services/lever-application.integration.test.ts',
    'apps/api/src/services/outbox-idempotency.integration.test.ts',
    'apps/api/src/services/automation-jobs.integration.test.ts',
    'apps/api/src/services/automation-job-handlers.integration.test.ts',
    'apps/api/src/services/candidate-facts.integration.test.ts',
    'apps/api/src/services/document-storage.integration.test.ts',
    'apps/api/src/services/submission-engine.integration.test.ts',
    'apps/api/src/services/job-discovery.integration.test.ts',
    'apps/api/src/services/job-discovery.contract.test.ts',
  ],
  {
    stdio: 'inherit',
    env,
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
