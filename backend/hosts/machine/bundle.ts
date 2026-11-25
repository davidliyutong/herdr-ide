// The machine bundle: hosts/machine/main.ts and what it imports, built by
// Bun into one JavaScript file that the Bun runtime uploaded to a machine
// runs (docs/features/42-typescript-backend.md, "The machine side"). It
// carries the machine side only: the core (kernel/, the core's hosts, the
// features' core.ts), the web UI and the payloads the core embeds stay out,
// which buildBundle checks.
import { relative } from 'node:path';

/** The files of the backend a bundle may not include: the core and its
 * hosts, the features' core sides and their tests' helpers. */
const FORBIDDEN = [
  /^kernel\//,
  /^hosts\/(bun|common|electron)\//,
  /^features\/[^/]+\/core\.ts$/,
  /^features\/[^/]+\/(testdata|testing)/,
  /\.test\.ts$/,
  /(^|\/)web\//,
  /(^|\/)dist\//,
];

/** The modules of the bundle that it may not include. */
export function forbiddenInputs(inputs: string[]): string[] {
  return inputs.filter((p) => !p.includes('node_modules/') && FORBIDDEN.some((re) => re.test(p)));
}

/** Builds the bundle of version; its text and the modules it includes
 * (relative to backend/). Fails when it includes a forbidden one or a
 * package Bun would load at run time. */
export async function buildBundle(version: string): Promise<{ js: string; inputs: string[] }> {
  const root = `${import.meta.dir}/../..`;
  const r = await Bun.build({
    entrypoints: [`${import.meta.dir}/main.ts`],
    target: 'bun',
    minify: { syntax: true, whitespace: true },
    define: { BUILD_VERSION: JSON.stringify(version) },
    metafile: true,
  });
  if (!r.success) throw new AggregateError(r.logs, 'the machine bundle did not build');
  const meta = (r as unknown as { metafile: { inputs: Record<string, unknown> } }).metafile;
  const inputs = Object.keys(meta.inputs).map((p) => (p.startsWith('/') ? relative(root, p) : p));
  const bad = forbiddenInputs(inputs);
  if (bad.length) throw new Error(`the machine bundle includes what is not the machine side's:\n${bad.join('\n')}`);
  const js = await r.outputs[0].text();
  return { js, inputs };
}
