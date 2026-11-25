// herdr's agent detection manifests (herdr v0.9.5, Apache-2.0,
// licenses/herdr-detect), unchanged, embedded as text in the machine build
// and parsed once on first use. They are the Go agent's files
// (internal/agent/detect/manifests) while both builds exist: one copy, read
// by both.
import amp from '../../../../../internal/agent/detect/manifests/amp.toml' with { type: 'text' };
import antigravity from '../../../../../internal/agent/detect/manifests/antigravity.toml' with { type: 'text' };
import claude from '../../../../../internal/agent/detect/manifests/claude.toml' with { type: 'text' };
import cline from '../../../../../internal/agent/detect/manifests/cline.toml' with { type: 'text' };
import codex from '../../../../../internal/agent/detect/manifests/codex.toml' with { type: 'text' };
import cursor from '../../../../../internal/agent/detect/manifests/cursor.toml' with { type: 'text' };
import devin from '../../../../../internal/agent/detect/manifests/devin.toml' with { type: 'text' };
import droid from '../../../../../internal/agent/detect/manifests/droid.toml' with { type: 'text' };
import gemini from '../../../../../internal/agent/detect/manifests/gemini.toml' with { type: 'text' };
import githubCopilot from '../../../../../internal/agent/detect/manifests/github-copilot.toml' with { type: 'text' };
import grok from '../../../../../internal/agent/detect/manifests/grok.toml' with { type: 'text' };
import hermes from '../../../../../internal/agent/detect/manifests/hermes.toml' with { type: 'text' };
import kilo from '../../../../../internal/agent/detect/manifests/kilo.toml' with { type: 'text' };
import kimi from '../../../../../internal/agent/detect/manifests/kimi.toml' with { type: 'text' };
import kiro from '../../../../../internal/agent/detect/manifests/kiro.toml' with { type: 'text' };
import letta from '../../../../../internal/agent/detect/manifests/letta.toml' with { type: 'text' };
import maki from '../../../../../internal/agent/detect/manifests/maki.toml' with { type: 'text' };
import muse from '../../../../../internal/agent/detect/manifests/muse.toml' with { type: 'text' };
import opencode from '../../../../../internal/agent/detect/manifests/opencode.toml' with { type: 'text' };
import pi from '../../../../../internal/agent/detect/manifests/pi.toml' with { type: 'text' };
import qodercli from '../../../../../internal/agent/detect/manifests/qodercli.toml' with { type: 'text' };
import qwen from '../../../../../internal/agent/detect/manifests/qwen.toml' with { type: 'text' };
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
