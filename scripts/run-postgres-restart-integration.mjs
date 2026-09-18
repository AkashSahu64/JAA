import { spawnSync } from 'node:child_process';

const dockerBin = 'C:\\Program Files\\Docker\\Docker\\resources\\bin';
const docker = process.env.DOCKER_BIN ?? `${dockerBin}\\docker.exe`;
const env = { ...process.env, DATABASE_INTEGRATION: '1' };
if (process.platform === 'win32') env.PATH = `${dockerBin};${env.PATH ?? ''}`;

function run(args, options = {}) {
  const result = spawnSync(docker, args, { ...options, env });
  if (result.error) throw result.error;
  return result;
}

const reachable = run(['info'], { stdio: 'ignore' });
if (reachable.status !== 0) {
  console.error('GATED: PostgreSQL restart integration requires a reachable Docker daemon; no integration tests were run.');
  process.exit(2);
}

const compose = ['compose', '-f', 'compose.yaml'];
const restarted = run([...compose, 'restart', 'postgres'], { stdio: 'inherit' });
if (restarted.status !== 0) process.exit(restarted.status ?? 1);

const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
  const result = run([...compose, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'jobagent', '-d', 'jobagent'], { stdio: 'ignore' });
  if (result.status === 0) {
    ready = true;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready) {
  console.error('PostgreSQL did not become ready after the disposable service restart.');
  process.exit(1);
}

const runner = new URL('./run-database-integration.mjs', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0);
const result = spawnSync(process.execPath, [runner], { stdio: 'inherit', env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
