#!/usr/bin/env node
// scripts/build-skillhub.mjs
// Build a SkillHub.cn-compatible distribution package from a repo skill.
//
// Why this exists:
//   skillhub.cn applies a file-type whitelist when a skill is published
//   (.md .txt .json .yaml .yml .js .cjs .mjs .ts .py .sh .png .jpg .svg,
//   see iflytek/skillhub docs/07-skill-protocol.md §8.3). Files outside the
//   whitelist (.ncoda examples, grammar.ebnf) are silently filtered server-side,
//   which leaves manifest.json / language-pack/version.json with dangling
//   references. This script produces a self-consistent package BEFORE upload:
//     - copies only whitelisted files
//     - mirrors each examples/*.ncoda to examples/<name>.md (fenced code block)
//     - rewrites manifest.json examples to the mirrored .md files
//     - regenerates language-pack/version.json without grammar.ebnf hashes
//     - verifies internal consistency (paths exist, hashes match, whitelist clean)
//
// Pure Node 18+ built-ins (zlib.crc32 requires Node >= 20.15), no dependencies.
//
// Usage:
//   node scripts/build-skillhub.mjs                                  # default: build/skillhub/nodecoda-workflow/
//   node scripts/build-skillhub.mjs --skill <name>                   # pick a skill under skills/
//   node scripts/build-skillhub.mjs --out <dir>                      # exact destination directory
//   node scripts/build-skillhub.mjs --out /home/dev/nodecoda-workflow-1.0.0   # regenerate an existing upload dir
//   node scripts/build-skillhub.mjs --zip                            # also write a store-only .zip next to --out
//   node scripts/build-skillhub.mjs --keep                           # do not wipe an existing destination
//
// Exit: 0 ok / 1 verification failed / 2 usage or environment error

import { mkdir, readdir, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { crc32 } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

const WHITELIST = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml',
  '.js', '.cjs', '.mjs', '.ts', '.py', '.sh',
  '.png', '.jpg', '.svg',
]);
const MAX_FILE_BYTES = 1 * 1024 * 1024;   // skillhub single-file limit
const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // skillhub total limit
const MAX_FILES = 100;                    // skillhub file-count limit
const NCODA_MIRROR_LANG = 'ncoda';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: useColor ? '\x1b[0m' : '',
  red: useColor ? '\x1b[31m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  dim: useColor ? '\x1b[2m' : '',
  bold: useColor ? '\x1b[1m' : '',
};

// ---------------------------------------------------------------- args

const args = process.argv.slice(2);
let skillName = 'nodecoda-workflow';
let outDir = join(REPO_ROOT, 'build', 'skillhub', 'nodecoda-workflow');
let wantZip = false;
let keep = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--skill') skillName = args[++i];
  else if (a === '--out') outDir = args[++i];
  else if (a === '--zip') wantZip = true;
  else if (a === '--keep') keep = true;
  else if (a === '--help' || a === '-h') {
    console.log(`Usage: node scripts/build-skillhub.mjs [--skill <name>] [--out <dir>] [--zip] [--keep]`);
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}

const sourceDir = join(SKILLS_DIR, skillName);
if (!existsSync(sourceDir)) {
  console.error(`${c.red}error${c.reset}: source skill not found: ${sourceDir}`);
  process.exit(2);
}

const gitRev = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
})();

// ---------------------------------------------------------------- utils

const sortKeys = (o) => {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return o;
};
const hashJson = (data) => createHash('sha256').update(JSON.stringify(sortKeys(data))).digest('hex');
const hashText = (buf) => createHash('sha256').update(buf).digest('hex');
const isWhitelisted = (f) => WHITELIST.has(extname(f).toLowerCase());

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === '_meta.json') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------- file copy

