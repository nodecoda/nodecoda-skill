# Project-Based Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-based workflow mode to nodecoda-skill so creating a Dify workflow becomes a versioned, resumable, shareable project (directory + DSL source + compile loop + state machine).

**Architecture:** A project = one workflow = one directory. `src/<name>.ncoda` is the source-of-truth; `nodecoda.yaml` is the human-readable manifest; `nodecoda.state.json` is the machine state machine state (JSON, no YAML dependency). `scripts/project.mjs` implements the state machine (init/get-state/set-state/validate-transition/resolve); `SKILL.md` defines the protocol agents follow. Builds land in `builds/<build_id>/` via the existing `save-build.mjs`.

**Tech Stack:** Node 18+ (pure built-ins, zero dependencies — matches existing `scripts/*.mjs` convention). No new packages.

## Global Constraints

- **No new dependencies.** All scripts use Node 18+ built-ins only (`node:fs`, `node:path`, `node:os`, `node:child_process`). Existing repo scripts (`validate-skill.mjs`, `test-contract.mjs`, `save-build.mjs`) are pure-Node; follow that pattern.
- **State file is JSON, not YAML.** Spec decision #2 (option A) explicitly allows "manifest / independent state file". `nodecoda.yaml` stays human-readable YAML (agent-maintained); `nodecoda.state.json` is machine state (project.mjs-maintained) so no YAML parser dependency is needed.
- **State machine phases (exact):** `INIT | CLARIFYING | DESIGNED | SOURCE_READY | BUILDING | SUCCEEDED | NEEDS_FIX | FAILED | CANCELLED`.
- **Terminal phases:** `FAILED` and `CANCELLED` accept no outgoing transitions.
- **Rebuild allowed:** `SUCCEEDED -> SOURCE_READY` and `NEEDS_FIX -> SOURCE_READY` are legal (DSL is recompilable). On these transitions `rev` auto-increments by 1 unless `--rev` is given.
- **Default target_profile:** `dify-1.16-graphon-0.6`. **Default language_identity:** `nodecoda/1`. **Valid modes:** `workflow | advanced-chat`.
- **Credentials never persisted.** `NODECODA_KEY` is read from env only; never written to manifest, state, design, or report files.
- **Source hash fidelity.** The saved `src/<name>.ncoda` byte content must equal the bytes submitted to `build_dify_workflow` (the backend hashes exact submitted bytes, no trailing-newline normalization — verified 2026-08-12).
- **Skill stays cross-agent.** Manifest declares `platforms: ["claude-code","codex","gemini-cli","cursor"]`. No OMX-specific mechanisms (`omx question`, `omx state`).

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `scripts/project.mjs` | State machine: phases, transitions, init/get-state/set-state/validate-transition/resolve + CLI | Create |
| `scripts/test-project.mjs` | Unit tests for project.mjs (state machine, init, transitions, rev, resolve) | Create |
| `scripts/validate-project.mjs` | Validate a project dir: manifest keys, state schema, source/design existence | Create |
| `scripts/test-contract.mjs` | Add a block that validates `examples/project/` via validate-project.mjs | Modify |
| `skills/nodecoda-workflow/SKILL.md` | Add "项目化工作流" section (protocol layer); keep lightweight mode as opt-in | Modify |
| `skills/nodecoda-workflow/references/project-workflow.md` | Detailed state-transition table, command reference, resume protocol | Create |
| `examples/project/nodecoda.yaml` | Example project manifest | Create |
| `examples/project/nodecoda.state.json` | Example project state (demonstrates SUCCEEDED) | Create |
| `examples/project/design.md` | Example design doc | Create |
| `examples/project/src/customer-support.ncoda` | Example source (verified syntax from 02-with-llm.ncoda) | Create |
| `README.md` | Project-mode usage + command quick-reference | Modify |

---

### Task 1: State machine core (`scripts/project.mjs` + unit tests)

**Files:**
- Create: `scripts/project.mjs`
- Create: `scripts/test-project.mjs`

