// Codex's app-server schema as validators, for the tests: the JSON schema
// Codex prints (spec/codex-app-server), kept verbatim, whose definitions
// (the top level's and v2's, one namespace) are made validators by zod's
// fromJSONSchema. The adapter reads Codex's messages leniently (members and
// values it does not know are passed over); these check that the
// recordings and what the adapter sends are what the pinned schema allows.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { REPO_ROOT } from '#shared/lib/repo.ts';

export const SPEC = join(REPO_ROOT, 'spec', 'codex-app-server');
export const SCHEMA_FILE = 'codex_app_server_protocol.schemas.json';

type Definitions = Record<string, Record<string, unknown>>;

let defs: Definitions | undefined;
const validators = new Map<string, z.ZodType>();

/** The schema's definitions in one namespace: v2's, and the top level's
 * that v2 has not (those it has are the same type), every $ref to v2's
 * made one to the namespace's (zod resolves one level of definitions). */
function definitions(): Definitions {
  if (defs) return defs;
  const root = JSON.parse(readFileSync(join(SPEC, SCHEMA_FILE), 'utf8')) as { definitions: Definitions & { v2: Definitions } };
  const flat: Definitions = { ...root.definitions.v2 };
  for (const [k, v] of Object.entries(root.definitions)) if (k !== 'v2' && !(k in flat)) flat[k] = v;
  defs = JSON.parse(JSON.stringify(flat).replaceAll('"#/definitions/v2/', '"#/definitions/')) as Definitions;
  return defs;
}

/** The validator of a definition of the schema. */
export function validator(name: string): z.ZodType {
  let v = validators.get(name);
  if (!v) {
    const d = definitions();
    if (!d[name]) throw new Error(`the schema has no ${name}`);
    v = z.fromJSONSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: d,
      ...d[name],
    } as z.core.JSONSchema.JSONSchema);
    validators.set(name, v);
  }
  return v;
}

/** Why value is not a name of the schema; "" when it is. */
export function invalid(name: string, value: unknown): string {
  const r = validator(name).safeParse(value);
  return r.success ? '' : `${name}: ${JSON.stringify(r.error.issues).slice(0, 2000)}`;
}

/** The definition of a request's params, of its answer (<Name>Response
 * beside <Name>Params) or of a notification's params, by its method: the
 * union's variant (ClientRequest, ServerRequest, ServerNotification) that
 * has it. */
export function paramsOf(union: string, method: string): string {
  type Ref = { $ref?: string; anyOf?: Ref[] };
  const u = definitions()[union] as { oneOf: Array<{ properties: { method: { enum: string[] }; params?: Ref } }> };
  const v = u.oneOf.find((x) => x.properties.method.enum[0] === method);
  if (!v) throw new Error(`${union} has no ${method}`);
  // The params, or the params or null.
  const p = v.properties.params;
  const ref = p?.$ref ?? p?.anyOf?.find((a) => a.$ref)?.$ref;
  if (!ref) throw new Error(`${union}: ${method} has no params`);
  return ref.replace('#/definitions/', '');
}

export const resultOf = (union: string, method: string): string => paramsOf(union, method).replace(/Params$/, 'Response');
