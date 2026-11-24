// Terminal color schemes the settings offer (terminal.colorScheme.dark and
// .light, backend/kernel/config/ui SCHEMES): "default" is the design tokens'
// colors of the theme in use, the others are the schemes of those names as
// terminal emulators ship them. The user's own colors
// (terminal.colors.<theme>.*) replace a scheme's.

import { builtinDefaults } from '../settings';

export interface SchemeColors {
  foreground: string;
  background: string;
  cursor: string;
  selection: string;
  /** Black, red, green, yellow, blue, magenta, cyan, white, then bright. */
  palette: string[];
}

const scheme = (background: string, foreground: string, cursor: string, selection: string, palette: string): SchemeColors => ({
  background,
  foreground,
  cursor,
  selection,
  palette: palette.split(' '),
});

const solarized =
  '#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #002b36 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3';

/** The schemes other than "default". */
export const schemes: Record<string, SchemeColors> = {
  dracula: scheme(
    '#282a36',
    '#f8f8f2',
    '#f8f8f2',
    '#44475a',
    '#21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff',
  ),
  'gruvbox-dark': scheme(
    '#282828',
    '#ebdbb2',
    '#ebdbb2',
    '#504945',
    '#282828 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2',
  ),
  'gruvbox-light': scheme(
    '#fbf1c7',
    '#3c3836',
    '#3c3836',
    '#d5c4a1',
    '#fbf1c7 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #7c6f64 #928374 #9d0006 #79740e #b57614 #076678 #8f3f71 #427b58 #3c3836',
  ),
  nord: scheme(
    '#2e3440',
    '#d8dee9',
    '#d8dee9',
    '#434c5e',
    '#3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4',
  ),
  'one-dark': scheme(
    '#282c34',
    '#abb2bf',
    '#528bff',
    '#3e4451',
    '#282c34 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf #5c6370 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #ffffff',
  ),
  'one-light': scheme(
    '#fafafa',
    '#383a42',
    '#526fff',
    '#e5e5e6',
    '#383a42 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #a0a1a7 #696c77 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #fafafa',
  ),
  'solarized-dark': scheme('#002b36', '#839496', '#93a1a1', '#073642', solarized),
  'solarized-light': scheme('#fdf6e3', '#657b83', '#586e75', '#eee8d5', solarized),
  tomorrow: scheme(
    '#ffffff',
    '#4d4d4c',
    '#4d4d4c',
    '#d6d6d6',
    '#000000 #c82829 #718c00 #eab700 #4271ae #8959a8 #3e999f #d6d6d6 #8e908c #c82829 #718c00 #eab700 #4271ae #8959a8 #3e999f #ffffff',
  ),
  'tomorrow-night': scheme(
    '#1d1f21',
    '#c5c8c6',
    '#c5c8c6',
    '#373b41',
    '#1d1f21 #cc6666 #b5bd68 #f0c674 #81a2be #b294bb #8abeb7 #c5c8c6 #969896 #cc6666 #b5bd68 #f0c674 #81a2be #b294bb #8abeb7 #ffffff',
  ),
};

/** The colors a scheme gives a theme ("default": the theme's tokens). */
export function schemeColors(id: string, theme: 'dark' | 'light'): SchemeColors {
  const own = schemes[id];
  if (own) return own;
  const p = `terminal.colors.${theme}.`;
  return {
    foreground: builtinDefaults[p + 'foreground'] as string,
    background: builtinDefaults[p + 'background'] as string,
    cursor: builtinDefaults[p + 'cursor'] as string,
    selection: builtinDefaults[p + 'selection'] as string,
    palette: builtinDefaults[p + 'palette'] as string[],
  };
}

/** The names of the 16 ANSI colors, as translation keys' suffixes. */
export const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