**Interfaces:**
- Produces (exported): `PHASES` (string[]), `TRANSITIONS` (Record<phase, phase[]>), `validateTransition(from, to) -> boolean`, `initialState() -> State`, `init(dir, opts) -> {dir, source}`, `getState(dir) -> State`, `setState(dir, to, opts) -> State`, `resolve(cwd) -> {project, dir, reason}`
- CLI: `project.mjs init <dir> --project <n> --mode <m> [--target X] [--language Y]` | `get-state <dir>` | `set-state <dir> <phase> [--build-id X] [--sha256 X] [--rev N] [--diagnostics JSON]` | `validate-transition <from> <to>` | `resolve [dir]`

- [ ] **Step 1: Write the failing test (`scripts/test-project.mjs`)**

```js
#!/usr/bin/env node
// scripts/test-project.mjs — unit tests for project.mjs state machine
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as P from './project.mjs';

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

await rm(dir, { recursive: true, force: true });
await rm(dir2, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-project.mjs`
Expected: FAIL with `Cannot find module ... project.mjs`

- [ ] **Step 3: Implement `scripts/project.mjs`**

```js
#!/usr/bin/env node
// scripts/project.mjs — project-based workflow state machine (Node 18+, no deps)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const PHASES = [
  'INIT', 'CLARIFYING', 'DESIGNED', 'SOURCE_READY',
  'BUILDING', 'SUCCEEDED', 'NEEDS_FIX', 'FAILED', 'CANCELLED',
];

export const TRANSITIONS = {
  INIT:         ['CLARIFYING', 'DESIGNED', 'CANCELLED'],
  CLARIFYING:   ['DESIGNED', 'CANCELLED'],
  DESIGNED:     ['SOURCE_READY', 'CANCELLED'],
  SOURCE_READY: ['BUILDING', 'CANCELLED'],
  BUILDING:     ['SUCCEEDED', 'NEEDS_FIX', 'FAILED', 'CANCELLED'],
  NEEDS_FIX:    ['SOURCE_READY', 'FAILED', 'CANCELLED'],
  SUCCEEDED:    ['SOURCE_READY', 'CANCELLED'],
  FAILED:       [],
  CANCELLED:    [],
};

export function validateTransition(from, to) {
  if (!PHASES.includes(from) || !PHASES.includes(to)) return false;
  return TRANSITIONS[from].includes(to);
}

export function initialState() {
  return { phase: 'INIT', rev: 0, current_build_id: null, source_sha256: null, last_diagnostics: [], history: [] };
}

const DEFAULT_TARGET = 'dify-1.16-graphon-0.6';
const DEFAULT_LANGUAGE = 'nodecoda/1';

function manifestYaml({ project, mode, target, language, source }) {
  return `project: ${project}\nmode: ${mode}\ntarget_profile: ${target}\nlanguage_identity: ${language}\nsource: ${source}\ncreated_at: ${new Date().toISOString()}\n`;
}

function designTemplate() {
  return '# Design\n\n## 用途\n\n## 输入/输出\n\n## 模式与依赖\n\n## 边界与异常\n';
}

export async function init(dir, { project, mode, target = DEFAULT_TARGET, language = DEFAULT_LANGUAGE }) {
  if (!project) throw new Error('--project is required');
  if (mode !== 'workflow' && mode !== 'advanced-chat') throw new Error('--mode must be workflow or advanced-chat');
  const srcDir = path.join(dir, 'src');
  await mkdir(srcDir, { recursive: true });
  await mkdir(path.join(dir, 'builds'), { recursive: true });
  const sourceRel = `src/${project}.ncoda`;
  await writeFile(path.join(dir, 'nodecoda.yaml'), manifestYaml({ project, mode, target, language, source: sourceRel }));
  await writeFile(path.join(dir, 'nodecoda.state.json'), JSON.stringify(initialState(), null, 2) + '\n');
  await writeFile(path.join(dir, 'design.md'), designTemplate());
  await writeFile(path.join(srcDir, `${project}.ncoda`),
    `@language ${language}\n@mode ${mode}\n\nfunction main(string query) -> string {\n    return query;\n}\n`);
  return { dir, source: sourceRel };
}

export async function getState(dir) {
  return JSON.parse(await readFile(path.join(dir, 'nodecoda.state.json'), 'utf-8'));
}

export async function setState(dir, to, opts = {}) {
  const state = await getState(dir);
  const from = state.phase;
  if (!validateTransition(from, to)) throw new Error(`illegal transition: ${from} -> ${to}`);
  let rev = state.rev;
  if (to === 'SOURCE_READY' && (from === 'NEEDS_FIX' || from === 'SUCCEEDED') && opts.rev === undefined) rev = state.rev + 1;
  if (opts.rev !== undefined) rev = opts.rev;
  const entry = { phase: to, at: new Date().toISOString(), rev };
  if (opts.buildId !== undefined) { state.current_build_id = opts.buildId; entry.build_id = opts.buildId; }
  if (opts.sha256 !== undefined) state.source_sha256 = opts.sha256;
  if (opts.diagnostics !== undefined) { state.last_diagnostics = opts.diagnostics; entry.diagnostics = opts.diagnostics; }
  state.phase = to;
  state.rev = rev;
  state.history.push(entry);
  await writeFile(path.join(dir, 'nodecoda.state.json'), JSON.stringify(state, null, 2) + '\n');
  return state;
}

export async function resolve(cwd = process.cwd()) {
  const has = (f) => existsSync(path.join(cwd, f));
  if (has('nodecoda.yaml') && has('nodecoda.state.json')) return { project: true, dir: cwd, reason: 'found nodecoda.yaml + nodecoda.state.json' };
  return { project: false, dir: cwd, reason: 'no project markers' };
}

// --- CLI ---
function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const flags = {}; const positional = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      flags[a.slice(2)] = val;
    } else positional.push(a);
  }
  return { cmd, flags, positional };
}

async function main() {
  const { cmd, flags, positional } = parseArgs(process.argv);
  if (cmd === 'validate-transition') {
    const [from, to] = positional;
    const okv = validateTransition(from, to);
    console.log(okv ? 'valid' : 'invalid'); process.exit(okv ? 0 : 1);
  } else if (cmd === 'init') {
    const d = positional[0];
    if (!d || !flags.project || !flags.mode) { console.error('usage: project.mjs init <dir> --project <name> --mode <workflow|advanced-chat>'); process.exit(2); }
    await init(path.resolve(d), { project: flags.project, mode: flags.mode, target: flags.target, language: flags.language });
    console.log(`initialized: ${path.resolve(d)}`);
  } else if (cmd === 'get-state') {
    console.log(JSON.stringify(await getState(path.resolve(positional[0] || '.')), null, 2));
  } else if (cmd === 'set-state') {
    const [d, to] = positional;
    if (!d || !to) { console.error('usage: project.mjs set-state <dir> <phase> [--build-id X] [--sha256 X] [--rev N] [--diagnostics JSON]'); process.exit(2); }
    const st = await setState(path.resolve(d), to, {
      buildId: flags['build-id'], sha256: flags.sha256,
      rev: flags.rev !== undefined ? Number(flags.rev) : undefined,
      diagnostics: flags.diagnostics ? JSON.parse(flags.diagnostics) : undefined,
    });
    console.log(`phase: ${st.phase} rev: ${st.rev}`);
  } else if (cmd === 'resolve') {
    console.log(JSON.stringify(await resolve(path.resolve(positional[0] || process.cwd())), null, 2));
  } else {
    console.error('commands: init | get-state | set-state | validate-transition | resolve'); process.exit(2);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-project.mjs`
