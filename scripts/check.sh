#!/usr/bin/env bash
# Repository checks run by `make check` and CI (besides tests):
#   1. no copy of an executable that a compile left in the repository
#      (every `bun build --compile` runs in a temporary directory:
#      backend/scripts/build.ts)
#   2. the product slug appears in string literals only in the brand files
#      (so a rename stays a one-file change plus scripts/rename.sh)
#   3. every command-line flag and every HTTP route of the core
#      (backend/scripts/reference.ts) is documented in docs/reference.md
#   4. THIRD_PARTY_NOTICES.md matches the core's npm packages
#   5. README.md and README.zh-CN.md have the same section structure
#   6. CHANGELOG.md's [Unreleased] is one list without subsections
#   7. the files generated from spec/tokens.json and the settings
#      registry are current
#   8. the web UI's terminal emulator (web/src/vt/ghostty-vt.wasm) is the
#      module whose digest scripts/fetch-ghostty-vt.sh recorded
#   9. every shared test vector (spec/vectors) is run by the web UI's
#      tests
#  10. the GPU selection library the machine side carries (scripts/gpupick/bin)
#      is the one scripts/build-gpupick.sh built from its source, and the
#      GUI helper the TypeScript machine build embeds
#      (scripts/gui-helper/bin) the one scripts/build-gui-helper.sh built
#      from its sources
#  11. Bun's APIs (Bun.*, bun:*) are used only by what runs under Bun alone:
#      the machine side (backend/machine, hosts/machine, the features'
#      machine.ts and machine/), the command line (hosts/bun) and tests
#  12. the types of Codex's app-server the chat host's Codex adapter
#      speaks are those its pinned schema makes (spec/codex-app-server,
#      backend/scripts/codex-schema.ts)
#  13. Anthropic's Agent SDK is imported for its types only outside the
#      tests, and is no production dependency: no executable carries it
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "==> leftovers of bun build --compile"
left=$(find . -name '.*.bun-build' -not -path '*/node_modules/*' -not -path './.claude/*' 2>/dev/null)
if [[ -n "$left" ]]; then echo "a compile ran in the repository and left (remove them; run it in a temporary directory):"; echo "$left"; fail=1; fi
slug=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)

echo "==> brand literals"
# String literals containing the slug outside the brand files, ignoring
# comments.
hits=$(grep -rnE --include='*.ts' --include='*.tsx' "[\"'\`][^\"'\`]*\b${slug}\b" web/src extensions/*/src desktop/src backend --exclude-dir=node_modules 2>/dev/null \
  | grep -vE '(web/src/brand\.ts|backend/shared/lib/brand\.ts|extensions/[^/]+/src/brand\.ts|\.test\.ts:|__tests__/|/testdata/|/testing\.ts:)' \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|/?\*)' || true)
if [[ -n "$hits" ]]; then
  echo "hardcoded '${slug}' (use backend/shared/lib/brand.ts, web/src/brand.ts or the extension's src/brand.ts):"
  echo "$hits"
  fail=1
fi

echo "==> Bun's APIs only where Bun alone runs"
# The core's shared code, kernel and features' core sides also run in the
# desktop app's Electron (Node); tsconfig.node.json typechecks them with
# Node's types, this catches the rest (the features' other modules).
hits=$(grep -rnE "\bBun\.[A-Za-z]|from 'bun:|import\('bun:" --include='*.ts' backend/shared backend/kernel backend/features backend/hosts backend/machine --exclude-dir=node_modules 2>/dev/null \
  | grep -vE '^backend/(machine/|hosts/(bun|machine)/|features/[^/]+/machine(\.ts|/))' \
  | grep -vE '(\.test\.ts:|/testdata/|/testing\.ts:)' \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|/?\*)' || true)
if [[ -n "$hits" ]]; then
  echo "Bun's APIs outside the machine side, hosts/bun and tests:"
  echo "$hits"
  fail=1
fi

echo "==> Anthropic's Agent SDK in no executable"
# The chat host loads it from the machine's data directory at run time
# (backend/features/chat/claudesdk.ts); the product's code takes only its
# types, so that no build bundles it (scripts/build.ts refuses one that
# does). Tests use the development dependency.
hits=$(grep -rnE "(from|import\(|require\()[[:space:]]*['\"]@anthropic-ai/claude-agent-sdk(/[^'\"]*)?['\"]" --include='*.ts' --include='*.tsx' --include='*.mjs' backend/shared backend/kernel backend/features backend/hosts backend/machine backend/scripts web/src desktop/src --exclude-dir=node_modules 2>/dev/null \
  | grep -vE '(\.test\.ts:|/testdata/|/testing\.ts:)' \
  | grep -vE '^[^:]+:[0-9]+:\s*(//|/?\*)' \
  | grep -vE "import type (\{[^}]*\}|\* as [A-Za-z_]+) from '@anthropic-ai/claude-agent-sdk';" || true)
if [[ -n "$hits" ]]; then
  echo "@anthropic-ai/claude-agent-sdk imported outside the tests other than for its types:"
  echo "$hits"
  fail=1
fi
if grep -qE '"@anthropic-ai/claude-agent-sdk"' <(sed -n '/"dependencies"/,/}/p' backend/package.json); then
  echo "@anthropic-ai/claude-agent-sdk is in backend/package.json's dependencies: it is a development dependency only"
  fail=1
fi

echo "==> flags and endpoints documented"
# Every flag of the command line and every route of the core, composed as
# serve composes it (backend/scripts/reference.ts).
(cd backend && bun scripts/reference.ts) || fail=1

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
bun backend/scripts/tokens.ts --check || fail=1
(cd backend && bun scripts/registry.ts --check) || fail=1

echo "==> Codex's app-server types"
(cd backend && bun scripts/codex-schema.ts --check) || fail=1

echo "==> terminal emulator module"
scripts/fetch-ghostty-vt.sh --check || fail=1
scripts/build-gpupick.sh --check || fail=1
scripts/build-gui-helper.sh --check || fail=1

echo "==> shared test vectors"
# The web UI's tests, or the desktop shell's for vectors the core shares
# with the shell alone (the vault's unlock keys), run every vector: they
# name the file (<dir>/<name>.json), the directory's files (<dir>/*.json)
# or the directory itself ("…/vectors/<dir>"), so a new vector file
# cannot go unrun.
for f in spec/vectors/*/*.json; do
  rel=${f#spec/vectors/}
  dir=${rel%%/*}
  grep -rqF -e "$rel" -e "$dir/*.json" -e "vectors/$dir\"" web/src/__tests__ desktop/src || { echo "$f is run by no test in web/src/__tests__ or desktop/src"; fail=1; }
done

exit $fail
