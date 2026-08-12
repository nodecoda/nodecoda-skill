#!/usr/bin/env node
// scripts/test-examples.mjs
// Regression tests for scripts/validate-examples.mjs (the structural .ncoda
// example gate). Guards the gate itself:
//   1. every real example under skills/*/examples/*.ncoda passes
//   2. synthetic broken sources are rejected with the expected error class
// Pure Node 18+ built-ins, no dependencies.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSource } from './validate-examples.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

let passed = 0;
let failed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };
const bad = (m, detail) => { failed += 1; console.log(`  ✗ ${m}${detail ? `\n      ${detail}` : ''}`); };

const hasErr = (res, re) => res.errors.some((e) => re.test(e));

// ---- 1. every real example passes the gate --------------------------------
const skills = (await readdir(SKILLS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory());
let exampleCount = 0;
for (const s of skills) {
  const examplesDir = join(SKILLS_DIR, s.name, 'examples');
  if (!existsSync(examplesDir)) continue;
  const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.ncoda')).sort();
  for (const f of files) {
    exampleCount += 1;
    const src = await readFile(join(examplesDir, f), 'utf8');
    const res = validateSource(src, `examples/${f}`);
    if (res.errors.length === 0) ok(`${s.name}/examples/${f} structurally valid`);
    else bad(`${s.name}/examples/${f} should pass the gate`, res.errors.join('\n      '));
  }
}
if (exampleCount === 0) bad('no .ncoda examples found anywhere', 'gate has nothing to protect');

// ---- 2. synthetic broken sources must be rejected -------------------------
const HEAD = '@language nodecoda/1\n@mode workflow\n';
const broken = [
  {
    name: 'unbalanced brace',
    src: `${HEAD}function main(string q) -> string {\n    return q;\n`,
    re: /unclosed '\{'/,
  },
  {
    name: '@conversation after top-level decl (G1)',
    src: `@language nodecoda/1\n@mode advanced-chat\nconst MODEL = "x";\n@conversation string c = "";\nfunction main() { return "ok"; }\n`,
    re: /@conversation must precede all top-level declarations/,
  },
  {
    name: 'reserved word as let variable (G8)',
    src: `${HEAD}function main(string q) -> string {\n    let code = q;\n    return code;\n}\n`,
    re: /'let' variable 'code' is a reserved word/,
  },
  {
    name: 'reserved word as parameter (G8)',
    src: `${HEAD}function main(string for) -> string { return for; }\n`,
    re: /parameter 'for' is a reserved word/,
  },
  {
    name: 'output() in advanced-chat',
    src: `@language nodecoda/1\n@mode advanced-chat\nfunction main(string q) -> string {\n    output("k", q);\n    return q;\n}\n`,
    re: /output\(\) is only allowed in @mode workflow/,
  },
  {
    name: 'answer() in workflow',
    src: `${HEAD}function main(string q) -> string {\n    answer(q);\n    return q;\n}\n`,
    re: /answer\(\) is only allowed in @mode advanced-chat/,
  },
  {
    name: 'while without limit bound',
    src: `${HEAD}function main(int n) -> int {\n    while (n > 0) { n = n - 1; }\n    return n;\n}\n`,
    re: /while\(\) must specify a bound/,
  },
  {
    name: 'const with non-literal value',
    src: `${HEAD}const X = 1 + 2;\nfunction main() -> string { return "x"; }\n`,
    re: /const 'X' value must be a single literal/,
  },
  {
    name: 'missing @language header',
    src: `@mode workflow\nfunction main() -> string { return "x"; }\n`,
    re: /missing @language nodecoda\/1 header/,
  },
  {
    name: 'attempt without failure block',
    src: `${HEAD}function main() -> string {\n    attempt http("GET", "u") as r { success { return r.body; } }\n}\n`,
    re: /attempt must contain success/,
  },
];
for (const { name, src, re } of broken) {
  const res = validateSource(src, name);
  if (hasErr(res, re)) ok(`rejects: ${name}`);
  else bad(`rejects: ${name}`, `expected /${re}/ but got:\n      ${res.errors.join('\n      ') || '(no errors)'}`);
}

// ---- 3. tricky-but-valid sources must NOT be rejected ----------------------
const valid = [
  {
    name: 'foreign code python braces stay opaque',
    src: `${HEAD}type T = { int a; }\nfunction main(string t) -> T {\n    let s = foreign code python3(string text = t) -> { a: int; } {\n        source \`def main(text: str) -> dict:\n    return {"a": len({"x": 1})}\`;\n    };\n    return s;\n}\n`,
  },
  {
    name: 'template interpolation with nested string',
    src: `${HEAD}function main(string t) -> string {\n    let r = llm("m", { "messages": [{ "role": "user", "content": \`a \${t} \${"x".contains("x") ? "y" : "z"}\` }] });\n    return r.text;\n}\n`,
  },
  {
    name: 'advanced-chat with @conversation + answer',
    src: `@language nodecoda/1\n@mode advanced-chat\n@conversation string c = "";\nfunction main(string q) -> string {\n    c = "hi";\n    answer(q);\n    return q;\n}\n`,
  },
  {
    name: 'while with limit + else-if chain + ternary',
    src: `${HEAD}function main(int n) -> int {\n    while (n > 0) limit 10 { n = n - 1; }\n    if (n == 0) { return 0; } else if (n > 0) { return 1; } else { return n > 2 ? 2 : 3; }\n}\n`,
  },
  {
    name: 'parallel named branches + yield',
    src: `${HEAD}const M = "m";\nfunction main(string t) -> string {\n    let r = parallel { a: { let x = llm(M, { "messages": [] }); yield x.text; } b: { yield t; } };\n    return r.a;\n}\n`,
  },
];
for (const { name, src } of valid) {
  const res = validateSource(src, name);
  if (res.errors.length === 0) ok(`accepts: ${name}`);
  else bad(`accepts: ${name}`, res.errors.join('\n      '));
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