Expected: `16 passed, 0 failed`

- [ ] **Step 5: Syntax check + commit**

```bash
node --check scripts/project.mjs
node --check scripts/test-project.mjs
git add scripts/project.mjs scripts/test-project.mjs
git commit -m "feat(scripts): project state machine (init/get-state/set-state/validate-transition/resolve) + tests"
```

---

### Task 2: Project structure validator (`scripts/validate-project.mjs`) + contract integration

**Files:**
- Create: `scripts/validate-project.mjs`
- Modify: `scripts/test-contract.mjs` (add a block that validates `examples/project/` after Task 4 creates it; guard with existence check so it is a no-op until then)

**Interfaces:**
- Produces (exported): `validateManifest(text) -> string[]`, `validateState(obj) -> string[]`, `validateProjectDir(dir) -> string[]` (returns error list, empty = valid)
- CLI: `validate-project.mjs <project-dir>` → exit 0 (OK) / 1 (errors)

- [ ] **Step 1: Write the failing test (append to `scripts/test-project.mjs`, before the final summary)**

```js
// --- validate-project.mjs (appended after resolve tests, before rm cleanup reuse dir) ---
import { validateProjectDir, validateManifest, validateState } from './validate-project.mjs';
eq('valid manifest passes', validateManifest('project: demo\nmode: workflow\ntarget_profile: dify-1.16-graphon-0.6\nlanguage_identity: nodecoda/1\nsource: src/demo.ncoda\n'), []);
ok('manifest missing key detected', validateManifest('mode: workflow\n').includes('manifest missing key: project'));
ok('invalid mode detected', validateManifest('project: x\nmode: bogus\ntarget_profile: t\nlanguage_identity: l\nsource: s\n').some(e => e.startsWith('invalid mode')));
eq('valid state passes', validateState(P.initialState()), []);
ok('state missing key detected', validateState({ phase: 'INIT' }).includes('state missing key: rev'));
eq('valid project dir passes', await validateProjectDir(dir), []);
const badDir = await mkdtemp(join(tmpdir(), 'nc-bad-'));
ok('empty dir fails validation', (await validateProjectDir(badDir)).length > 0);
await rm(badDir, { recursive: true, force: true });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-project.mjs`
Expected: FAIL with `Cannot find module ... validate-project.mjs`