async function build() {
  const sourceFiles = (await walk(sourceDir)).map((p) => relative(sourceDir, p));

  const copied = [];      // { rel, bytes }
  const mirrored = [];    // .ncoda -> .md mirrors
  const filtered = { ncoda: [], ebnf: [], other: [] };

  for (const rel of sourceFiles) {
    const ext = extname(rel).toLowerCase();
    const abs = join(sourceDir, rel);
    if (isWhitelisted(rel)) {
      copied.push(rel);
    } else if (ext === '.ncoda' && rel.startsWith('examples' + '/')) {
      mirrored.push(rel); // handled after copy pass
    } else if (ext === '.ncoda') {
      filtered.ncoda.push(rel);
    } else if (ext === '.ebnf') {
      filtered.ebnf.push(rel);
    } else {
      filtered.other.push(rel);
    }
  }

  // wipe destination unless --keep
  if (existsSync(outDir) && !keep) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  // 1. copy whitelisted files
  for (const rel of copied) {
    const abs = join(sourceDir, rel);
    const dest = join(outDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(abs, dest);
  }

  // 2. mirror examples/*.ncoda -> examples/<name>.md
  for (const rel of mirrored) {
    const src = await readFile(join(sourceDir, rel), 'utf8');
    const base = basename(rel, '.ncoda');
    const md = [
      `# ${base}.ncoda — SkillHub mirror (.md)`,
      '',
      `> 本文件是 NodeCoda 示例 \`${base}.ncoda\` 的 SkillHub 兼容镜像。`,
      `> SkillHub 文件白名单不含 \`.ncoda\` 扩展名，示例以 \`.md\` 形式随包发布。`,
      `> 还原方式：将下方代码块内容保存为 \`${base}.ncoda\` 即可。`,
      '',
      `\`\`\`${NCODA_MIRROR_LANG}`,
      src.replace(/\n$/, ''),
      '```',
      '',
    ].join('\n');
    const destRel = `examples/${base}.md`;
    await writeFile(join(outDir, destRel), md, 'utf8');
  }

  // 3. append mirror note to examples/README.md
  const readmeRel = 'examples/README.md';
  if (existsSync(join(outDir, readmeRel))) {
    const orig = await readFile(join(outDir, readmeRel), 'utf8');
    const lines = [
      '',
      '---',
      '',
      '## SkillHub 镜像说明',
      '',
      'SkillHub 发布版将每个 `*.ncoda` 示例额外镜像为同名 `*.md`（内容为原文件全文，',
      '包裹在 ```ncoda 代码块中），以通过平台的文件类型白名单。`manifest.json` 的',
      '`examples` 字段指向这些 `.md` 镜像。还原原始示例：复制代码块内容保存为',
      '`<name>.ncoda` 即可。',
      '',
    ];
    const table = mirrored.map((rel) => {
      const base = basename(rel, '.ncoda');
      return `| \`${rel}\` | \`examples/${base}.md\` |`;
    }).join('\n');
    if (table) {
      lines.push('| 原始 `.ncoda` | 包内 `.md` 镜像 |');
      lines.push('|---|---|');
      lines.push(table);
      lines.push('');
    }
    await writeFile(join(outDir, readmeRel), orig.replace(/\n$/, '') + '\n' + lines.join('\n'), 'utf8');
  }

  // 4. rewrite manifest.json
  const manifestPath = join(outDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (Array.isArray(manifest.examples)) {
    manifest.examples = manifest.examples.map((e) => {
      if (e.endsWith('.ncoda')) return e.replace(/\.ncoda$/, '.md');
      return e;
    });
  }
  manifest['x-skillhub-build'] = {
    tool: 'build-skillhub.mjs',
    source_rev: gitRev,
    generated_at: new Date().toISOString(),
    note: 'examples/*.ncoda mirrored to .md; grammar.ebnf excluded by skillhub whitelist',
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 5. regenerate language-pack/version.json
  const packDir = join(outDir, 'language-pack');
  const versionPath = join(packDir, 'version.json');
  if (existsSync(versionPath)) {
    const v = JSON.parse(await readFile(versionPath, 'utf8'));
    // drop hashes whose files were filtered (grammar.ebnf), recompute the rest
    const hashes = {};
    for (const [rel] of Object.entries(v.hashes ?? {})) {
      const p = join(packDir, rel);
      if (!existsSync(p)) continue; // filtered by whitelist
      const raw = await readFile(p);
      hashes[rel] = rel.endsWith('.ebnf') ? hashText(raw) : hashJson(JSON.parse(raw.toString('utf8')));
    }
    v.hashes = hashes;
    // source_hashes: recompute from the copied references
    const refsDir = join(outDir, 'references');
    const sourceHashes = {};
    for (const rel of v.source_docs ?? []) {
      const base = basename(rel);
      const p = join(refsDir, base);
      if (existsSync(p)) sourceHashes[rel] = hashText(await readFile(p));
    }
    v.source_hashes = sourceHashes;
    v.generated_at = new Date().toISOString().slice(0, 19) + 'Z';
    v.note = (v.note ? v.note + '; ' : '') +
      'skillhub build: grammar.ebnf excluded by platform whitelist, hashes scoped to shipped files';
    await writeFile(versionPath, JSON.stringify(v, null, 2) + '\n', 'utf8');
  }

  await verify(outDir, manifest);
  await report(copied, mirrored, filtered, outDir);
  if (wantZip) await writeZip(outDir);
}

// ------------------------------------------------------- verification

async function verify(dir, manifest) {
  const errors = [];
  const files = await walk(dir);
  const rels = files.map((p) => relative(dir, p));

  // a. whitelist clean
  for (const rel of rels) {
    if (!isWhitelisted(rel)) errors.push(`non-whitelisted file in build: ${rel}`);
  }
  // b. limits
  let total = 0;
  for (const p of files) {
    const st = await stat(p);
    total += st.size;
    if (st.size > MAX_FILE_BYTES) errors.push(`file exceeds 1MB limit: ${relative(dir, p)} (${st.size}b)`);
  }
  if (rels.length > MAX_FILES) errors.push(`file count ${rels.length} exceeds skillhub limit of ${MAX_FILES}`);
  if (total > MAX_TOTAL_BYTES) errors.push(`total size ${total} exceeds skillhub limit of ${MAX_TOTAL_BYTES}`);
  // c. manifest references resolve
  for (const key of ['references', 'examples']) {
    for (const rel of manifest[key] ?? []) {
      if (!existsSync(join(dir, rel))) errors.push(`manifest.${key} references missing file: ${rel}`);
    }
  }
  if (!existsSync(join(dir, manifest.entry ?? 'SKILL.md'))) errors.push(`manifest entry missing: ${manifest.entry}`);
  // d. version.json hash consistency
  const vp = join(dir, 'language-pack', 'version.json');
  if (existsSync(vp)) {
    const v = JSON.parse(await readFile(vp, 'utf8'));
    for (const [rel, expect] of Object.entries(v.hashes ?? {})) {
      const p = join(dir, 'language-pack', rel);
      if (!existsSync(p)) { errors.push(`version.json hashes missing file: ${rel}`); continue; }
      const raw = await readFile(p);
      const actual = rel.endsWith('.ebnf') ? hashText(raw) : hashJson(JSON.parse(raw.toString('utf8')));
      if (actual !== expect) errors.push(`version.json hash mismatch: ${rel}`);
    }
    for (const rel of v.source_docs ?? []) {
      const p = join(dir, 'references', basename(rel));
      if (!existsSync(p)) { errors.push(`version.json source_docs missing: ${rel}`); continue; }
      const expect = v.source_hashes?.[rel];
      if (expect === undefined) { errors.push(`version.json source_hashes missing: ${rel}`); continue; }
      if (hashText(await readFile(p)) !== expect) errors.push(`version.json source hash mismatch: ${rel}`);
    }
  }

  if (errors.length) {
    console.error(`${c.red}FAIL${c.reset} build verification:`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`${c.green}✓${c.reset} verification: whitelist clean, ${rels.length} files, ${(total / 1024).toFixed(0)} KiB total, references/examples/hashes consistent`);
}

// ------------------------------------------------------------ report

async function report(copied, mirrored, filtered, outDir) {
  console.log(`\n${c.cyan}build-skillhub${c.reset} ${c.bold}${outDir}${c.reset}`);
  console.log(`  copied whitelisted: ${copied.length}`);
  console.log(`  mirrored .ncoda -> .md: ${mirrored.length}`);
  if (filtered.ncoda.length) console.log(`  ${c.yellow}filtered .ncoda${c.reset} (outside examples): ${filtered.ncoda.length}`);
  if (filtered.ebnf.length) console.log(`  ${c.yellow}filtered .ebnf${c.reset} (grammar, excluded by whitelist): ${filtered.ebnf.length}`);
  if (filtered.other.length) console.log(`  ${c.yellow}filtered other${c.reset}: ${filtered.other.join(', ')}`);
}

// ------------------------------------------------------ zip (store)

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

async function writeZip(dir) {
  const files = (await walk(dir)).sort();
  const rels = files.map((p) => relative(dir, p).split(sep).join('/'));
  const { time, date } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (let i = 0; i < files.length; i++) {
    const buf = await readFile(files[i]);
    const name = Buffer.from(rels[i], 'utf8');
    const crc = crc32(buf) >>> 0;
    const size = buf.length;

    // local file header + name + data
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);          // signature
    local.writeUInt16LE(20, 4);                  // version needed
    local.writeUInt16LE(0x0800, 6);              // flags: UTF-8
    local.writeUInt16LE(0, 8);                   // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);                  // extra len
    localParts.push(local, name, buf);

    // central directory entry + name (collected after ALL local entries)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);             // signature
    cd.writeUInt16LE(20, 4);                     // version made by
    cd.writeUInt16LE(20, 6);                     // version needed
    cd.writeUInt16LE(0x0800, 8);                 // flags
    cd.writeUInt16LE(0, 10);                     // method: store
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);                     // extra len
    cd.writeUInt16LE(0, 32);                     // comment len
    cd.writeUInt16LE(0, 34);                     // disk start
    cd.writeUInt16LE(0, 36);                     // internal attrs
    cd.writeUInt32LE(0, 38);                     // external attrs
    cd.writeUInt32LE(offset, 42);                // local header offset
    centralParts.push(cd, name);

    offset += 30 + name.length + size;
  }

  const cdStart = offset;
  const cdSize = centralParts.reduce((n, b) => n + b.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  const zipPath = `${outDir}.zip`;
  await writeFile(zipPath, Buffer.concat([...localParts, ...centralParts, eocd]));
  const st = await stat(zipPath);
  console.log(`\n${c.green}✓${c.reset} zip written: ${zipPath} (${(st.size / 1024).toFixed(0)} KiB, ${files.length} files, store-only)`);
}

await build();
