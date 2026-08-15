#!/usr/bin/env node
// scripts/test-package-integrity.mjs
// Packaging-integrity tests for the npm publish whitelist (package.json
// "files").
//
// Regression for the 0.2.21..0.2.24 bug: scripts/mcp-core.mjs statically
// imports './device-id.mjs' (loadDeviceId), but 'scripts/device-id.mjs' was
// missing from "files" — so every consumer of the published package (the
// `build` CLI, stdio/http MCP servers) crashed at load with
// ERR_MODULE_NOT_FOUND. The published tarball only ever shipped the importer,
// never the imported module.
//
// Checks:
//   1. every "files" whitelist entry exists on disk (no dangling paths)
//   2. every static relative module import inside a bundled file resolves to
//      a file that is also bundled (no missing sibling modules)
//   3. every cli.mjs runScript('<name>.mjs') subcommand target is bundled
//   4. real-load smoke: copy the whitelist into a temp dir and import
//      mcp-core.mjs — it must load without ERR_MODULE_NOT_FOUND and expose
//      loadDeviceId (the exact failure mode of the 0.2.21..0.2.24 bug)
import { mkdtemp, readFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(n) { console.log(`  \x1b[32m✓\x1b[0m ${n}`); pass++; }
function bad(n, d) { console.log(`  \x1b[31m✗\x1b[0m ${n}\n    ${d}`); fail++; }
function section(t) { console.log(`\n${t}`); }
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
const norm = (p) => relative(REPO_ROOT, p).split(sep).join('/');

// Expand the "files" whitelist into the concrete set of bundled relative paths.
function expandWhitelist(entries) {
  const out = new Set();
  for (const e of entries) {
    const abs = join(REPO_ROOT, e);
    if (!existsSync(abs)) throw new Error(`files entry does not exist on disk: ${e}`);
    if (statSync(abs).isDirectory()) {
      for (const x of readdirSync(abs, { recursive: true })) {
        const full = join(abs, x);
        if (statSync(full).isFile()) out.add(norm(full));
      }
    } else {
      out.add(norm(abs));
    }
  }
  return out;
}

// Static relative imports: `import {x} from './a.mjs'`, `import './a.mjs'`,
// `export {x} from './a.mjs'`, `import('./a.mjs')`. Only relative (./ or ../).
function relativeImports(src) {
  const deps = new Set();
  const re = /(?:from|import)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|(?:from|import)\s+['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) deps.add(m[1] ?? m[2]);
  return [...deps];
}

section('whitelist sanity');
let bundled;
try {
  bundled = expandWhitelist(pkg.files ?? []);
  ok(`expanded ${pkg.files?.length ?? 0} files entries -> ${bundled.size} bundled files`);
} catch (e) {
  bad('expand whitelist', e.message);
  bundled = new Set();
}

section('regression — device-id.mjs (0.2.21..0.2.24 bug)');
{
  const has = bundled.has('scripts/device-id.mjs');
  assert(has, `scripts/device-id.mjs must be bundled, got: ${[...bundled].filter((f) => f.startsWith('scripts/device')).join(', ') || '(none)'}`);
  ok('scripts/device-id.mjs is in the publish whitelist');
  const core = await readFile(join(REPO_ROOT, 'scripts/mcp-core.mjs'), 'utf8');
  const deps = relativeImports(core);
  assert(deps.includes('./device-id.mjs'), `mcp-core imports ./device-id.mjs, got: ${deps.join(', ')}`);
  ok('mcp-core still imports ./device-id.mjs (regression stays live)');
}

section('bundled file dependency integrity');
{
  let missing = 0;
  const problems = [];
  for (const rel of bundled) {
    if (!rel.endsWith('.mjs')) continue;
    const src = await readFile(join(REPO_ROOT, rel), 'utf8');
    for (const dep of relativeImports(src)) {
      const resolved = norm(resolve(dirname(join(REPO_ROOT, rel)), dep));
      if (!bundled.has(resolved)) {
        missing++;
        problems.push(`${rel} -> ${resolved}`);
      }
    }
  }
  assert(missing === 0, problems.join('\n') || 'unexpected missing imports');
  ok(`all static relative imports resolve inside the bundle (${bundled.size} files scanned)`);
}

section('cli subcommand dispatch integrity');
{
  const cli = await readFile(join(REPO_ROOT, 'scripts/cli.mjs'), 'utf8');
  const re = /runScript\(\s*['"]([^'"]+\.mjs)['"]/g;
  let m; const targets = [];
  while ((m = re.exec(cli))) targets.push(m[1]);
  const missing = targets.filter((t) => !bundled.has(norm(join(REPO_ROOT, 'scripts', t))));
  assert(missing.length === 0, `cli runScript targets not bundled: ${missing.join(', ')}`);
  ok(`every cli.mjs runScript target is bundled (${targets.join(', ')})`);
}

section('real-load smoke — bundled mcp-core must import');
{
  const dir = await mkdtemp(join(tmpdir(), 'nc-pkg-smoke-'));
  try {
    for (const rel of bundled) {
      const src = join(REPO_ROOT, rel);
      const dst = join(dir, rel);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
    }
    // mcp-core is the module that crashed in 0.2.21..0.2.24 (its static
    // import of ./device-id.mjs failed with ERR_MODULE_NOT_FOUND). It must
    // load from the bundled set and expose its real exports.
    const mod = await import(pathToFileURL(join(dir, 'scripts/mcp-core.mjs')).href);
    assert(typeof mod.upstreamMode === 'function', 'upstreamMode exported');
    assert(typeof mod.callTool === 'function', 'callTool exported');
    assert(typeof mod.createToolCaller === 'function', 'createToolCaller exported');
    assert(Array.isArray(mod.TOOLS) && mod.TOOLS.length > 0, 'TOOLS exported');
    ok('mcp-core loads from the bundled file set (no ERR_MODULE_NOT_FOUND)');
    // And the missing-dependency file itself must be importable from the
    // bundle, exposing the function mcp-core consumes.
    const did = await import(pathToFileURL(join(dir, 'scripts/device-id.mjs')).href);
    assert(typeof did.loadDeviceId === 'function', 'device-id.loadDeviceId callable');
    ok('device-id.mjs loads from the bundle with loadDeviceId callable');
  } catch (e) {
    bad('mcp-core smoke import', e.message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