- [ ] **Step 3: Implement `scripts/validate-project.mjs`**

```js
#!/usr/bin/env node
// scripts/validate-project.mjs — validate a project directory structure (Node 18+, no deps)
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REQUIRED_MANIFEST_KEYS = ['project', 'mode', 'target_profile', 'language_identity', 'source'];
const VALID_MODES = ['workflow', 'advanced-chat'];
const REQUIRED_STATE_KEYS = ['phase', 'rev', 'current_build_id', 'source_sha256', 'last_diagnostics', 'history'];

export function validateManifest(text) {
  const errors = [];
  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!new RegExp(`^${key}:\\s*(.+)$`, 'm').test(text)) errors.push(`manifest missing key: ${key}`);
  }
  const m = text.match(/^mode:\s*(.+)$/m);
  if (m && !VALID_MODES.includes(m[1].trim())) errors.push(`invalid mode: ${m[1].trim()}`);
  return errors;
}

export function validateState(obj) {
  const errors = [];
  for (const key of REQUIRED_STATE_KEYS) if (!(key in obj)) errors.push(`state missing key: ${key}`);
  return errors;
}

export async function validateProjectDir(dir) {
  const errors = [];
  const manifestPath = join(dir, 'nodecoda.yaml');
  const statePath = join(dir, 'nodecoda.state.json');
  if (!existsSync(manifestPath)) return ['missing nodecoda.yaml'];
  if (!existsSync(statePath)) return ['missing nodecoda.state.json'];
  const manifest = await readFile(manifestPath, 'utf-8');
  errors.push(...validateManifest(manifest));
  try { errors.push(...validateState(JSON.parse(await readFile(statePath, 'utf-8')))); }
  catch (e) { errors.push(`state.json parse failed: ${e.message}`); }
  const srcMatch = manifest.match(/^source:\s*(.+)$/m);
  if (srcMatch && !existsSync(join(dir, srcMatch[1].trim()))) errors.push(`source file missing: ${srcMatch[1].trim()}`);
  if (!existsSync(join(dir, 'design.md'))) errors.push('missing design.md');
  return errors;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: validate-project.mjs <project-dir>'); process.exit(2); }
  const errors = await validateProjectDir(resolve(dir));
  if (errors.length) { for (const e of errors) console.error(`ERROR: ${e}`); process.exit(1); }
  console.log('OK');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-project.mjs`
