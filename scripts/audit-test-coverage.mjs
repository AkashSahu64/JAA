#!/usr/bin/env node
/**
 * Test-coverage integrity audit.
 *
 * A test file can be skipped by an environment gate and referenced by no runner script, in
 * which case it never executes anywhere. The suite reports it as "skipped", which reads as
 * intentional, so the gap is invisible: the tests exist, are never run, and are never
 * counted as failures.
 *
 * This script finds those files statically, without running the suite:
 *   1. every `*.test.ts` that gates on `process.env.X === '1'`
 *   2. the set of env vars the runner scripts in scripts/ actually set
 *   3. any gated test file whose gate variable no runner sets
 *
 * It also reports runner references that point at files which do not exist.
 *
 * Exit code is non-zero when an orphan is found, so it can be used as a CI gate.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SEARCH_ROOTS = ['apps', 'packages'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const testFiles = SEARCH_ROOTS
  .map(root => path.join(ROOT, root))
  .filter(dir => fs.existsSync(dir))
  .flatMap(dir => walk(dir))
  .map(file => path.relative(ROOT, file).split(path.sep).join('/'));

// A gate looks like `process.env.NAME === '1'` (optionally negated). Only the `=== '1'`
// form marks an opt-in integration gate; other env reads are ordinary configuration.
const GATE_PATTERN = /process\.env\.([A-Z0-9_]+)\s*===\s*'1'/g;

const gates = new Map();
for (const file of testFiles) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const found = new Set();
  for (const match of source.matchAll(GATE_PATTERN)) found.add(match[1]);
  if (found.size) gates.set(file, [...found]);
}

const runnerDir = path.join(ROOT, 'scripts');
const runners = fs.readdirSync(runnerDir).filter(f => f.startsWith('run-') && f.endsWith('.mjs'));

const runnerEnv = new Set();
const referenced = new Set();
for (const runner of runners) {
  const source = fs.readFileSync(path.join(runnerDir, runner), 'utf8');
  for (const match of source.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*:/g)) runnerEnv.add(match[1]);
  for (const match of source.matchAll(/'([A-Za-z0-9_/.\-]+\.test\.ts)'/g)) referenced.add(match[1]);
}

const orphans = [];
for (const [file, vars] of gates) {
  const reachable = vars.some(v => runnerEnv.has(v));
  if (!reachable) orphans.push({ file, vars });
}

const missing = [...referenced].filter(f => !fs.existsSync(path.join(ROOT, f)));

console.log(`test files: ${testFiles.length}`);
console.log(`gated test files: ${gates.size}`);
console.log(`runner scripts: ${runners.length}`);
console.log(`env gates set by runners: ${[...runnerEnv].sort().join(', ') || '(none)'}`);

if (missing.length) {
  console.log(`\nrunner references a nonexistent test file (${missing.length}):`);
  for (const file of missing) console.log(`  ${file}`);
}

if (orphans.length) {
  console.log(`\nGATED BUT UNREACHABLE — no runner sets the gate variable (${orphans.length}):`);
  for (const { file, vars } of orphans) console.log(`  ${file}  [needs ${vars.join(' or ')}]`);
  console.log('\nThese tests never execute anywhere. Either wire them into a runner or delete them.');
  process.exit(1);
}

console.log('\nOK: every gated test file is reachable from a runner script.');
