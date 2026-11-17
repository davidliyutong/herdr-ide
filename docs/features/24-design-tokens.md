# 24 · Design tokens and design language

## Context

The web UI (`web/`, also inside the Electron desktop shell) is drawn with
CSS in one design language: neutral greys, one accent color for focus,
the selection and what asks for the user, color otherwise only for state,
dense rows of one height, toolbars of one height, a 4/6/10 px radius, in a
light and a dark theme and a color theme of the user's choice. Its values are needed in
more than one place: the chrome's CSS, the terminals' default colors, which
are settings of the core, and the background the desktop shell gives its
window before the page paints. Kept in each of them, the values drift.

These places take values in different forms. The web UI wants CSS custom
properties that change with `<html data-theme>`
([13](13-settings-and-appearance.md)); the core's settings want Go values
for their defaults.

## Goals / non-goals

Goals: one file that defines the colors (light and dark), the color
themes, status, Git, chart and file icon colors, terminal palettes, the chrome's
sizes and the type scale; the web UI and the core read them in their own
form without a build step of their own; a stale generated file fails
`make check`; the web UI's chrome uses the tokens through its CSS
variables; every place of the chrome of one kind (a header row, a
toolbar, a list row, an icon button, a section heading) has one size, and
all of them scale together with the UI font size.

Non-goals: themes that change the backgrounds or the text (the neutral
black and white stay in every theme); themes of the user's own; the
colors programs draw with in panes, which stay the terminal settings'
([13](13-settings-and-appearance.md)).

## Design