Expected: all pass (count increased by appended assertions)

- [ ] **Step 5: Add contract integration to `scripts/test-contract.mjs`**

In `scripts/test-contract.mjs`, locate the section that asserts README install table / package metadata (near the end of the assertion list, before the final `console.log` summary). Insert this guarded block:

```js
// Project-mode contract: validate examples/project/ once it exists
import { validateProjectDir } from './validate-project.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const exampleProject = join(REPO_ROOT, 'examples', 'project');
if (existsSync(join(exampleProject, 'nodecoda.yaml'))) {
  const errs = await validateProjectDir(exampleProject);
  ok('examples/project/ validates', errs.length === 0);
  if (errs.length) console.error(errs.join('\n'));
} else {
  console.log('  (skip: examples/project/ not yet created)');
}
```

- [ ] **Step 6: Run contract tests + commit**

```bash
node scripts/test-contract.mjs   # examples/project/ block is a skip until Task 4
node --check scripts/validate-project.mjs
git add scripts/validate-project.mjs scripts/test-project.mjs scripts/test-contract.mjs
git commit -m "feat(scripts): validate-project.mjs + contract integration for project dirs"
```

---

### Task 3: SKILL.md project-mode section + reference doc

**Files:**
- Modify: `skills/nodecoda-workflow/SKILL.md` (insert a new "## 项目化工作流" section after the existing "## 核心边界" section, before "## 凭据安全")
- Create: `skills/nodecoda-workflow/references/project-workflow.md`

**Interfaces:**
- Consumes: Task 1 `project.mjs` commands; Task 2 `validate-project.mjs`
- Produces: documented protocol agents follow; keeps SKILL.md under 500 lines (detail goes to reference)

- [ ] **Step 1: Create `references/project-workflow.md`**

