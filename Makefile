# Common tasks; see CONTRIBUTING.md and AGENTS.md.
# Development hub address; keeps clear of a daily instance on the default port.
DEV_LISTEN ?= 127.0.0.1:7790
SLUG := $(shell sed -n "s/^export const SLUG = '\(.*\)';$$/\1/p" backend/shared/lib/brand.ts)
# This host as <os>-<arch> (darwin-arm64, linux-amd64…).
HOST_PLATFORM := $(shell scripts/platform.sh)
EXT  := extensions/$(SLUG)-bridge

.PHONY: deps build test test-extended check tokens vt-wasm gpupick gui-helper it e2e dev-hub dev-web desktop-app desktop-dist desktop-install desktop-icons dev-desktop clean

# Electron's binary runs the desktop app in development; checks and the
# launcher tests need only its types (ELECTRON_SKIP_BINARY_DOWNLOAD=1, as CI
# sets), and packaging downloads its own.
deps:
	pnpm -C web install --frozen-lockfile
	pnpm -C $(EXT) install --frozen-lockfile
	pnpm -C desktop install --frozen-lockfile
	pnpm -C e2e install --frozen-lockfile
	pnpm -C backend install --frozen-lockfile

build:
	scripts/build.sh

test:
	pnpm -C backend test
	pnpm -C web test
	pnpm -C desktop test

# The extended tests of every suite (backend/shared/testdata/extended.ts,
# web/src/__tests__/extended.ts, desktop/src/extended.ts), which make test
# skips: those that wait on real time, programs, compiles or large inputs.
test-extended:
	cd backend && EXTENDED_TESTS=1 bun test
	EXTENDED_TESTS=1 pnpm -C web test
	EXTENDED_TESTS=1 pnpm -C desktop test

check:
	scripts/check.sh
	pnpm -C web typecheck
	pnpm -C web format:check
	pnpm -C web cycles
	pnpm -C $(EXT) typecheck
	pnpm -C $(EXT) format:check
	pnpm -C desktop typecheck
	pnpm -C desktop format:check
	pnpm -C e2e typecheck
	pnpm -C e2e format:check
	pnpm -C backend typecheck
	pnpm -C backend format:check

# The design tokens of the web UI and the hub's terminal color defaults,
# from spec/tokens.json; then what the clients take from the registered
# settings and commands (spec/generated) and the tables of settings and
# commands in docs/reference.md.
tokens:
	bun backend/scripts/tokens.ts
	pnpm -C backend registry

# The web UI's terminal emulator, Ghostty's libghostty-vt as WebAssembly
# (needs zig 0.17; GHOSTTY_SRC=<checkout> skips the clone).
vt-wasm:
	scripts/fetch-ghostty-vt.sh

# gpupick, the library that shows a program only the NVIDIA GPUs of its
# CUDA_VISIBLE_DEVICES, for Linux machines (needs zig 0.17).
gpupick:
	scripts/build-gpupick.sh

# The GUI helper of Linux machines (scripts/gui-helper: the X window
# manager and capture, the GPU display's compositor, the display keeper),
# its tests and its static executables with their digests (needs zig 0.17).
gui-helper:
	scripts/build-gui-helper.sh

it:
	cd backend && bun test features/terminals/integration.test.ts
	cd backend && bun test features/history/integration.test.ts
	cd backend && bun test features/agents/integration.test.ts
	cd backend && bun test features/gui/integration.test.ts
	cd backend && bun test machine/integration.test.ts
	cd backend && bun test features/vscode/integration.test.ts

# End-to-end tests: the hub of this platform on isolated instances,
# driven through Chromium, and SSH machines in Docker containers (e2e/,
# scripts/e2e.sh); not part of make test.
# Arguments for Playwright: make e2e E2E_ARGS='tests/chat.spec.ts'.
e2e:
	scripts/e2e.sh $(E2E_ARGS)

# The hub from its sources (bun) on the dev instance. Its machine side is
# this host's TypeScript executable, built into dist/dev with the pinned
# herdr-core (fetched once into dist/machines-hc) and staged in
# dist/payload/machine as the desktop app carries it.
dev-hub:
	@test -f dist/machines-hc/hc-$(HOST_PLATFORM).gz || bun backend/scripts/fetch-hc.ts --out dist/machines-hc $(subst -,/,$(HOST_PLATFORM))
	bun backend/scripts/build.ts --out dist/dev/$(SLUG)-$(HOST_PLATFORM) --hc dist/machines-hc --payload-out dist/payload
	gzip -1 -c dist/dev/$(SLUG)-$(HOST_PLATFORM) > dist/payload/machine/$(SLUG)-$(HOST_PLATFORM).gz
	bun backend/hosts/bun/main.ts --instance dev --local-only --listen $(DEV_LISTEN) --web-dir web/dist

dev-web:
	$(shell echo $(SLUG) | tr 'a-z-' 'A-Z_')_HUB=http://$(DEV_LISTEN) pnpm -C web dev

desktop-app:
	scripts/desktop.sh app

desktop-dist:
	scripts/desktop.sh dist

desktop-install:
	scripts/desktop.sh install

desktop-icons:
	scripts/icons.sh

dev-desktop:
	scripts/desktop.sh dev

clean:
	rm -rf dist desktop/dist web/dist/assets
