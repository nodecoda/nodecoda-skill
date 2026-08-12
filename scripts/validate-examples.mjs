#!/usr/bin/env node
// scripts/validate-examples.mjs
// Structural syntax gate for .ncoda example files.
//
// This is NOT a full parser — the authoritative grammar lives in the main repo
// (docs/dify-dsl.y, src/nclang/lang/parser.py). The gate catches structural
// regressions that the header-only checks in validate-skill.mjs miss:
//   1. header directives present and ordered (@language before @mode)
//   2. @conversation declarations precede every top-level decl (gotcha G1)
//   3. brace/paren/bracket balance — template-string aware, so Python source
//      blocks (foreign code) and ${} interpolations never pollute the counts
//   4. top-level declaration shapes (const/type/enum/function/code/@conversation)
//   5. reserved words never used in declaration positions (gotcha G8)
//   6. mode-aware statement guards: output() only in workflow, answer() only in
//      advanced-chat; while() requires `limit N`; attempt requires success/failure
//
// Usage:
//   node scripts/validate-examples.mjs            # all skills
//   node scripts/validate-examples.mjs <skill>    # one skill
// Exit: 0 all structurally valid / 1 errors / 2 environment error.
//
// Pure Node 18+ built-ins, no dependencies.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

// Reserved words — grammar-reference.md §12 (statement/type keywords) plus §7
// (additional tokens the parser keeps; 'main' and 'enum' are NOT reserved).
const RESERVED = new Set([
  'function', 'if', 'else', 'for', 'while', 'in', 'return', 'var', 'let', 'const',
  'output', 'type', 'parallel', 'break', 'continue', 'code', 'foreign', 'source',
  'yield', 'answer', 'limit', 'attempt', 'success', 'failure', 'with', 'retry',
  'timeout', 'default', 'as', 'true', 'false', 'null',
  'string', 'int', 'float', 'bool', 'file', 'void', 'map', 'array', 'any',
  'entry', 'stream', 'request_input', 'action',
]);
const TYPE_KEYWORDS = new Set(['string', 'int', 'float', 'bool', 'file', 'void', 'map', 'array', 'any']);
const DECL_KEYWORDS = new Set(['const', 'type', 'enum', 'function', 'code']);
const MODES = new Set(['workflow', 'advanced-chat']);
const LITERAL_IDENTS = new Set(['true', 'false', 'null']);

// ---- tokenizer -------------------------------------------------------------
// Token types: 'ident' | 'string' | 'template' | 'number' | 'symbol' | 'at'
// Strings/templates are opaque single tokens; template ${...} segments are
// consumed as part of the template token so their braces never hit the balance
// pass (Python dict literals inside `source \`...\`` blocks would otherwise
// false-positive).

function skipString(src, i) {
  // src[i] is a quote; returns index just past the closing quote
  const q = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    i += 1;
  }
  return i; // unterminated
}

function skipLineComment(src, i) {
  while (i < src.length && src[i] !== '\n') i += 1;
  return i;
}

function skipBlockComment(src, i) {
  i += 2;
  while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
  return Math.min(i + 2, src.length);
}

function skipTemplate(src, i, state) {
  // src[i] is a backtick; consumes the whole template including ${...}
  // segments (which may nest strings, templates and braces). Returns index
  // just past the closing backtick (or EOF if unterminated).
  i += 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') { state.line += 1; i += 1; continue; }
    if (ch === '`') return i + 1;
    if (ch === '$' && src[i + 1] === '{') { i = skipInterpolation(src, i + 1, state); continue; }
    i += 1;
  }
  return i; // unterminated
}

function skipInterpolation(src, i, state) {
  // src[i] === '{' (after '$'); consumes balanced braces, honoring nested
  // strings/templates/comments. Returns index just past the closing '}'.
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (ch === '"' || ch === "'") { i = skipString(src, i); continue; }
    else if (ch === '`') { i = skipTemplate(src, i, state); continue; }
    else if (ch === '/' && src[i + 1] === '/') { i = skipLineComment(src, i); continue; }
    else if (ch === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue; }
    else if (ch === '\n') state.line += 1;
    i += 1;
  }
  return i; // unterminated
}

function tokenize(src) {
  const tokens = [];
  const state = { line: 1 };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { state.line += 1; i += 1; continue; }
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '/' && src[i + 1] === '/') { i = skipLineComment(src, i); continue; }
    if (ch === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue; }
    if (ch === '"' || ch === "'") {
      tokens.push({ type: 'string', line: state.line });
      i = skipString(src, i);
      continue;
    }
    if (ch === '`') {
      tokens.push({ type: 'template', line: state.line });
      i = skipTemplate(src, i, state);
      continue;
    }
    if (ch === '@') {
      tokens.push({ type: 'at', line: state.line });
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'ident', value: src.slice(i, j), line: state.line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      tokens.push({ type: 'number', value: src.slice(i, j), line: state.line });
      i = j;
      continue;
    }
    tokens.push({ type: 'symbol', value: ch, line: state.line });
    i += 1;
  }
  return tokens;
}