```markdown
# Project-Based Workflow

Detailed reference for the project mode. SKILL.md holds the protocol; this file holds the full state table, commands, and resume rules.

## When to use project mode vs lightweight mode

- **Project mode (default)**: the user wants a real, versioned, shareable Dify workflow. Create a project directory.
- **Lightweight mode (opt-in)**: quick validation of a `.ncoda` snippet, debugging a single node, or running an example. No project dir; state lives only in the conversation. State explicitly: "这是临时验证，正式工作流请走项目模式。"

## Project directory layout

\`\`\`
<project-name>/
├── nodecoda.yaml            # manifest (agent-maintained YAML)
├── nodecoda.state.json      # state machine state (project.mjs-maintained JSON)
├── design.md                # requirements artifact (lean deep-interview)
├── src/
│   └── <name>.ncoda         # source-of-truth (recompilable)
└── builds/                  # compile history (gitignore)
    └── <build_id>/
        ├── <name>.dify.yaml
        ├── <name>.build.json
        └── <name>.ncoda     # source snapshot for that build
\`\`\`

## Manifest (`nodecoda.yaml`)

\`\`\`yaml
project: customer-support
mode: advanced-chat
target_profile: dify-1.16-graphon-0.6
language_identity: nodecoda/1
source: src/customer-support.ncoda
created_at: "2026-08-12T..."
\`\`\`

## State (`nodecoda.state.json`)

\`\`\`json
{ "phase": "DESIGNED", "rev": 0, "current_build_id": null, "source_sha256": null, "last_diagnostics": [], "history": [] }
\`\`\`

## State machine — full transition table

| From | Allowed to |
|---|---|
| INIT | CLARIFYING, DESIGNED, CANCELLED |
| CLARIFYING | DESIGNED, CANCELLED |
| DESIGNED | SOURCE_READY, CANCELLED |
| SOURCE_READY | BUILDING, CANCELLED |
| BUILDING | SUCCEEDED, NEEDS_FIX, FAILED, CANCELLED |
| NEEDS_FIX | SOURCE_READY (rev+1), FAILED, CANCELLED |
| SUCCEEDED | SOURCE_READY (rev+1), CANCELLED |
| FAILED | (terminal) |
| CANCELLED | (terminal) |

`rev` auto-increments on `NEEDS_FIX->SOURCE_READY` and `SUCCEEDED->SOURCE_READY` unless `--rev` is given.

## Commands

\`\`\`bash
# detect or create
node scripts/project.mjs resolve
node scripts/project.mjs init ./my-flow --project my-flow --mode workflow

# state
node scripts/project.mjs get-state ./my-flow
node scripts/project.mjs set-state ./my-flow DESIGNED
node scripts/project.mjs set-state ./my-flow BUILDING --build-id job_x
node scripts/project.mjs set-state ./my-flow SUCCEEDED --sha256 <hash>
node scripts/project.mjs set-state ./my-flow NEEDS_FIX --diagnostics '["err1"]'

# validate
node scripts/validate-project.mjs ./my-flow
\`\`\`

## Resume protocol

On any session start inside a project dir, run `project.mjs get-state .` and continue from `phase`:
- CLARIFYING/DESIGNED: continue or finalize design.md
- SOURCE_READY: submit build
- BUILDING: poll `get_workflow_build` with `current_build_id`
- NEEDS_FIX: read `last_diagnostics`, edit src, set-state SOURCE_READY
- SUCCEEDED: deliver; or edit src to rebuild
- FAILED/CANCELLED: report terminal state, do not auto-retry

## Lean deep-interview (project creation)

One question at a time, intent-first, max 5 rounds. If input/output/mode/boundaries are already answerable, skip to DESIGNED early.
1. 用途 (purpose)
2. 输入/输出 (input/output)
3. 模式与依赖 (mode + deps)
4. 边界与异常 (boundaries + error branches)

## Build loop (coding cycle)

\`\`\`
SOURCE_READY -> build_dify_workflow(idempotency_key=<project>-rev-<n>)
  -> poll get_workflow_build (<=180s, admission <=3)
  -> SUCCEEDED: node scripts/save-build.mjs <build_id> --source src/<name>.ncoda --out builds
       + set-state SUCCEEDED --sha256 <hash>
  -> NEEDS_FIX: set-state NEEDS_FIX --diagnostics '<json>'; edit src; set-state SOURCE_READY (rev+1); loop <=5
  -> FAILED/CANCELLED: terminal, keep diagnostics
\`\`\`

## Hash fidelity

Saved `src/<name>.ncoda` bytes MUST equal the bytes passed to `build_dify_workflow`. The backend hashes exact submitted bytes (no trailing-newline normalization). If `source_sha256 != sha256(saved file)`, stop and reconcile.

## Credentials

`NODECODA_KEY` is read from env only. Never write it to manifest, state, design, or reports.
```

- [ ] **Step 2: Insert the protocol section into `skills/nodecoda-workflow/SKILL.md`**

After the `## 核心边界` section (before `## 凭据安全`), insert:

```markdown
## 项目化工作流

创建正式工作流时走项目模式：一个工作流 = 一个项目目录，`.ncoda` 源码可反复编译、版本化、共享。

**探测与创建**：先 `node scripts/project.mjs resolve`——当前目录有 `nodecoda.yaml` 就就地复用；没有则默认新建 `./<name>/`（用一个问题确认，尊重用户想要就地的明确表达）。

**精简澄清**：一次一问、意图优先（用途/输入输出/模式与依赖/边界与异常）、≤5 轮，结论落盘 `design.md`。需求已清晰可提前进入 DESIGNED。

**生命周期状态机**：`INIT -> CLARIFYING -> DESIGNED -> SOURCE_READY -> BUILDING -> SUCCEEDED`；失败走 `NEEDS_FIX` 修复循环（≤5 次），成功后改源码可重新编译（`SUCCEEDED -> SOURCE_READY`，rev+1）。转换经 `project.mjs set-state` 校验。

**恢复**：会话中断后 `project.mjs get-state .` 回到对应阶段，不重问需求。

**产物保存**：SUCCEEDED 后 `save-build.mjs <build_id> --source src/<name>.ncoda --out builds` 落盘到 `builds/<build_id>/`。

**轻量模式（可选）**：只验证 `.ncoda` 片段、排查单点时不建项目，但需声明"这是临时验证"。完整规则见 `references/project-workflow.md`。
```

