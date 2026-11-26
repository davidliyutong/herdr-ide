// Coordinates initial page bootstrap requests so settings, keybindings, hub
// config and the bundled terminal font load in parallel from module startup
// instead of waiting sequentially on first mount or font decoding.
import { currentAppearance } from './appearance';
import { storage } from './brand';
import { setLocale } from './i18n';
import { loadKeybindings } from './keybindings';
import { getPrefs } from './prefs';
import { loadSettings } from './settings';
import { useStore } from './state/store';
import { loadTermFont, type TermFontWeight } from './terminal/fonts';

const FONT_WEIGHT_KEY = 'termFontWeight';

export function cachedFontWeight(): TermFontWeight {
  try {
    return storage.get(FONT_WEIGHT_KEY) === '500' ? 500 : 400;
  } catch {
    return 400;
  }
}

export function rememberFontWeight(weight: TermFontWeight): void {
  try {
    storage.set(FONT_WEIGHT_KEY, String(weight));
  } catch {
    // Storage refused (private mode).
  }
}

/** Reads the hub's runtime flags (/api/config). Resolves to whether it succeeded. */
export async function loadConfig(): Promise<boolean> {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) return false;
    const c = await r.json();
    if (c && typeof c === 'object') {
      useStore.setState({ readOnly: !!c.read_only, sshLogin: c.ssh_login !== false });
    }
    return true;
  } catch {
    return false;
  }
}

export interface BootstrapLoads {
  readonly settings: Promise<boolean>;
  readonly keybindings: Promise<boolean>;
  readonly config: Promise<boolean>;
}

let loads: BootstrapLoads | undefined;

/** Starts initial hub fetches and terminal font preload in parallel (once per
 * page). Subsequent calls return the same promises so mounting App does not
 * duplicate requests already initiated by main.tsx. */
export function startBootstrap(opts: { preloadFont?: boolean } = {}): BootstrapLoads {
  if (loads) return loads;
  const guessedWeight = cachedFontWeight();
  if (opts.preloadFont) void loadTermFont(guessedWeight);
  const settings = loadSettings().then((ok) => {
    if (ok) {
      setLocale(getPrefs().locale);
      const actualWeight = currentAppearance().fontWeight;
      rememberFontWeight(actualWeight);
      if (opts.preloadFont && actualWeight !== guessedWeight) void loadTermFont(actualWeight);
    }
    return ok;
  });
  const keybindings = loadKeybindings();
  const config = loadConfig();
  loads = { settings, keybindings, config };
  return loads;
}

/** Retries only those initial bootstrap requests that failed transiently before
 * the event WebSocket connected, avoiding duplicate requests on normal startup. */
export async function retryFailedBootstrap(boot: BootstrapLoads): Promise<void> {
  const [settingsOk, keybindingsOk, configOk] = await Promise.all([boot.settings, boot.keybindings, boot.config]);
  const retries: Promise<unknown>[] = [];
  if (!settingsOk) {
    retries.push(
      loadSettings().then((ok) => {
        if (ok) {
          setLocale(getPrefs().locale);
          rememberFontWeight(currentAppearance().fontWeight);
        }
      }),
    );
  }
  if (!keybindingsOk) retries.push(loadKeybindings());
  if (!configOk) retries.push(loadConfig());
  if (retries.length) await Promise.all(retries);
}

/** Clears cached bootstrap state (tests only). */
export function resetBootstrapForTests(): void {
  loads = undefined;
}