// ---- structural checks -----------------------------------------------------

function validateSource(src, name) {
  const errors = [];
  const warn = [];
  const err = (line, msg) => errors.push(`${name}:${line}: ${msg}`);

  // 1. header directives
  const headerLang = /^@language\s+nodecoda\/1\s*$/m;
  const headerMode = /^@mode\s+(workflow|advanced-chat)\s*$/m;
  if (!headerLang.test(src)) err(1, 'missing @language nodecoda/1 header');
  if (!headerMode.test(src)) err(1, 'missing @mode (workflow | advanced-chat) header');

  const tokens = tokenize(src);
  if (tokens.length === 0) { err(1, 'source produced no tokens'); return { errors, warn }; }

  // mode + directive order
  let mode = null;
  let firstDecl = -1;   // token index of first top-level decl keyword
  let topDepth = 0;     // brace depth while scanning directives
  const convLines = [];
  let langIdx = -1;
  let modeIdx = -1;
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.type === 'at' && tokens[idx + 1]?.type === 'ident') {
      const dir = tokens[idx + 1].value;
      if (dir === 'language') { if (langIdx === -1) langIdx = idx; }
      else if (dir === 'mode') {
        if (modeIdx === -1) modeIdx = idx;
        if (mode === null) {
          const v = tokens[idx + 2];
          let raw = v?.type === 'ident' ? v.value : null;
          // 'advanced-chat' tokenizes as ident 'advanced', symbol '-', ident 'chat'
          if (raw === 'advanced' && tokens[idx + 3]?.type === 'symbol' && tokens[idx + 3].value === '-' && tokens[idx + 4]?.type === 'ident') {
            raw = 'advanced-chat';
          }
          mode = raw;
          if (mode !== null && !MODES.has(mode)) {
            err(t.line, `@mode must be workflow | advanced-chat, got '${mode}'`);
            mode = null;
          }
        }
      } else if (dir === 'conversation') {
        convLines.push(t.line);
      }
      idx += 1; // consume the directive ident
    } else if (t.type === 'ident' && DECL_KEYWORDS.has(t.value) && firstDecl === -1 && topDepth === 0) {
      firstDecl = idx;
    } else if (t.type === 'symbol') {
      if (t.value === '{') topDepth += 1;
      else if (t.value === '}') topDepth -= 1;
    }
  }
  if (mode === null) err(1, 'could not determine @mode (must be workflow | advanced-chat)');
  if (langIdx === -1) err(1, '@language directive missing');
  if (modeIdx === -1) err(1, '@mode directive missing');
  if (langIdx !== -1 && modeIdx !== -1 && modeIdx < langIdx) {
    err(tokens[modeIdx].line, '@mode must follow @language (grammar: language_decl_opt mode_decl_opt)');
  }
  if (firstDecl !== -1) {
    for (const cl of convLines) {
      if (tokens[firstDecl].line < cl) {
        err(cl, `@conversation must precede all top-level declarations (gotcha G1); first decl at line ${tokens[firstDecl].line}`);
      }
    }
  }

  // 2. brace / paren / bracket balance (template/string tokens are opaque)
  const open = { '(': ')', '[': ']', '{': '}' };
  const close = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (const t of tokens) {
    if (t.type !== 'symbol') continue;
    if (open[t.value]) stack.push({ ch: t.value, line: t.line });
    else if (close[t.value]) {
      const top = stack.pop();
      if (!top || top.ch !== close[t.value]) {
        err(t.line, `unbalanced '${t.value}' (expected '${open[top?.ch ?? ''] ?? 'open token'}')`);
      }
    }
  }
  for (const left of stack) {
    err(left.line, `unclosed '${left.ch}' — missing '${open[left.ch]}'`);
  }

  // 3. top-level declaration shapes + reserved words in declaration positions
  let depth = 0; // brace depth (top-level shapes only checked at depth 0)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'symbol') {
      if (t.value === '{') depth += 1;
      else if (t.value === '}') depth -= 1;
      continue;
    }
    if (t.type !== 'ident') continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];

    // statement-level checks (valid inside function bodies)
    const stmtChecks = t.value === 'while' || t.value === 'attempt' || t.value === 'output' || t.value === 'answer' || t.value === 'let' || t.value === 'var' || t.value === 'for';
    if (depth > 0 && !stmtChecks) continue;

    // @conversation <type...> <name> [= literal] ;
    if (t.value === 'conversation' && prev?.type === 'at') {
      // the variable name is the last ident before ';' / '=' (type keywords are
      // skipped implicitly by taking the last ident)
      let k = i + 1;
      let lastIdent = null;
      while (k < tokens.length && !(tokens[k].type === 'symbol' && (tokens[k].value === ';' || tokens[k].value === '='))) {
        if (tokens[k].type === 'ident') lastIdent = tokens[k];
        k += 1;
      }
      if (lastIdent) {
        if (RESERVED.has(lastIdent.value)) err(lastIdent.line, `@conversation variable '${lastIdent.value}' is a reserved word (gotcha G8)`);
      } else {
        err(t.line, '@conversation declaration missing variable name');
      }
      i = Math.min(k, tokens.length - 1);
      continue;
    }

    // const <name> = <literal> ;
    if (t.value === 'const') {
      const nm = next;
      if (nm?.type !== 'ident') { err(t.line, "const declaration must be 'const <name> = <literal>;'"); continue; }
      if (RESERVED.has(nm.value)) err(nm.line, `const name '${nm.value}' is a reserved word (gotcha G8)`);
      const eq = tokens[i + 2];
      const lit = tokens[i + 3];
      if (eq?.type !== 'symbol' || eq.value !== '=') err(t.line, `const '${nm.value}' missing '='`);
      else if (!lit || !(lit.type === 'string' || lit.type === 'template' || lit.type === 'number' || (lit.type === 'ident' && LITERAL_IDENTS.has(lit.value)))) {
        err(t.line, `const '${nm.value}' value must be a literal (grammar const_value)`);
      } else {
        const semi = tokens[i + 4];
        if (semi?.type !== 'symbol' || semi.value !== ';') {
          err(t.line, `const '${nm.value}' value must be a single literal followed by ';' (got '${semi?.value ?? 'EOF'}')`);
        }
      }
      continue;
    }

    // type <name> = { ... } ;  /  enum <name> { ... } ;
    if (t.value === 'type' || t.value === 'enum') {
      const nm = next;
      if (nm?.type !== 'ident') { err(t.line, `${t.value} declaration must be '${t.value} <name> ...'`); continue; }
      if (RESERVED.has(nm.value)) err(nm.line, `${t.value} name '${nm.value}' is a reserved word (gotcha G8)`);
      const brace = tokens[i + 2]?.value === '=' ? tokens[i + 3] : tokens[i + 2];
      if (t.value === 'type' && tokens[i + 2]?.type === 'symbol' && tokens[i + 2].value !== '=') {
        err(t.line, `type '${nm.value}' must use 'type <name> = { ... }'`);
      }
      if (brace?.type !== 'symbol' || brace.value !== '{') {
        err(t.line, `${t.value} '${nm.value}' body must open with '{'`);
      }
      continue;
    }

    // function <name>(...) [-> type] { ... }   /   code <name>(...) -> type { ... }
    if (t.value === 'function' || t.value === 'code') {
      const nm = next;
      if (nm?.type !== 'ident') { err(t.line, `${t.value} declaration must be '${t.value} <name>(...) ...'`); continue; }
      if (RESERVED.has(nm.value)) err(nm.line, `${t.value} name '${nm.value}' is a reserved word (gotcha G8)`);
      const paren = tokens[i + 2];
      if (paren?.type !== 'symbol' || paren.value !== '(') {
        err(t.line, `${t.value} '${nm.value}' missing '(' after name`);
      } else {
        // param names: ident directly followed by ',' ')' or '=' inside the param list
        let pdepth = 0;
        for (let p = i + 2; p < tokens.length; p++) {
          const pt = tokens[p];
          if (pt.type === 'symbol' && pt.value === '(') pdepth += 1;
          else if (pt.type === 'symbol' && pt.value === ')') {
            pdepth -= 1;
            if (pdepth === 0) break;
          } else if (pt.type === 'ident' && pdepth === 1) {
            const pn = tokens[p + 1];
            if (pn?.type === 'symbol' && (pn.value === ',' || pn.value === ')') || (pn?.type === 'symbol' && pn.value === '=')) {
              if (RESERVED.has(pt.value)) err(pt.line, `parameter '${pt.value}' is a reserved word (gotcha G8)`);
            }
          }
        }
      }
      continue;
    }

    // for ( <var> in ... )  — loop variable must not be reserved
    if (t.value === 'for' && next?.type === 'symbol' && next.value === '(') {
      let j = i + 2;
      while (j < tokens.length && !(tokens[j].type === 'ident' && tokens[j].value === 'in')) j += 1;
      const loopVar = tokens[j - 1];
      if (loopVar && loopVar.type === 'ident' && RESERVED.has(loopVar.value) && !TYPE_KEYWORDS.has(loopVar.value)) {
        err(loopVar.line, `loop variable '${loopVar.value}' is a reserved word (gotcha G8)`);
      }
    }

    // let / var <name>
    if (t.value === 'let' || t.value === 'var') {
      const nm = next;
      if (nm?.type === 'ident' && RESERVED.has(nm.value)) {
        err(nm.line, `'${t.value}' variable '${nm.value}' is a reserved word (gotcha G8)`);
      }
    }

    // while ( expr ) limit <int> { ... }
    if (t.value === 'while') {
      const paren = next;
      if (paren?.type === 'symbol' && paren.value === '(') {
        let j = i + 2; let pdepth = 1;
        while (j < tokens.length && pdepth > 0) {
          if (tokens[j].type === 'symbol' && tokens[j].value === '(') pdepth += 1;
          else if (tokens[j].type === 'symbol' && tokens[j].value === ')') pdepth -= 1;
          j += 1;
        }
        const limit = tokens[j];
        const limitN = tokens[j + 1];
        const body = tokens[j + 2];
        if (limit?.type !== 'ident' || limit.value !== 'limit') err(t.line, 'while() must specify a bound: while (expr) limit N { ... }');
        else if (limitN?.type !== 'number') err(t.line, `while() limit must be an integer, got '${limitN?.value ?? 'nothing'}'`);
        else if (body?.type !== 'symbol' || body.value !== '{') err(t.line, 'while() body must open with {');
      }
    }

    // attempt <expr> as <name> { success ... failure (name) ... }
    if (t.value === 'attempt') {
      let j = i + 1;
      let sawSuccess = false;
      let sawFailure = false;
      let failureParen = false;
      while (j < tokens.length && j < i + 400) {
        if (tokens[j].type === 'ident' && tokens[j].value === 'success') sawSuccess = true;
        if (tokens[j].type === 'ident' && tokens[j].value === 'failure') {
          sawFailure = true;
          failureParen = tokens[j + 1]?.type === 'symbol' && tokens[j + 1].value === '(';
        }
        j += 1;
      }
      if (!sawSuccess || !sawFailure) err(t.line, 'attempt must contain success { ... } and failure(name) { ... } blocks');
      else if (!failureParen) err(t.line, 'attempt failure block must be failure(<name>) { ... }');
    }

    // mode-aware: output() only in workflow, answer() only in advanced-chat
    if (t.value === 'output') {
      if (mode !== 'workflow') err(t.line, 'output() is only allowed in @mode workflow');
      else if (next?.type !== 'symbol' || next.value !== '(') err(t.line, "output must be called as output(<key>, <value>);");
    }
    if (t.value === 'answer') {
      if (mode !== 'advanced-chat') err(t.line, 'answer() is only allowed in @mode advanced-chat');
      else if (next?.type !== 'symbol' || next.value !== '(') err(t.line, 'answer must be called as answer(<value>);');
    }
  }

  return { errors, warn };
}

