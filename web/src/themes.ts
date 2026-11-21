// The color themes of the chrome (design/tokens.json `themes`): each one is
// an accent and the text on it, in the dark and the light theme; the
// neutrals are the same in all. The first is the default; another is
// selected by <html data-accent="id"> (tokens.css).
import tokens from '../../design/tokens.json';

export interface ColorTheme {
  id: string;
  accent: { light: string; dark: string };
  onAccent: { light: string; dark: string };
}

export const colorThemes: readonly ColorTheme[] = tokens.themes;

export const DEFAULT_COLOR_THEME = colorThemes[0].id;

/** The data-accent attribute for a theme: none for the default one or an
 * unknown id (a newer client's), which shows the default. */
export function accentAttribute(id: string | undefined): string | undefined {
  return id && id !== DEFAULT_COLOR_THEME && colorThemes.some((t) => t.id === id) ? id : undefined;
}
