# Common tasks; see CONTRIBUTING.md and AGENTS.md.
# Development core address; keeps clear of a daily instance on the default port.
DEV_LISTEN ?= 127.0.0.1:7790
SLUG := $(shell sed -n 's/^[[:space:]]*Slug = "\(.*\)"$$/\1/p' internal/brand/brand.go)
EXT  := extensions/$(SLUG)-bridge

.PHONY: deps build test check tokens vt-wasm gpupick it dev-core dev-web desktop-app desktop-dist desktop-install desktop-icons dev-desktop clean

# Electron's binary runs the desktop app in development; checks and the
# launcher tests need only its types (ELECTRON_SKIP_BINARY_DOWNLOAD=1, as CI
# sets), and packaging downloads its own.
deps:
	pnpm -C web install --frozen-lockfile
	pnpm -C $(EXT) install --frozen-lockfile
	pnpm -C desktop install --frozen-lockfile

build:
	scripts/build.sh

test:
	go test ./...
	pnpm -C web test
	pnpm -C desktop test

check:
	scripts/check.sh
	pnpm -C web typecheck
	pnpm -C web format:check
	pnpm -C web cycles
	pnpm -C $(EXT) typecheck
	pnpm -C $(EXT) format:check
	pnpm -C desktop typecheck
	pnpm -C desktop format:check

# The design tokens of the web UI and the core's terminal color defaults,
# from design/tokens.json; then what the clients take from the registered
# settings and commands (design/generated) and the tables of settings and
# commands in docs/reference.md.
tokens:
	go run ./scripts/tokens
	go run ./scripts/registry

# The web UI's terminal emulator, Ghostty's libghostty-vt as WebAssembly
# (needs zig 0.17; GHOSTTY_SRC=<checkout> skips the clone).
vt-wasm:
	scripts/fetch-ghostty-vt.sh

# gpupick, the library that shows a program only the NVIDIA GPUs of its
# CUDA_VISIBLE_DEVICES, for Linux machines (needs zig 0.17).
gpupick:
	scripts/build-gpupick.sh

it:
	go test -tags integration -count=1 ./internal/agent -run Integration -v
	go test -tags integration -count=1 ./internal/hc -run Integration -v
	go test -tags integration -count=1 ./internal/server -run Integration -v

dev-core:
	go run ./cmd/$(SLUG) --instance dev --local-only --listen $(DEV_LISTEN) --agent-dir dist/agents

dev-web:
	$(shell echo $(SLUG) | tr 'a-z-' 'A-Z_')_CORE=http://$(DEV_LISTEN) pnpm -C web dev

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
	rm -rf dist desktop/dist web/dist/assets internal/embedded/agents/*.gz internal/embedded/hc/*.gz internal/embedded/ext/*.vsix