// ---- CLI -------------------------------------------------------------------
// The CLI only runs when executed directly, so test-examples.mjs can import
// validateSource() without side effects.

async function validateSkill(skillName) {
  const errors = [];
  const warns = [];
  const skillDir = join(SKILLS_DIR, skillName);
  if (!existsSync(skillDir)) return { errors: [`skill directory not found: ${skillName}`], warns };
  const examplesDir = join(skillDir, 'examples');
  if (!existsSync(examplesDir)) return { errors, warns };
  const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.ncoda')).sort();
  for (const f of files) {
    const src = await readFile(join(examplesDir, f), 'utf8');
    const { errors: es, warn: ws } = validateSource(src, `examples/${f}`);
    errors.push(...es);
    warns.push(...ws);
  }
  return { errors, warns };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : (await readdir(SKILLS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  let totalErrors = 0;
  let totalWarns = 0;
  for (const s of targets) {
    const { errors, warns } = await validateSkill(s);
    totalErrors += errors.length;
    totalWarns += warns.length;
    if (errors.length === 0 && warns.length === 0) {
      console.log(`  ✓ ${s}: examples structurally valid`);
    } else {
      console.log(`  ${errors.length > 0 ? '✗' : '!'} ${s}: ${errors.length} error(s), ${warns.length} warning(s)`);
      for (const e of errors) console.log(`      error  ${e}`);
      for (const w of warns) console.log(`      warn   ${w}`);
    }
  }
  if (totalErrors > 0) {
    console.error(`FAIL  ${totalErrors} error(s), ${totalWarns} warning(s)`);
    process.exit(1);
  }
  console.log(`OK    ${totalWarns} warning(s)`);
  process.exit(0);
}

// Export for test-examples.mjs
export { validateSource };
