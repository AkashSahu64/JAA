#!/usr/bin/env node
/**
 * Database isolation gate.
 *
 * An integration suite that leaves fixture rows behind still reports green, so the
 * defect is invisible while the shared database grows on every run and the suite
 * slowly stops being reproducible. This gate makes that visible: it snapshots the
 * row count of every table, runs the database integration suite, and fails if any
 * table changed.
 *
 * Deletion-only cleanup passes. A suite that removes rows it did not create, or that
 * depends on rows a previous run left behind, is reported rather than tolerated.
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const POSTGRES_CONTAINER = process.env.POSTGRES_CONTAINER ?? 'job-application-agent-postgres-1';
const POSTGRES_USER = process.env.POSTGRES_USER ?? 'jobagent';
const POSTGRES_DB = process.env.POSTGRES_DB ?? 'jobagent';

function psql(statement) {
  const result = spawnSync(
    'docker',
    ['exec', POSTGRES_CONTAINER, 'psql', '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-X', '-q', '-At', '-c', statement],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'psql failed').trim());
  return result.stdout.trim();
}

async function endpointReachable(host, port, timeout = 1_500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeout, () => finish(false));
  });
}

function snapshot() {
  const tables = psql("select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations' order by tablename")
    .split('\n').filter(Boolean);
  if (!tables.length) throw new Error('No tables found; is the database migrated?');
  const union = tables.map(table => `select '${table}='||count(*) from "${table}"`).join(' union all ');
  const counts = new Map();
  for (const line of psql(union).split('\n')) {
    const index = line.lastIndexOf('=');
    counts.set(line.slice(0, index), Number(line.slice(index + 1)));
  }
  return counts;
}

const databaseUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://jobagent:jobagent-local@localhost:5432/jobagent');
const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
if (docker.error || docker.status !== 0 || !(await endpointReachable(databaseUrl.hostname, Number(databaseUrl.port || 5432)))) {
  console.error('GATED: database isolation requires a reachable Docker daemon and PostgreSQL endpoint; no check was run.');
  process.exit(2);
}

const before = snapshot();
const result = spawnSync(process.execPath, [new URL('./run-database-integration.mjs', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0)], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(`\nThe database integration suite did not pass (exit ${result.status}); isolation was not evaluated.`);
  process.exit(result.status ?? 1);
}

const after = snapshot();
const changed = [...after].filter(([table, value]) => before.get(table) !== value);
if (changed.length) {
  console.error(`\nDATABASE NOT ISOLATED — ${changed.length} table(s) changed across a suite run:`);
  for (const [table, value] of changed) {
    const delta = value - before.get(table);
    console.error(`  ${table}: ${before.get(table)} -> ${value} (${delta >= 0 ? '+' : ''}${delta})`);
  }
  console.error('\nFixture rows must be removed by the test that created them.');
  process.exit(1);
}

console.log(`OK: all ${after.size} tables unchanged across the database integration suite.`);
