#!/usr/bin/env bash
# Repository checks run by `make check` and CI (besides tests):
#   1. gofmt / go vet
#   2. the product slug appears in string literals only in the brand files
#      (so a rename stays a one-file change plus scripts/rename.sh)
#   3. every command-line flag is documented in docs/reference.md
#   4. THIRD_PARTY_NOTICES.md matches the linked Go modules
#   5. README.md and README.zh-CN.md have the same section structure
#   6. CHANGELOG.md's [Unreleased] is one list without subsections
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
slug=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
module=$(sed -n 's/^module //p' go.mod)

echo "==> gofmt / go vet"
unformatted=$(gofmt -l cmd internal web/*.go)
if [[ -n "$unformatted" ]]; then echo "gofmt needed:"; echo "$unformatted"; fail=1; fi
go vet ./... || fail=1
go vet -tags integration ./... || fail=1

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

echo "==> third-party notices"
scripts/notices.sh --check || fail=1

echo "==> README translations in sync"
a=$(grep -c '^## ' README.md); b=$(grep -c '^## ' README.zh-CN.md)
if [[ "$a" != "$b" ]]; then echo "README.md has $a sections, README.zh-CN.md has $b"; fail=1; fi

echo "==> changelog"
# CHANGELOG.md merges with the union driver (.gitattributes), which keeps
# both sides' lines; a subsection heading would be kept twice.
if awk '/^## \[Unreleased\]/ {p=1; next} /^## \[/ {p=0} p' CHANGELOG.md | grep -n '^#'; then
  echo "CHANGELOG.md: [Unreleased] is one list, without headings"
  fail=1
fi

exit $fail
