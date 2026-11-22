#!/usr/bin/env bash
# Repository checks run by `make check` and CI (besides tests):
#   1. gofmt / go vet, also for the other desktop systems (the core and
#      its tests build for Linux, macOS and Windows; the agent for unix)
#      and for the machine builds (the tag "machine"), which must not
#      link the server, the UI or what the core embeds
#   2. the product slug appears in string literals only in the brand files
#      (so a rename stays a one-file change plus scripts/rename.sh)
#   3. every command-line flag and every HTTP route is documented in
#      docs/reference.md
#   4. THIRD_PARTY_NOTICES.md matches the linked Go modules
#   5. README.md and README.zh-CN.md have the same section structure
#   6. CHANGELOG.md's [Unreleased] is one list without subsections
#   7. the files generated from design/tokens.json and the settings
#      registry are current
#   8. the web UI's terminal emulator (web/src/vt/ghostty-vt.wasm) is the
#      module whose digest scripts/fetch-ghostty-vt.sh recorded
#   9. every shared test vector (design/testdata) is run by the web UI's
#      tests
#  10. the GPU selection library the agent embeds (internal/agent/gpupick)
#      is the one scripts/build-gpupick.sh built from its source
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
slug=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
module=$(sed -n 's/^module //p' go.mod)

echo "==> gofmt / go vet"
unformatted=$(gofmt -l cmd internal scripts e2e web/*.go)
if [[ -n "$unformatted" ]]; then echo "gofmt needed:"; echo "$unformatted"; fail=1; fi
go vet ./... || fail=1
go vet -tags integration ./... || fail=1
go vet -tags machine "./cmd/${slug}" || fail=1
heavy=$(GOOS=linux go list -tags machine -deps "./cmd/${slug}" | grep -E "^${module}/(internal/(embedded|server|codeserver|machines|transport|registry)|web)$" || true)
if [[ -n "$heavy" ]]; then echo "the machine build links packages of the core:"; echo "$heavy"; fail=1; fi
for target in linux/amd64 darwin/arm64 windows/amd64; do
  [[ "$target" == "$(go env GOOS)/$(go env GOARCH)" ]] && continue
  GOOS=${target%/*} GOARCH=${target#*/} go vet ./... || fail=1
done

echo "==> brand literals"
# String literals containing the slug outside the brand files, ignoring Go
# import paths and comments.
hits=$(grep -rnE --include='*.go' --include='*.ts' --include='*.tsx' "[\"'\`][^\"'\`]*\b${slug}\b" cmd internal web/src extensions/*/src desktop/src 2>/dev/null \
  | grep -vE '(internal/brand/|web/src/brand\.ts|extensions/[^/]+/src/brand\.ts|_test\.go:|__tests__/)' \
  | grep -vE "\"${module}/" \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|\*)' || true)
if [[ -n "$hits" ]]; then
  echo "hardcoded '${slug}' (use internal/brand, web/src/brand.ts or the extension's src/brand.ts):"
  echo "$hits"
  fail=1
fi

echo "==> flags documented"
for f in $( (go run "./cmd/${slug}" serve -h; go run "./cmd/${slug}" fetch-assets -h) 2>&1 | sed -n 's/^  -\([a-z-]*\).*/\1/p' | sort -u); do
  grep -qF -- "\`--$f\`" docs/reference.md || { echo "flag --$f missing from docs/reference.md"; fail=1; }
done

echo "==> endpoints documented"
# Every route of the server's route table (Server.routes), as `METHOD /path`
# or `/path`.
routes=$(sed -n 's/^[[:space:]]*\(route\)\{0,1\}{"\([^"]*\)", .*/\2/p' internal/server/server.go | tr ' ' '_')
if [[ $(wc -w <<<"$routes") -lt 20 ]]; then echo "found only $(wc -w <<<"$routes") routes in internal/server/server.go"; fail=1; fi
for route in $routes; do
  route=${route//_/ }
  grep -qF -- "\`$route\`" docs/reference.md || { echo "endpoint $route missing from docs/reference.md"; fail=1; }
done

echo "==> third-party notices"
scripts/notices.sh --check || fail=1

echo "==> README translations in sync"
a=$(grep -c '^## ' README.md); b=$(grep -c '^## ' README.zh-CN.md)
if [[ "$a" != "$b" ]]; then echo "README.md has $a sections, README.zh-CN.md has $b"; fail=1; fi

echo "==> changelog"
# A version's changes are one list; the release notes are cut from it.
if awk '/^## \[Unreleased\]/ {p=1; next} /^## \[/ {p=0} p' CHANGELOG.md | grep -n '^#'; then
  echo "CHANGELOG.md: [Unreleased] is one list, without headings"
  fail=1
fi

echo "==> design tokens and settings keys"
go run ./scripts/tokens -check || fail=1
go run ./scripts/registry -check || fail=1

echo "==> terminal emulator module"
scripts/fetch-ghostty-vt.sh --check || fail=1
scripts/build-gpupick.sh --check || fail=1

echo "==> shared test vectors"
# The web UI's tests, or the desktop shell's for vectors the core shares
# with the shell alone (the vault's unlock keys), run every vector: they
# name the file (<dir>/<name>.json), the directory's files (<dir>/*.json)
# or the directory itself ("…/testdata/<dir>"), so a new vector file
# cannot go unrun.
for f in design/testdata/*/*.json; do
  rel=${f#design/testdata/}
  dir=${rel%%/*}
  grep -rqF -e "$rel" -e "$dir/*.json" -e "testdata/$dir\"" web/src/__tests__ desktop/src || { echo "$f is run by no test in web/src/__tests__ or desktop/src"; fail=1; }
done

exit $fail
