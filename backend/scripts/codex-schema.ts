// Writes the TypeScript types of Codex's app-server protocol that the chat
// host's Codex adapter speaks (features/chat/machine/codex/appserver.gen.ts)
// from the JSON schema Codex prints, kept verbatim in spec/codex-app-server
// (codex_app_server_protocol.schemas.json, of the version in VERSION); with
// --check by scripts/check.sh. spec/codex-app-server/README.md says how to
// move to another version of Codex.
//
//   bun scripts/codex-schema.ts                 writes the types
//   bun scripts/codex-schema.ts --check         writes nothing; fails if they are stale
//   bun scripts/codex-schema.ts --from DIR --version V
//       takes the schema `codex app-server generate-json-schema --experimental
//       --out DIR` wrote (codex-cli V), then writes the types
//   bun scripts/codex-schema.ts --fetch V
//       takes codex-cli V's schema from Codex's repository (the experimental
//       exports its tag rust-vV records, which that command prints), then
//       writes the types
//
// The types are those of the methods the adapter uses (REQUESTS,
// NOTIFICATIONS) and of every request of the app-server, the definitions
// they reach and the names of every method; nothing else of the schema.
// Only the JSON Schema the schema uses is translated: a keyword this script
// does not know fails it, so a newer schema is never read as something else.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import * as prettier from 'prettier';
import { REPO_ROOT } from '#shared/lib/repo.ts';

/** The schema's file, as Codex names it. */
export const SCHEMA_FILE = 'codex_app_server_protocol.schemas.json';
const SPEC = join(REPO_ROOT, 'spec', 'codex-app-server');
const OUT = join(REPO_ROOT, 'backend', 'features', 'chat', 'machine', 'codex', 'appserver.gen.ts');

/** The client's requests the adapter sends. */
const REQUESTS = [
  'initialize',
  'model/list',
  'account/read',
  'thread/start',
  'thread/resume',
  'thread/list',
  'thread/turns/list',
  'thread/compact/start',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
];

/** The app-server's notifications the adapter maps. */
const NOTIFICATIONS = [
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/commandExecution/outputDelta',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'thread/name/updated',
  'error',
  'serverRequest/resolved',
];

type Schema = { [k: string]: unknown };

/** The keywords translated, and those that change no type (annotations,
 * bounds, formats of numbers and strings). */