- [ ] **Step 3: Validate skill contract still passes**

Run: `node scripts/validate-skill.mjs`
Expected: `OK 0 warning(s)` (frontmatter intact; SKILL.md still under size budget)

- [ ] **Step 4: Commit**

```bash
git add skills/nodecoda-workflow/SKILL.md skills/nodecoda-workflow/references/project-workflow.md
git commit -m "feat(skill): project-based workflow protocol section + project-workflow reference"
```

---

### Task 4: Example project + e2e validation

**Files:**
- Create: `examples/project/nodecoda.yaml`
- Create: `examples/project/nodecoda.state.json`
- Create: `examples/project/design.md`
- Create: `examples/project/src/customer-support.ncoda`
- Modify: `.gitignore` (ensure `builds/` ignored but `examples/project/builds/` empty dir placeholder is fine)

**Interfaces:**
- Consumes: Task 1-3 (validate-project.mjs validates this dir; test-contract.mjs block from Task 2 now runs)
- Produces: a concrete, validated example project that doubles as e2e fixture

- [ ] **Step 1: Create the example project files**

`examples/project/nodecoda.yaml`:
```yaml
project: customer-support
mode: workflow
target_profile: dify-1.16-graphon-0.6
language_identity: nodecoda/1
source: src/customer-support.ncoda
created_at: "2026-08-12T00:00:00Z"
```

`examples/project/nodecoda.state.json`:
```json
{
  "phase": "SOURCE_READY",
  "rev": 0,
  "current_build_id": null,
  "source_sha256": null,
  "last_diagnostics": [],
  "history": [
    { "phase": "INIT", "at": "2026-08-12T00:00:00Z", "rev": 0 },
    { "phase": "CLARIFYING", "at": "2026-08-12T00:01:00Z", "rev": 0 },
    { "phase": "DESIGNED", "at": "2026-08-12T00:05:00Z", "rev": 0 },
    { "phase": "SOURCE_READY", "at": "2026-08-12T00:06:00Z", "rev": 0 }
  ]
}
```

`examples/project/design.md`:
```markdown
# Design — Customer Support Workflow

## 用途
把用户的客服问题发给 LLM，返回简洁的专业回答。

## 输入/输出
- 输入：`query`（string，用户问题）
- 输出：`string`，模型回答

## 模式与依赖
- 模式：`workflow`（单次请求-响应）
- 依赖：`openai_api_compatible` 提供方（示例占位，生产前替换为真实 provider）

## 边界与异常
- 不做多轮对话（如需会话改用 advanced-chat）
- LLM 失败时返回固定兜底文案（示例中省略，生产实现需补）
```

`examples/project/src/customer-support.ncoda` (syntax verified from `examples/02-with-llm.ncoda`):
```nodecoda
@language nodecoda/1
@mode workflow

// 客户支持：把用户问题发给 LLM，返回简洁回答
const MODEL = "openai_api_compatible/gpt-5.4";

function main(string query) -> string {
    let response = llm(MODEL, {
        "messages": [
            { "role": "system", "content": "你是专业的客服助手，用一句话准确回答用户问题。" },
            { "role": "user", "content": query }
        ],
        "temperature": 0.3,
        "max_tokens": 512
    });
    return response.text;
}
```

- [ ] **Step 2: Validate the example project**

Run: `node scripts/validate-project.mjs examples/project`
Expected: `OK`

- [ ] **Step 3: Run contract tests (the Task 2 guarded block now executes)**

Run: `node scripts/test-contract.mjs`
Expected: includes `✓ examples/project/ validates`; overall pass

- [ ] **Step 4: Commit**

```bash
git add examples/project .gitignore
git commit -m "feat(examples): project-mode example (customer-support workflow) + e2e fixture"
```

---

### Task 5: README — project-mode usage

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior tasks (documents the user-facing commands)

- [ ] **Step 1: Add a "项目化工作流" section to README.md**

After the existing usage section, add:

```markdown
## 项目化工作流（Project Mode）

创建正式、可版本化、可共享的 Dify 工作流时使用项目模式。一个工作流 = 一个项目目录，`.ncoda` 源码可反复编译。

### 快速开始

```bash
# 探测当前目录是否已是项目
node scripts/project.mjs resolve

# 新建项目（默认 target_profile=dify-1.16-graphon-0.6）
node scripts/project.mjs init ./my-flow --project my-flow --mode workflow

# 状态流转（agent 在各阶段调用）
node scripts/project.mjs set-state ./my-flow DESIGNED
node scripts/project.mjs set-state ./my-flow SOURCE_READY
node scripts/project.mjs set-state ./my-flow BUILDING --build-id job_x
node scripts/project.mjs set-state ./my-flow SUCCEEDED --sha256 <hash>

# 校验项目结构
node scripts/validate-project.mjs ./my-flow

# 保存编译产物（SUCCEEDED 后）
node scripts/save-build.mjs <build_id> --source src/my-flow.ncoda --out builds
```

### 项目目录

```
my-flow/
├── nodecoda.yaml        # 清单
├── nodecoda.state.json  # 状态机状态
├── design.md            # 需求分析
├── src/my-flow.ncoda    # 源码（事实源）
└── builds/<build_id>/   # 编译历史（gitignore）
```

### 版本化与共享

`src/`、`nodecoda.yaml`、`design.md` 入 git；`builds/` 默认 gitignore（可复现性由 `build_id` + `source_sha256` 保证）。共享项目目录即可重新编译。

### 轻量模式

只验证 `.ncoda` 片段或排查单点时，可不建项目，直接对话内 build；需声明"这是临时验证"。

完整协议见 `skills/nodecoda-workflow/references/project-workflow.md`。
```

- [ ] **Step 2: Run contract tests (README install-table assertion must still pass)**

Run: `node scripts/test-contract.mjs`
Expected: pass (README changes are additive; install table unchanged)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: project-mode usage in README"
```

---

## Self-Review

**1. Spec coverage** (against `docs/design/specs/2026-08-12-project-workflow-design.md`):
- §2 decision 1 (one project = one workflow): Task 1 init creates single `src/<name>.ncoda` ✓
- §2 decision 2 (manifest-driven): Task 1 nodecoda.yaml + nodecoda.state.json ✓ (state split to JSON per Global Constraints, allowed by spec option A wording)
- §2 decision 3 (lean deep-interview): Task 3 SKILL.md + project-workflow.md §Lean deep-interview ✓
- §2 decision 4 (hybrid state machine): Task 1 project.mjs (impl) + Task 3 SKILL.md (protocol) ✓
- §2 decision 5 (detect + default new): Task 1 resolve + init; Task 3 SKILL.md 探测与创建 ✓
- §2 decision 6 (git-native, builds/ ignored): Task 4 .gitignore; README §版本化 ✓
- §2 decision 7 (lightweight retained): Task 3 SKILL.md 轻量模式 ✓
- §6 state machine: Task 1 TRANSITIONS table matches spec exactly ✓
- §8 build loop: Task 3 project-workflow.md §Build loop + save-build.mjs reuse ✓
- §9 error handling (resume, illegal transition, hash fidelity, credentials): Task 1 + Task 3 ✓
- §11 testing: Task 1 unit tests, Task 2 validator + contract integration, Task 4 e2e fixture ✓

**2. Placeholder scan:** No TBD/TODO/"add validation"/"similar to Task N". All code blocks contain real code. Example `.ncoda` uses syntax verified from `examples/02-with-llm.ncoda`. ✓

**3. Type consistency:** `validateTransition(from,to)`, `getState(dir)`, `setState(dir,to,opts)` signatures consistent across Task 1 impl, Task 1 test, Task 2 integration, Task 3 docs. `opts.buildId`/`opts.sha256`/`opts.rev`/`opts.diagnostics` names match test and CLI flag mapping (`--build-id`→buildId). ✓

No gaps found.

## Execution Handoff

**Plan complete and saved to `docs/design/plans/2026-08-12-project-workflow.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
