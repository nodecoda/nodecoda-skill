#!/usr/bin/env node
// scripts/grammar-coverage.mjs
// No-deps helper (Node 18+): detect grammar.ebnf drift of the class that shipped
// `else_clause_opt` — a nonterminal referenced by the pack but never defined.
//
// grammar.ebnf is an intentional SUBSET of references/grammar-reference.md, so
// "referenced but not defined in the pack" is legal for plumbing rules. The
// allowlist below names those intentional omissions. Anything referenced but
// undefined in the pack AND not allowlisted is drift and must fail validation.
//
// The allowlist is the current 31 omissions (extracted 2026-08-14). It must not
// grow silently: entries that later get defined in the pack are reported as
// "stale" so they can be removed.

export const PACK_OMITTED_NONTERMINALS = [
  'arg_list', 'array_literal', 'array_suffix_seq',
  'code_direct_output', 'code_inputs_opt', 'code_structural_output',
  'concurrency', 'conversation_decl_list',
  'enum_member_list', 'expr_or_assign_stmt',
  'field_list', 'file_ext_list', 'file_type_list', 'file_upload_list', 'for_var',
  'lambda_params_opt',
  'map_literal',
  'on_error', 'operation_policies', 'optional_suffix', 'or_expr',
  'param_list',
  'request_input_stmt', 'return_type_opt',
  'semicolon_opt', 'stmt_list',
  'ternary_expr', 'top_level_list', 'trailing_comma_opt', 'type_ref_list',
  'yield_block',
];

// Strip comments and quoted terminals, then split into { head: rhs } rules
// (rules may span continuation lines; terminals are always quoted).
export function parseRules(text) {
  let t = text.replace(/\/\/.*/g, '');
  t = t.replace(/\/\*.*?\*\//gs, '');
  t = t.replace(/"(?:[^"\\]|\\.)*"/g, '');
  const rules = {};
  let cur = null;
  for (const ln of t.split('\n')) {
    const m = /^\s*([a-z][a-z0-9_]*)\s*=(.*)$/.exec(ln);
    if (m) { cur = m[1]; rules[cur] = m[2]; }
    else if (cur !== null && ln.trim()) rules[cur] += ' ' + ln.trim();
  }
  return rules;
}

// Return { undefinedRefs, staleAllowlist }:
//  - undefinedRefs: referenced by the pack, not defined in it, not allowlisted
//  - staleAllowlist: allowlist entries that are now defined in the pack
export function findUndefinedNonterminals(ebnfText, allowlist = PACK_OMITTED_NONTERMINALS) {
  const rules = parseRules(ebnfText);
  const defined = new Set(Object.keys(rules));
  const refs = new Set();
  for (const rhs of Object.values(rules)) {
    for (const m of rhs.matchAll(/\b([a-z][a-z0-9_]*)\b/g)) refs.add(m[1]);
  }
  const allow = new Set(allowlist);
  const undefinedRefs = [...refs].filter((r) => !defined.has(r) && !allow.has(r)).sort();
  const staleAllowlist = [...allow].filter((r) => defined.has(r)).sort();
  return { undefinedRefs, staleAllowlist };
}
