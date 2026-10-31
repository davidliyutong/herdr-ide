# Common tasks; see CONTRIBUTING.md and AGENTS.md.
# Development core address; keeps clear of a daily instance on the default port.
DEV_LISTEN ?= 127.0.0.1:7790
SLUG := $(shell sed -n 's/^[[:space:]]*Slug = "\(.*\)"$$/\1/p' internal/brand/brand.go)
EXT  := extensions/$(SLUG)-bridge

.PHONY: deps build test check it dev-core dev-web desktop-app desktop-dmg desktop-icons dev-desktop clean

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
	pnpm -C $(EXT) typecheck
	pnpm -C $(EXT) format:check
	pnpm -C desktop typecheck
	pnpm -C desktop format:check

it:
	go test -tags integration -count=1 ./internal/agent -run Integration -v

dev-core:
	go run ./cmd/$(SLUG) --instance dev --local-only --local-session $(SLUG)-dev --listen $(DEV_LISTEN) --agent-dir dist/agents

dev-web:
	$(shell echo $(SLUG) | tr 'a-z-' 'A-Z_')_CORE=http://$(DEV_LISTEN) pnpm -C web dev

desktop-app:
	scripts/desktop.sh app

desktop-dmg:
	scripts/desktop.sh dmg

desktop-icons:
	scripts/icons.sh

dev-desktop:
	scripts/desktop.sh dev

clean:
	rm -rf dist desktop/dist web/dist/assets internal/embedded/agents/*.gz internal/embedded/ext/*.vsix
