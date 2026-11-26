// herdr's agent detection manifests (herdr v0.9.5, Apache-2.0,
// licenses/herdr-detect), unchanged, embedded as text in the machine build
// and parsed once on first use (./manifests).
import amp from './manifests/amp.toml' with { type: 'text' };
import antigravity from './manifests/antigravity.toml' with { type: 'text' };
import claude from './manifests/claude.toml' with { type: 'text' };
import cline from './manifests/cline.toml' with { type: 'text' };
import codex from './manifests/codex.toml' with { type: 'text' };
import cursor from './manifests/cursor.toml' with { type: 'text' };
import devin from './manifests/devin.toml' with { type: 'text' };
import droid from './manifests/droid.toml' with { type: 'text' };
import gemini from './manifests/gemini.toml' with { type: 'text' };
import githubCopilot from './manifests/github-copilot.toml' with { type: 'text' };
import grok from './manifests/grok.toml' with { type: 'text' };
import hermes from './manifests/hermes.toml' with { type: 'text' };
import kilo from './manifests/kilo.toml' with { type: 'text' };
import kimi from './manifests/kimi.toml' with { type: 'text' };
import kiro from './manifests/kiro.toml' with { type: 'text' };
import letta from './manifests/letta.toml' with { type: 'text' };
import maki from './manifests/maki.toml' with { type: 'text' };
import muse from './manifests/muse.toml' with { type: 'text' };
import opencode from './manifests/opencode.toml' with { type: 'text' };
import pi from './manifests/pi.toml' with { type: 'text' };
import qodercli from './manifests/qodercli.toml' with { type: 'text' };
import qwen from './manifests/qwen.toml' with { type: 'text' };
import { parseManifest, type Manifest } from './manifest.ts';

/** The manifests' files, by name. */
export const MANIFEST_FILES: Readonly<Record<string, string>> = {
  'amp.toml': amp,
  'antigravity.toml': antigravity,
  'claude.toml': claude,
  'cline.toml': cline,
  'codex.toml': codex,
  'cursor.toml': cursor,
  'devin.toml': devin,
  'droid.toml': droid,
  'gemini.toml': gemini,
  'github-copilot.toml': githubCopilot,
  'grok.toml': grok,
  'hermes.toml': hermes,
  'kilo.toml': kilo,
  'kimi.toml': kimi,
  'kiro.toml': kiro,
  'letta.toml': letta,
  'maki.toml': maki,
  'muse.toml': muse,
  'opencode.toml': opencode,
  'pi.toml': pi,
  'qodercli.toml': qodercli,
  'qwen.toml': qwen,
};

let parsed: ReadonlyMap<string, Manifest> | undefined;

/** The embedded manifests by agent id; throws when one does not parse
 * (the tests make sure none fails). */
export function manifests(): ReadonlyMap<string, Manifest> {
  if (!parsed) {
    const out = new Map<string, Manifest>();
    for (const [name, text] of Object.entries(MANIFEST_FILES)) {
      try {
        const m = parseManifest(text as string);
        out.set(m.id, m);
      } catch (e) {
        throw new Error(`${name}: ${(e as Error).message}`);
      }
    }
    parsed = out;
  }
  return parsed;
}

/** The manifest of an agent id; undefined without one. */
export const manifestFor = (agent: string): Manifest | undefined => manifests().get(agent);
