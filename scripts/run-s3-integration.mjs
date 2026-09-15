import { spawnSync } from 'node:child_process';

const command = process.execPath;
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0);
const env = {
  ...process.env,
  S3_INTEGRATION: '1',
  S3_DOCUMENT_BUCKET: process.env.S3_DOCUMENT_BUCKET ?? 'jobagent-private-documents',
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'jobagent-local',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'jobagent-local-secret',
};

const dockerCheck = spawnSync('docker', ['info'], { stdio: 'ignore', env });
if (dockerCheck.error || dockerCheck.status !== 0) {
  console.error('GATED: S3 integration requires a reachable Docker daemon; no integration tests were run.');
  process.exit(2);
}

const compose = spawnSync('docker', ['compose', 'up', '-d', 'minio', 'minio-init'], { stdio: 'inherit', env });
if (compose.error) throw compose.error;
if (compose.status !== 0) process.exit(compose.status ?? 1);

const result = spawnSync(
  command,
  [vitest, 'run', 'apps/api/src/services/document-storage.s3.integration.test.ts'],
  { stdio: 'inherit', env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
