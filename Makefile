# Common tasks; see CONTRIBUTING.md and AGENTS.md.
# Development hub address; keeps clear of a daily instance on the default port.
DEV_LISTEN ?= 127.0.0.1:7790
SLUG := $(shell sed -n "s/^export const SLUG = '\(.*\)';$$/\1/p" backend/shared/lib/brand.ts)
# This host as <os>-<arch> (darwin-arm64, linux-amd64…).
HOST_PLATFORM := $(shell scripts/platform.sh)
EXT  := extensions/$(SLUG)-bridge

.PHONY: deps build test test-extended test-linux test-win test-remote check tokens it e2e screenshots ci-local test-doctor test-clean dev-hub dev-web desktop-app desktop-dist desktop-install desktop-icons dev-desktop clean

# Electron's binary runs the desktop app in development; checks and the
# launcher tests need only its types (ELECTRON_SKIP_BINARY_DOWNLOAD=1, as CI
# sets), and packaging downloads its own. fetch-deps.ts fetches and verifies
# the pinned native submodules (vt, encoder, gpupick, gui-helper).
deps:
	pnpm -C web install --frozen-lockfile
	pnpm -C $(EXT) install --frozen-lockfile
	pnpm -C desktop install --frozen-lockfile
	pnpm -C e2e install --frozen-lockfile
	pnpm -C backend install --frozen-lockfile
	bun backend/scripts/fetch-deps.ts

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

# Runs Linux-specific backend tests (sys, /proc sessions, gpupick, display,
# real Xvfb GUI integration) inside a Linux container from any host with Docker.
# LINUX_TEST_ALL=1 runs the full backend suite in Linux; TEST_ARGS selects files.
test-linux:
	scripts/test-linux.sh $(TEST_ARGS)

# Runs Windows hub, web, desktop and packaging tests against a disposable
# Windows VM (macOS HVF or Linux KVM CoW overlay / dockurr/windows) or an
# existing SSH Windows host (WIN_TEST_HOST).
test-win:
	python3 e2e/machines/winvm.py test $(WIN_ARGS)

# Ships the working tree (excluding gitignored files like .env) to a remote
# Linux physical host (LINUX_TEST_HOST in gitignored .env or environment) and
# runs SUITE=doctor|check|test-linux|it|e2e|ci-e2e|ci-local|win-dockur.
test-remote:
	scripts/test-remote.sh $(REMOTE_ARGS)

it:
	scripts/it.sh

# Runs .github/workflows/ci.yml jobs locally via nektos/act (default JOB=check;
# also integration, desktop, e2e, cross-compile, all).
ci-local:
	scripts/ci-local.sh $(JOB)

# Diagnoses local toolchain, Docker, KVM/HVF virtualization, Xvfb, Playwright,
# act and leftover test artifacts on macOS and Linux.
test-doctor:
	scripts/test-doctor.sh

# Safely removes test containers, disposable VMs, stale /tmp/hie-* homes and
# test build directories without touching the user's instance.
test-clean:
	scripts/test-clean.sh $(CLEAN_ARGS)

# End-to-end tests: the hub of this platform on isolated instances,
# driven through Chromium, and SSH machines in Docker containers (e2e/,
# scripts/e2e.sh); not part of make test.
# Arguments for Playwright: make e2e E2E_ARGS='tests/chat.spec.ts'.
e2e:
	scripts/e2e.sh $(E2E_ARGS)

# Documentation screenshots of every feature, in English and Chinese, from
# fixed demo data on isolated instances and Docker SSH machines (e2e/screenshots).
# SCREENSHOT_ONLY=overview,git selects scenes; SCREENSHOT_DIR changes the output.
screenshots:
	SCREENSHOT_ONLY="$(SCREENSHOT_ONLY)" SCREENSHOT_DIR="$(SCREENSHOT_DIR)" SKIP_BUILD="$(SKIP_BUILD)" E2E_CODE_SERVER_SEED="$(E2E_CODE_SERVER_SEED)" E2E_REQUIRE_DOCKER=1 scripts/e2e.sh --config=playwright.screenshots.config.ts

# Builds all Stage 1 full-featured binaries (web, vsix, herdr-core, encoders,
# gpupick, gui-helper, and all 6 platform archives in dist/release) and runs
# the compiled host executable on the isolated dev instance.
dev-hub:
	scripts/build.sh
	./dist/$(SLUG)-$(HOST_PLATFORM) serve --instance dev --local-only --listen $(DEV_LISTEN) --agent-dir dist/release

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