- **The source** is `design/tokens.json`:
  - `color.<name>`: a neutral color of the interface, `{"light": …,
    "dark": …}`. A value is `"#rrggbb"` or `{"hex": "#rrggbb", "alpha":
    0.07}`. The names say what a color is for: `background`,
    `foreground`, `sidebar`, `tabBar`, `tabActive`, `hover` (hovered rows
    and floating panels), `accent` (selected rows and buttons' fill),
    `muted` and `faint` (secondary and tertiary text), `border`,
    `borderStrong`, and `warning` (VS Code's warning yellow).
  - `status.<state>`: the colors of the agent and machine states
    `working`, `done`, `error` and `idle`. An agent that waits for the
    user (`blocked`) takes the theme's accent: it is what asks for
    attention, as a badge does in VS Code.
  - `git.<status>`: VS Code's Git decoration colors (`added`, `modified`,
    `deleted`, `renamed`, `untracked`, `ignored`, `conflict`), for the
    file explorer, the Git panel and the editors' gutters.
  - `chart.<hue>`: eight hues (`blue`, `cyan`, `teal`, `green`, `yellow`,
    `orange`, `red`, `purple`) for data: the Git graph's lanes, the AI
    usage charts. The dark ones are of the same family as the icon's blue
    and teal.
  - `fileIcon.<hue>`: the hues of file-type icons (`web/src/fileIcons.tsx`):
    `blue`, `sky`, `teal`, `green`, `yellow`, `orange`, `red`, `pink`,
    `purple`, `brown`, `grey`. Icons are graphics: each keeps 3:1 against
    the background, the sidebars, a hovered and a selected row in both
    themes (`fileIcons.test.ts`).
  - `syntax.<role>`: the colors of code by the role of a token: `comment`,
    `keyword`, `string`, `number`, `type`, `function`, `property`, `tag`,
    `attribute`, `delimiter`, `regexp` (`web/src/highlight`), for the
    editors, the previews and code in rendered Markdown. They are opaque
    (the editor takes colors as they are) and keep 4.5:1 against the
    background in both themes (`highlight.test.ts`); the dark ones are the
    chart hues.
  - `themes`: the color themes, each `{id, accent, onAccent}` with a light
    and a dark value; the first is the default. `accent` keeps 3:1
    against the background and `onAccent` 4.5:1 on the accent
    (`tokens.test.ts`).
  - `terminal.light` and `terminal.dark`: a terminal's default
    `background`, `foreground`, `cursor` and `selection` and its `palette`
    of the 16 ANSI colors (black to white, then the bright variants), all
    opaque.
  - `metric.<name>`: lengths that stay in CSS pixels (`sidebarWidth`,
    `radiusSmall`, `radius`, `radiusLarge`, `divider`).
  - `size.<name>`: the chrome's sizes in CSS pixels at the root font size
    `font.root` (13): `header` (34: the sidebars' heads, the tab bar),
    `toolbar` (28: a pane's header, a panel's tools, an editor's bar),
    `statusBar` (24), `row` (24: every list row), `control` and
    `controlSmall` (24 and 20: buttons, fields, icon buttons), `icon` and
    `iconSmall` (16 and 14), `rail`, `railButton`, `railIcon` (the right
    sidebar's rail).
  - `font.size.<name>`: the type scale at the root font size: `xs` (10),
    `sm` (11: section headings, badges), `md` (12: toolbars, the status
    bar, secondary text), `base` (13: rows, tabs, dialogs), `lg` (14),
    `xl` (16), `display` (22: large numbers), `terminal`.
- **The generator** is `scripts/tokens` (Go, standard library only).
  `make tokens` runs it; it writes two files, both checked in so that no
  build needs Go to run first:
  - `web/src/tokens.css`: custom properties on `:root` for the dark theme
    and on `:root[data-theme='light']` for the light one, the same
    selectors as `web/src/styles.css`, so the theme setting switches both
    (`--ds-color-background`, `--ds-status-working`, `--ds-git-added`,
    `--ds-chart-blue`, `--ds-file-icon-sky`, `--ds-terminal-ansi-0` to `-15`,
    `--ds-metric-radius`, `--ds-size-toolbar`, `--ds-font-size-base`).
    The first theme's `--ds-accent` and `--ds-on-accent` are on those two
    blocks; each other theme has `:root[data-accent='<id>']` for its dark
    values and `:root[data-accent='<id>'][data-theme='light']` for its
    light ones, more specific than both, so the light/dark and the color
    theme settings combine. Lengths are written once: metrics with `px`,
    sizes and font sizes in `rem` (the pixels divided by `font.root`), so
    the UI font size setting, which is the root font size, scales them.
    `web/src/main.tsx` imports it before `styles.css`.
  - `internal/uisettings/tokens.go`: the terminal palettes as the
    defaults of the `terminal.colors.*` settings
    ([13](13-settings-and-appearance.md)), from which the web UI's terminal
    colors come; a user's colors replace them; and the themes' ids, which
    are the values of `appearance.colorTheme`, the first its default.
  Names are written in sorted order and the output depends on nothing but
  the tokens, so generating twice gives the same bytes. The generator
  refuses unknown fields, colors that are not lower-case `#rrggbb`, an
  alpha outside 0 to 1, a color without both themes, palettes that do not
  have 16 colors, names that are not camelCase, no themes, a theme id
  twice, a theme without its accent, a length that is not positive and a
  missing `font.root`.
- **The check.** `go run ./scripts/tokens -check` writes nothing and fails
  naming the files that differ from what it would generate;
  `scripts/check.sh` (`make check`, CI) runs it.
- **The web UI's chrome** keeps its own variables, which the rules in
  `styles.css` and the plugins' stylesheets use, and defines them from the
  tokens:

  | Variable | Token |
  | --- | --- |
  | `--bg` | `color.background` |
  | `--bg-1` (sidebars, toolbars, status bar) | `color.sidebar` |
  | `--bg-2` (hovered rows, menus, dialogs) | `color.hover` |
  | `--bg-3` (buttons, selected rows) | `color.accent` |
  | `--line`, `--line-2` | `color.border`, `color.borderStrong` |
  | `--fg`, `--fg-dim`, `--fg-mute` | `color.foreground`, `color.muted`, `color.faint` |
  | `--accent`, `--on-accent`, `--focus-ring`, `--blocked` | the theme's `accent` and `onAccent` |
  | `--accent-soft` | the accent, mostly transparent (the focused selection, drop targets) |
  | `--warning` | `color.warning` |
  | `--working`, `--done`, `--error`, `--idle` | `status.*` |
  | `--overlay`, `--float` | `color.background` and `color.accent` (light: `color.sidebar`), slightly transparent |
  | `--radius-sm`, `--radius`, `--radius-lg` | `metric.radiusSmall`, `radius`, `radiusLarge` |
  | `--h-header`, `--h-toolbar`, `--h-status`, `--h-row` | `size.header`, `toolbar`, `statusBar`, `row` |
  | `--ctl`, `--ctl-sm`, `--ic`, `--ic-sm` | `size.control`, `controlSmall`, `icon`, `iconSmall` |
  | `--fs-xs` … `--fs-display` | `font.size.*` |

  Git, chart and file icon colors are used as `--ds-git-*`,
  `--ds-chart-*` and `--ds-file-icon-*`.
  Code that lays rows out by number (virtual lists) takes the same sizes
  in pixels at the UI font size in use from `web/src/lib/sizes.ts`.
- **The design language** (`styles.css`): the accent marks focus (the
  focused pane's top edge, fields, the focus ring), the selection (the
  active tab's bar, the selected workspace's bar, the shown panel's bar on
  the rail, the highlighted item of a menu or of the palette), the one
  emphasized button of a place (`button.primary`), counts (`.badge`) and an
  agent waiting for the user. Other notices are not colored: a toast is
  plain unless it reports a failure (`error`, the error color) or a warning
  (`warning`), which add an icon and a bar of their color; the connection
  is a dot beside plain text. Shared components:
  - **Buttons**: secondary by default (the neutral fill), `.primary` (the
    accent), `.ghost`; `.sm` is a small control high. Icon buttons
    (`.icon`, `.icon.sm`) are a control square with an icon of
    `--ic`/`--ic-sm`; a toggled one (`.on`, `aria-pressed`) takes the
    accent on its soft fill.
  - **Fields** (`.input`, `select`): a control high, the accent border on
    focus.
  - **Rows**: header rows (`--h-header`): the left sidebar's head, the
    tab bar's first row and the right panel's head line up across the
    window; toolbars (`.toolbar`, `--h-toolbar`): a pane's header and a
    panel's tools line up below them; list rows (`--h-row`) are the same in
    both sidebars, menus and lists.
  - **Type**: rows and tabs `--fs-base`; toolbars, the status bar and
    secondary text `--fs-md`; section headings (`.section-head`,
    `.panel-title`, `.section-title`) `--fs-sm`, upper case, semibold.
  - **Feedback**: `.badge` (accent pill), `.tag` (outlined label),
    `.callout` (`.warning`, `.error`), `.empty-note` (a panel with nothing
    to show), `.switch` (on/off in forms), toasts as above.
  - **Dropdowns** (`components/Picker.tsx`, `.picker`, `.picker-button`): a
    floating panel of the menus' fill with a search field and list rows a
    row high (taller for touch), the keyboard's row in the accent as in the
    palette, group headers like section headings, check boxes filled with
    the accent, a footer for several; characters a query matched are
    underlined in the accent (`mark.match`, `components/Highlight.tsx`).
  - **Trees and lists** (`components/tree`, `.tree`, `.tree-row`): list
    rows with indent guides (`--line`, `--line-2` while the tree is
    pointed at or focused), a twisty, a file icon (`.file-icon`, `--ic`,
    neutral or in its `--ds-file-icon-*` hue), the label, a muted
    description, actions shown on hover and focus, a decoration letter in
    its color; selected rows take `--bg-3`, `--accent-soft` while the tree
    has the keyboard, whose row has the focus ring. Collapsible sections
    (`.section-head` with `.section-toggle`) show their count neutral
    (`.section-count`), as VS Code does: only what asks for attention
    takes the accent.

  The tab bar and the active tab use `color.tabBar` and `color.tabActive`
  directly; the active tab also has an outline (`--line-2`) and an accent
  bar under it, so it stands out by more than its fill (WCAG 1.4.11), as
  the selected workspace and settings section do with a 3-pixel accent bar.
  The light theme's block in `styles.css` sets only what is not
  a token: the transparency of overlays, the dialog backdrop, shadows and
  the checkerboard behind images, all neutral.
- **Terminals.** The terminal colors are settings whose defaults are
  `terminal.light` and `terminal.dark` (`internal/uisettings/tokens.go`);
  the web UI reads them from the core (and from
  `design/generated/registry.json` until the core answers).
  The page's background before the UI paints (`theme-color` in
  `web/index.html`, the web app manifest in `web/vite.config.ts`) is
  `color.background` written out; the desktop shell's window
  (`desktop/src/main.ts`) reads it from `tokens.json`, which its build
  bundles.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Style Dictionary or another token toolchain | A Node dependency and its configuration for two small outputs, one of them Go; the Go build would need the web toolchain. |
| Generating at build time instead of checking the files in | Vite and `go build` would each need a step before them; checked-in files with a staleness check keep every build as it was. |
| The web UI reading `tokens.json` at run time | Colors would arrive after the first paint, and CSS could not use them without scripting. |
| Replacing the web UI's variables by the tokens in every rule | About two thousand lines of rules change for no visible difference from defining the variables once. |
| A second theme switch for the tokens (class or media query) | Two mechanisms can disagree; `data-theme` already follows the setting and the system. |
| Color themes that also change backgrounds and text, as VS Code's do | The neutral black and white are what the UI is known by; a theme of the accent alone keeps every text contrast checked once. |
| The accent for every notice (as the orange of agents waiting was) | A color that is everywhere marks nothing: done and informational notices stay plain, so failures, warnings and an agent waiting stand out. |
| Sizes in pixels for exactness | The UI font size setting scales `rem`; pixels left rows and icons behind while their text grew. |
| Palettes written out in the web UI's code | A second copy to keep equal; the settings' defaults are generated from the tokens and every client reads those. |
| Colors as `#rrggbbaa` | An alpha of 0.07 has no exact two-digit form; hex and alpha apart stay readable. |

## Failure modes

- **`tokens.json` edited without `make tokens`** → `make check` fails with
  the stale files' names; `go test ./scripts/tokens` fails as well.
- **A generated file edited by hand** → the same check fails; the header
  of both files says where they come from.
- **A malformed token** (wrong color form, unknown field, missing theme)
  → the generator stops with the reason and writes nothing.
- **The terminal colors' defaults differ from the tokens** (a stale
  `tokens.go` or `registry.json`) → `make check` fails;
  `web/src/__tests__/tokens.test.ts` compares the registry's defaults with
  the tokens.
- **A token removed while `styles.css` still uses it** → the variable is
  undefined and the property falls back to its inherited or initial
  value, which is visible in the chrome.

## Testing

`scripts/tokens/main_test.go`: parsing (plain and alpha colors), the
generated CSS (themes, file icon hues, sizes in rem, lengths written once) and Go and that
repeated runs give the same bytes, rejected tokens (malformed colors,
alpha, missing theme, unknown field, short palette, names, themes, sizes),
`-check` on missing, edited and outdated files without writing, and that
the repository's generated files are current.
`internal/uisettings`: the color theme setting offers the tokens' themes.
`web/src/__tests__/tokens.test.ts`: the web UI's default terminal colors
equal the tokens' and a theme's terminal background is the page's; the
default color theme; `data-accent` for known and unknown themes; every
theme's accent contrast in both kinds; sizes in pixels scale with the UI
font size.
`web/src/__tests__/termOptions.test.ts` keeps the terminal colors'
contrast, `fileIcons.test.ts` the file icon hues'.
