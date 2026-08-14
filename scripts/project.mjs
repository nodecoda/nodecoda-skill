#!/usr/bin/env node
// scripts/project.mjs - project-based workflow state machine (Node 18+, no deps)
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
  if (!validateTransition(from, to)) {
    const legal = (TRANSITIONS[from] ?? []).join(', ') || '(none)';
    const msg = `illegal transition: ${from} -> ${to}. Legal targets from ${from}: ${legal}.`;
    if (from === 'SUCCEEDED') {
      throw new Error(`${msg} To rebuild, walk the full chain: SUCCEEDED -> SOURCE_READY (rev+1) -> BUILDING (--build-id <id>) -> SUCCEEDED (--sha256 <hash>) — see references/project-workflow.md "Rebuild protocol".`);
    }
    throw new Error(msg);
  }
  if (to === 'BUILDING' && opts.buildId === undefined) {
    throw new Error('set-state BUILDING requires --build-id <id>: the resume protocol polls get_workflow_build with current_build_id. See references/project-workflow.md "Rebuild protocol".');
  }
  if (to === 'SUCCEEDED' && opts.sha256 === undefined) {
    throw new Error('set-state SUCCEEDED requires --sha256 <hash>: hash fidelity checks compare source_sha256 to the saved src file. See references/project-workflow.md "Rebuild protocol".');
  }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
