#!/usr/bin/env node
// scripts/test-project.mjs - unit tests for project.mjs state machine
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as P from './project.mjs';
import { validateProjectDir, validateManifest, validateState } from './validate-project.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${n}`); c ? pass++ : fail++; };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b));

// --- validateTransition ---
ok('INIT->CLARIFYING valid', P.validateTransition('INIT', 'CLARIFYING'));
ok('BUILDING->SUCCEEDED valid', P.validateTransition('BUILDING', 'SUCCEEDED'));
ok('SUCCEEDED->SOURCE_READY valid (rebuild)', P.validateTransition('SUCCEEDED', 'SOURCE_READY'));
ok('NEEDS_FIX->SOURCE_READY valid', P.validateTransition('NEEDS_FIX', 'SOURCE_READY'));
ok('INIT->BUILDING invalid (skips steps)', !P.validateTransition('INIT', 'BUILDING'));
ok('FAILED->SOURCE_READY invalid (terminal)', !P.validateTransition('FAILED', 'SOURCE_READY'));
ok('CANCELLED->SUCCEEDED invalid (terminal)', !P.validateTransition('CANCELLED', 'SUCCEEDED'));
ok('unknown phase invalid', !P.validateTransition('FOO', 'BAR'));

// --- init ---
const dir = await mkdtemp(join(tmpdir(), 'nc-proj-'));
await P.init(dir, { project: 'demo', mode: 'workflow' });
ok('init creates nodecoda.yaml', existsSync(join(dir, 'nodecoda.yaml')));
ok('init creates nodecoda.state.json', existsSync(join(dir, 'nodecoda.state.json')));
ok('init creates design.md', existsSync(join(dir, 'design.md')));
ok('init creates src/demo.ncoda', existsSync(join(dir, 'src/demo.ncoda')));
ok('init creates builds/', existsSync(join(dir, 'builds')));
eq('init state.phase=INIT', (await P.getState(dir)).phase, 'INIT');

// --- set-state transitions + rev auto-increment ---
await P.setState(dir, 'CLARIFYING');
eq('phase after CLARIFYING', (await P.getState(dir)).phase, 'CLARIFYING');
await P.setState(dir, 'DESIGNED');
await P.setState(dir, 'SOURCE_READY');
eq('rev=0 at first SOURCE_READY', (await P.getState(dir)).rev, 0);
await P.setState(dir, 'BUILDING', { buildId: 'job_1' });
await P.setState(dir, 'NEEDS_FIX', { diagnostics: ['err'] });
await P.setState(dir, 'SOURCE_READY');            // auto rev+1
let s = await P.getState(dir);
eq('rev=1 after NEEDS_FIX->SOURCE_READY', s.rev, 1);
eq('history has 6 entries', s.history.length, 6);
eq('current_build_id recorded', s.current_build_id, 'job_1');
await P.setState(dir, 'BUILDING', { buildId: 'job_2' });
await P.setState(dir, 'SUCCEEDED', { sha256: 'abc' });
await P.setState(dir, 'SOURCE_READY');            // rebuild, auto rev+1
s = await P.getState(dir);
eq('rev=2 after SUCCEEDED->SOURCE_READY', s.rev, 2);
eq('source_sha256 recorded', s.source_sha256, 'abc');

// --- illegal transition rejected ---
let threw = false;
try { await P.setState(dir, 'SUCCEEDED'); } catch { threw = true; }  // SOURCE_READY->SUCCEEDED illegal
ok('illegal SOURCE_READY->SUCCEEDED throws', threw);

// --- resolve ---
eq('resolve finds project', (await P.resolve(dir)).project, true);
const dir2 = await mkdtemp(join(tmpdir(), 'nc-empty-'));
eq('resolve rejects empty dir', (await P.resolve(dir2)).project, false);

// --- state file is resumable JSON ---
ok('state.json is valid JSON', !!JSON.parse(await readFile(join(dir, 'nodecoda.state.json'), 'utf-8')));

// --- validate-project.mjs ---
eq('valid manifest passes', validateManifest('project: demo\nmode: workflow\ntarget_profile: dify-1.16-graphon-0.6\nlanguage_identity: nodecoda/1\nsource: src/demo.ncoda\n'), []);
ok('manifest missing key detected', validateManifest('mode: workflow\n').includes('manifest missing key: project'));
ok('invalid mode detected', validateManifest('project: x\nmode: bogus\ntarget_profile: t\nlanguage_identity: l\nsource: s\n').some(e => e.startsWith('invalid mode')));
eq('valid state passes', validateState(P.initialState()), []);
ok('state missing key detected', validateState({ phase: 'INIT' }).includes('state missing key: rev'));
eq('valid project dir passes', await validateProjectDir(dir), []);
const badDir = await mkdtemp(join(tmpdir(), 'nc-bad-'));
ok('empty dir fails validation', (await validateProjectDir(badDir)).length > 0);
await rm(badDir, { recursive: true, force: true });

await rm(dir, { recursive: true, force: true });
await rm(dir2, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
