// Product names for the web UI. Mirrors internal/brand (checked by
// internal/brand/brand_test.go); scripts/rename.sh updates both.

export const APP_NAME = 'webherdr';
export const APP_SLUG = 'webherdr';
/** Previous slugs, appended by scripts/rename.sh; their storage is migrated. */
export const LEGACY_SLUGS: string[] = [];

const prefix = `${APP_SLUG}.`;

// Move browser storage written under a previous product name, once.
try {
  for (const old of LEGACY_SLUGS) {
    const oldPrefix = `${old}.`;
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(oldPrefix)) continue;
      const next = prefix + key.slice(oldPrefix.length);
      if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!);
      localStorage.removeItem(key);
    }
  }
} catch {
  /* storage unavailable */
}

/** Per-browser preferences (localStorage), namespaced by the product slug. */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(prefix + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(prefix + key, value);
    } catch {
      /* storage unavailable */
    }
  },
};