const TYPED = new Set([
  '$ref',
  'type',
  'enum',
  'const',
  'oneOf',
  'anyOf',
  'allOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
]);
const ANNOTATIONS = new Set([
  '$schema',
  'title',
  'description',
  'default',
  'examples',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

const isObj = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** v's JSON with its members sorted and its annotations left out: two
 * definitions with the same are the same type. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (!isObj(v)) return JSON.stringify(v);
  const keys = Object.keys(v)
    .filter((k) => !ANNOTATIONS.has(k))
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/** The definitions of the schema by their $ref, with the names they get:
 * v2's and the top level's are one namespace, a name defined in both with
 * different types gets the top level's suffixed V1. */
class Definitions {
  readonly byRef = new Map<string, { name: string; schema: Schema }>();

  constructor(root: Schema) {
    const defs = root.definitions;
    if (!isObj(defs)) throw new Error('the schema has no definitions');
    const v2 = isObj(defs.v2) ? defs.v2 : {};
    for (const [name, s] of Object.entries(v2)) {
      if (!isObj(s)) throw new Error(`v2/${name} is no schema`);
      this.byRef.set(`#/definitions/v2/${name}`, { name, schema: s });
    }
    for (const [name, s] of Object.entries(defs)) {
      if (name === 'v2') continue;
      if (!isObj(s)) throw new Error(`${name} is no schema`);
      const other = this.byRef.get(`#/definitions/v2/${name}`);
      const same = other !== undefined && canonical(other.schema) === canonical(s);
      this.byRef.set(`#/definitions/${name}`, { name: other && !same ? name + 'V1' : name, schema: same ? other.schema : s });
    }
  }

  get(ref: string): { name: string; schema: Schema } {
    const d = this.byRef.get(ref);
    if (!d) throw new Error(`no definition ${ref}`);
    return d;
  }

  /** The definition a top-level name is. */
  top(name: string): { name: string; schema: Schema } {
    return this.get(`#/definitions/${name}`);
  }
}

/** A method of a union of requests or notifications: its name and its
 * params' definition ($ref; "" for none). */
interface Method {
  method: string;
  params: string;
}

function methods(defs: Definitions, union: string): Method[] {
  const u = defs.top(union).schema;
  if (!Array.isArray(u.oneOf)) throw new Error(`${union} is no union`);
  return u.oneOf.map((v: unknown) => {
    if (!isObj(v) || !isObj(v.properties)) throw new Error(`${union}: a variant without properties`);
    const m = v.properties.method;
    if (!isObj(m) || !Array.isArray(m.enum) || m.enum.length !== 1 || typeof m.enum[0] !== 'string')
      throw new Error(`${union}: a variant without one method`);
    const p = v.properties.params;
    return { method: m.enum[0], params: isObj(p) && typeof p.$ref === 'string' ? p.$ref : '' };
  });
}

/** The answer of a request whose params are the definition params:
 * <Name>Response beside <Name>Params, as Codex names them. */
function responseOf(defs: Definitions, method: string, params: string): string {
  if (!params.endsWith('Params')) throw new Error(`${method}: params ${params} are not named <Name>Params`);
  const ref = params.slice(0, -'Params'.length) + 'Response';
  if (!defs.byRef.has(ref)) throw new Error(`${method}: no answer ${ref}`);
  return ref;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));
const literal = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  throw new Error(`a value that is no literal: ${JSON.stringify(v)}`);
};

/** A comment of a description. */
function doc(s: unknown, indent = ''): string {
  if (typeof s !== 'string' || s.trim() === '') return '';
  const lines = s.trim().replaceAll('*/', '*\\/').split('\n');
  return indent + '/**\n' + lines.map((l) => (indent + ' * ' + l).trimEnd()).join('\n') + '\n' + indent + ' */\n';
}

/** Translates schemas to TypeScript, collecting the definitions they
 * reach. */
class Writer {
  readonly reached = new Set<string>();
  private readonly queue: string[] = [];
  private readonly defs: Definitions;

  constructor(defs: Definitions) {
    this.defs = defs;
  }

  /** The type of a definition, reached. */
  ref(ref: string): string {
    const d = this.defs.get(ref);
    if (!this.reached.has(ref)) {
      this.reached.add(ref);
      this.queue.push(ref);
    }
    return d.name;
  }

  /** The definitions reached and not written yet. */
  next(): string | undefined {
    return this.queue.shift();
  }

  type(s: unknown, at: string): string {
    if (s === true) return 'unknown';
    if (s === false) return 'never';
    if (!isObj(s)) throw new Error(`${at}: no schema`);
    for (const k of Object.keys(s)) if (!TYPED.has(k) && !ANNOTATIONS.has(k)) throw new Error(`${at}: the keyword ${k} is not translated`);
    const parts: string[] = [];
    if (typeof s.$ref === 'string') parts.push(this.ref(s.$ref));
    if ('const' in s) parts.push(literal(s.const));
    if (Array.isArray(s.enum)) parts.push(s.enum.map(literal).join(' | ') || 'never');
    for (const k of ['oneOf', 'anyOf'] as const) {
      const list = s[k];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new Error(`${at}: ${k} is no list`);
      parts.push('(' + list.map((v, i) => this.type(v, `${at}/${k}/${i}`)).join(' | ') + ')');
    }
    if (s.allOf !== undefined) {
      if (!Array.isArray(s.allOf)) throw new Error(`${at}: allOf is no list`);
      parts.push(s.allOf.map((v, i) => '(' + this.type(v, `${at}/allOf/${i}`) + ')').join(' & '));
    }
    const shape = this.shape(s, at);
    if (shape !== '') parts.push(shape);
    if (parts.length === 0) return 'unknown';
    return parts.length === 1 ? parts[0]! : parts.map((p) => '(' + p + ')').join(' & ');
  }

