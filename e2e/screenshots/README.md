# Documentation screenshot generator

Builds the real hub and web UI, then drives them with Playwright to produce the English and Simplified Chinese screenshots in `docs/images`. Every image is a 2000×1141 PNG in the dark theme. `manifest.ts` assigns every feature document number to a scene. The run replaces the selected images only after the tests pass and all selected pairs have the expected dimensions.

## Run

```sh
make screenshots
```

A full run needs Bun, the e2e packages, Playwright Chromium, Docker, and a display for the isolated Electron app. Docker is required rather than silently skipping the SSH scenes. The generator uses only `e2e-*` instances and containers, temporary homes, throwaway SSH keys, and the mock desktop keychain; it never attaches to a default, development, or desktop user instance.

Useful variants:

```sh
SCREENSHOT_ONLY=overview,git make screenshots
SCREENSHOT_DIR=dist/screenshots make screenshots
SKIP_BUILD=1 make screenshots                 # reuse dist/e2e, as with make e2e
E2E_CODE_SERVER_SEED=/path/to/seed make screenshots
```

The first VS Code run uses the hub's `fetch-assets` command to download the pinned code-server release and extensions, verified by the project digests, into `dist/e2e/code-server`. Later runs reuse them. The matplotlib image is a Docker-cached derivative of the e2e SSH image. These are the only preparation steps that need external access; the demo pages and agents themselves make no external requests.

## Scenes and fixed data

- `manifest.ts`: scene names, feature coverage, selected scenes, output paths, and image dimensions.
- `demo.ts`: the fixed clock, training project, SVG plot, remote web page, monitor metrics, process table, subscription windows, token counts, and prices. The fake Claude in `../fakes/claude.ts` uses a fixed UUID. Accounts use `example.com`; vault values and passphrases are dummy data in temporary homes.
- `support.ts`: shared setup, localized panel helpers, English/Chinese capture, and state restoration after the language reload.
- `core.spec.ts`, `panels.spec.ts`, `overview.spec.ts`, `remote.spec.ts`, `vscode.spec.ts`, `desktop.spec.ts`: the actual user interactions and assertions for each scene.

The Git scene creates its commits with fixed authors and timestamps. Monitor and AI usage APIs are answered with the fixed JSON from `demo.ts` so GPU and subscription details do not depend on the host. Files, chats, searches, diffs, port forwarding, program windows, terminal history, VS Code, and the desktop shell use the real feature paths. The terminal-history scene waits for actual snapshots before restarting only its own terminal core.

`windows.png` is an explicit composite of the main UI and a screenshot of the real remote matplotlib window, assembled by `composite` in `remote.spec.ts`; it is not represented as a single-page capture. All other images are direct page screenshots. Each pair uses the same data and layout, with only the UI language changed.

Generated images are documentation artifacts, not golden files for behavior tests. The regular `make e2e` suite does not run this separate Playwright configuration.
