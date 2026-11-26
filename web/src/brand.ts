// Product names for the web UI. Mirrors backend/shared/lib/brand.ts
// (checked by its brand.test.ts); scripts/rename.sh updates both.

export const APP_NAME = 'veldr';
export const APP_SLUG = 'veldr';
/** The product's domain; reversed, it begins the desktop app's id. */
export const APP_DOMAIN = 'veldr.app';

const prefix = `${APP_SLUG}.`;

/** Per-browser state (localStorage), namespaced by the product slug. */
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
  remove(key: string) {
    try {
      localStorage.removeItem(prefix + key);
    } catch {
      /* storage unavailable */
    }
  },
};