  /** What type, properties and items say; "" when they say nothing. An
   * enum's values are its type: its type keyword adds nothing. */
  private shape(s: Schema, at: string): string {
    const declared = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
    const hasObject = s.properties !== undefined || s.additionalProperties !== undefined;
    const types = declared.length === 0 && hasObject ? ['object'] : declared;
    if (types.length === 0) return '';
    const out: string[] = [];
    for (const t of types) {
      switch (t) {
        case 'string':
        case 'integer':
        case 'number':
        case 'boolean':
          if (Array.isArray(s.enum) || 'const' in s) {
            if (types.length > 1) throw new Error(`${at}: an enum of several types`);
            return '';
          }
          out.push(t === 'integer' ? 'number' : t);
          break;
        case 'null':
          out.push('null');
          break;
        case 'array': {
          if (s.items === undefined) out.push('unknown[]');
          else if (Array.isArray(s.items)) out.push('[' + s.items.map((v, i) => this.type(v, `${at}/items/${i}`)).join(', ') + ']');
          else out.push('Array<' + this.type(s.items, `${at}/items`) + '>');
          break;
        }
        case 'object':
          out.push(this.object(s, at));
          break;
        default:
          throw new Error(`${at}: the type ${JSON.stringify(t)} is not translated`);
      }
    }
    return out.join(' | ');
  }

  private object(s: Schema, at: string): string {
    const props = s.properties === undefined ? {} : s.properties;
    if (!isObj(props)) throw new Error(`${at}: properties are no object`);
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const members: string[] = [];
    for (const name of Object.keys(props)) {
      const p = props[name];
      members.push(
        doc(isObj(p) ? p.description : undefined) +
          key(name) +
          (required.has(name) ? '' : '?') +
          ': ' +
          this.type(p, `${at}/${name}`) +
          ';',
      );
    }
    const extra = s.additionalProperties;
    if (extra !== undefined && extra !== false)
      members.push('[key: string]: ' + (extra === true ? 'unknown' : this.type(extra, `${at}/*`)) + ';');
    else if (extra === undefined && Object.keys(props).length === 0) members.push('[key: string]: unknown;');
    return '{\n' + members.join('\n') + '\n}';
  }
}

