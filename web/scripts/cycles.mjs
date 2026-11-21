#!/usr/bin/env node
// Fails when the web UI's production modules import each other in a cycle.
//
// An edge is an import that exists at run time: `import … from`, a
// side-effect `import '…'`, `export … from` and a dynamic `import('…')` of a
// relative path that resolves to a .ts or .tsx file below src. Imports the
// compiler erases are no edges: `import type`, `export type … from`, and a
// clause whose specifiers are all `type` ones. Tests (__tests__) are not
// production modules. The strongly connected components with more than one
// module (or a module importing itself) are the cycles; each is printed with
// one import path through it.
//
// Usage: node scripts/cycles.mjs [src directory]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src'));

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') out.push(...sources(path));
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

// The text without comments, and with the contents of template literals
// blanked, so that an import named in either is not taken for one. String
// literals stay: module specifiers are strings.
function code(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
      out += '``';
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Whether an import or export clause (the text between the keyword and
// `from`) names nothing that exists at run time.
function erased(clause) {
  const text = clause.trim();
  if (/^type\b/.test(text) && !/^type\s*(,|$)/.test(text)) return true;
  const braces = /^\{([^}]*)\}$/.exec(text);
  if (!braces) return false;
  const names = braces[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((s) => /^type\s/.test(s));
}

function specifiers(text) {
  const out = [];
  const src = code(text);
  const from = /(?:^|[\n;}])\s*(?:import|export)\b([^'";]*?)\bfrom\s*(['"])([^'"\n]+)\2/g;
  for (let m; (m = from.exec(src));) if (!erased(m[1])) out.push(m[3]);
  const bare = /(?:^|[\n;}])\s*import\s*(['"])([^'"\n]+)\1/g;
  for (let m; (m = bare.exec(src));) out.push(m[2]);
  const dynamic = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  for (let m; (m = dynamic.exec(src));) out.push(m[2]);
  return out;
}

function resolveModule(file, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(file), spec.replace(/\?.*$/, ''));
  for (const path of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(path) && existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

const files = sources(root);
const known = new Set(files);
const graph = new Map();
for (const file of files) {
  const targets = new Set();
  for (const spec of specifiers(readFileSync(file, 'utf8'))) {
    const target = resolveModule(file, spec);
    if (target && known.has(target)) targets.add(target);
  }
  graph.set(file, [...targets].sort());
}

// Tarjan's strongly connected components, without recursion.
function components() {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  let next = 0;
  for (const start of files) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [node, edge] = frame;
      if (edge === 0) {
        index.set(node, next);
        low.set(node, next);
        next++;
        stack.push(node);
        onStack.add(node);
      }
      const targets = graph.get(node);
      if (edge < targets.length) {
        frame[1]++;
        const target = targets[edge];
        if (!index.has(target)) work.push([target, 0]);
        else if (onStack.has(target)) low.set(node, Math.min(low.get(node), index.get(target)));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const members = [];
        for (let top; (top = stack.pop()) !== undefined;) {
          onStack.delete(top);
          members.push(top);
          if (top === node) break;
        }
        if (members.length > 1 || targets.includes(node)) out.push(members.sort());
      }
    }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

// One shortest import path from a component's first module back to itself.
function loop(members) {
  const inside = new Set(members);
  const start = members[0];
  const from = new Map();
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    for (const target of graph.get(node)) {
      if (!inside.has(target)) continue;
      if (target === start) {
        const path = [start];
        for (let at = node; at !== start; at = from.get(at)) path.push(at);
        path.push(start);
        return path.reverse();
      }
      if (!from.has(target)) {
        from.set(target, node);
        queue.push(target);
      }
    }
  }
  return [start];
}

const name = (file) => relative(root, file).split(sep).join('/');
const cycles = components();
if (cycles.length === 0) {
  console.log(`no import cycles in ${files.length} modules`);
  process.exit(0);
}
console.error(`${cycles.length} import cycle${cycles.length === 1 ? '' : 's'} in ${name(root) || 'src'}:`);
for (const members of cycles) {
  console.error(`\n  ${members.length} module${members.length === 1 ? '' : 's'}: ${members.map(name).join(', ')}`);
  console.error(`    ${loop(members).map(name).join(' -> ')}`);
}
process.exit(1);