/** The module of the types of schema (Codex's schema of version). */
export function generate(schemaText: string, version: string): string {
  const root = JSON.parse(schemaText) as Schema;
  const defs = new Definitions(root);
  const w = new Writer(defs);
  const sha = createHash('sha256').update(schemaText).digest('hex');
  const clientRequests = methods(defs, 'ClientRequest');
  const clientNotifications = methods(defs, 'ClientNotification');
  const serverRequests = methods(defs, 'ServerRequest');
  const serverNotifications = methods(defs, 'ServerNotification');

  const names = (ms: Method[]) => ms.map((m) => JSON.stringify(m.method)).join(' | ');
  const pick = (ms: Method[], want: string[], union: string) =>
    want.map((name) => {
      const m = ms.find((x) => x.method === name);
      if (!m) throw new Error(`${union} has no method ${name}`);
      return m;
    });

  let out = `// Codex's app-server protocol, codex-cli ${version}: the types of the
// methods the chat host's Codex adapter uses and of every request of the
// app-server. Generated by backend/scripts/codex-schema.ts from the JSON
// schema Codex prints (\`codex app-server generate-json-schema
// --experimental\`), kept in spec/codex-app-server: do not edit, generate
// them again (spec/codex-app-server/README.md).

/** The version of Codex the schema is of. */
export const CODEX_VERSION = ${JSON.stringify(version)};
/** The SHA-256 of the schema the types were made of. */
export const SCHEMA_SHA256 = ${JSON.stringify(sha)};

/** The methods of the client's notifications. */
export type ClientNotificationMethod = ${names(clientNotifications)};
/** The methods of the app-server's requests. */
export type ServerRequestMethod = ${names(serverRequests)};
/** The methods of the app-server's notifications. */
export type ServerNotificationMethod = ${names(serverNotifications)};

`;
  const call = (m: Method) => {
    if (m.params === '') throw new Error(`${m.method} has no params`);
    return `  ${JSON.stringify(m.method)}: { params: ${w.ref(m.params)}; result: ${w.ref(responseOf(defs, m.method, m.params))} };`;
  };
  out += '/** The requests the adapter sends: their params and results by method. */\n';
  out += 'export interface ClientRequests {\n' + pick(clientRequests, REQUESTS, 'ClientRequest').map(call).join('\n') + '\n}\n\n';
  out += "/** The app-server's requests: their params and the answers by method. */\n";
  out += 'export interface ServerRequests {\n' + serverRequests.map(call).join('\n') + '\n}\n\n';
  out += "/** The app-server's notifications the adapter maps: their params by method. */\n";
  out +=
    'export interface ServerNotifications {\n' +
    pick(serverNotifications, NOTIFICATIONS, 'ServerNotification')
      .map((m) => `  ${JSON.stringify(m.method)}: ${m.params === '' ? 'null' : w.ref(m.params)};`)
      .join('\n') +
    '\n}\n';

  const written: Array<[string, string]> = [];
  for (let ref = w.next(); ref !== undefined; ref = w.next()) {
    const d = defs.get(ref);
    written.push([d.name, doc(d.schema.description) + `export type ${d.name} = ${w.type(d.schema, ref)};\n`]);
  }
  const seen = new Set<string>();
  for (const [name, text] of written.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (seen.has(name)) continue;
    seen.add(name);
    out += '\n' + text;
  }
  return out;
}

/** The module formatted as the repository's prettier formats it. */
async function formatted(text: string): Promise<string> {
  const config = (await prettier.resolveConfig(OUT)) ?? {};
  return prettier.format(text, { ...config, parser: 'typescript' });
}

const REPOSITORY = 'https://raw.githubusercontent.com/openai/codex';
const EXPORTS = 'codex-rs/app-server-protocol/schema/precomputed/app-server-exports-experimental.json.zst';

/** codex-cli version's schema from Codex's repository: the file of the
 * experimental exports its tag records. */
async function fetchSchema(version: string): Promise<string> {
  const url = `${REPOSITORY}/rust-v${version}/${EXPORTS}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const exports = JSON.parse(zstdDecompressSync(Buffer.from(await res.arrayBuffer())).toString('utf8')) as {
    json_schema?: Record<string, string>;
  };
  const text = exports.json_schema?.[SCHEMA_FILE];
  if (typeof text !== 'string') throw new Error(`${url} has no ${SCHEMA_FILE}`);
  return text;
}

if (import.meta.main) {
  const { values: f } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      from: { type: 'string' },
      fetch: { type: 'string' },
      version: { type: 'string' },
    },
  });
  if (f.from !== undefined || f.fetch !== undefined) {
    const version = f.fetch ?? f.version;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('--from needs --version V, --fetch a version (0.171.0)');
    const text = f.fetch !== undefined ? await fetchSchema(version) : readFileSync(join(f.from!, SCHEMA_FILE), 'utf8');
    JSON.parse(text);
    writeFileSync(join(SPEC, SCHEMA_FILE), text);
    writeFileSync(join(SPEC, 'VERSION'), version + '\n');
  }
  const version = readFileSync(join(SPEC, 'VERSION'), 'utf8').trim();
  const want = await formatted(generate(readFileSync(join(SPEC, SCHEMA_FILE), 'utf8'), version));
  if (f.check) {
    let have = '';
    try {
      have = readFileSync(OUT, 'utf8');
    } catch {
      // missing: stale
    }
    if (have !== want) {
      console.error(
        `codex-schema: stale: ${OUT} is not what spec/codex-app-server/${SCHEMA_FILE} makes (run \`bun scripts/codex-schema.ts\`)`,
      );
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, want);
  }
}
