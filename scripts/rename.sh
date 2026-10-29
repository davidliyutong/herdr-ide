#!/usr/bin/env bash
# Renames the project in one step.
#
#   scripts/rename.sh NEW_SLUG [--name "Display Name"] [--module MODULE_PATH] [--dry-run]
#
# - replaces the slug (lowercase), the env prefix (UPPER_) and, with --name,
#   the display name in all tracked text files;
# - with --module, rewrites the Go module path (go.mod and imports);
# - moves cmd/<slug>, cmd/<slug>-agent and extensions/<slug>-bridge;
# - records the old names in internal/brand and web/src/brand.ts so that
#   existing installs migrate: machines move ~/.<old> to ~/.<new>, browsers
#   move their stored preferences, code-server drops the old bridge extension.
#
# Run `make check` afterwards and review the diff.
set -euo pipefail
cd "$(dirname "$0")/.."

new="" name="" module="" dry=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --module) module="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) new="$1"; shift ;;
  esac
done
[[ -n "$new" ]] || { sed -n '2,15p' "$0"; exit 2; }
[[ "$new" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "slug must match ^[a-z][a-z0-9-]+$" >&2; exit 2; }

old=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
old_name=$(sed -n 's/^[[:space:]]*Name = "\(.*\)"$/\1/p' internal/brand/brand.go)
old_module=$(sed -n 's/^module //p' go.mod)
[[ -n "$old" && "$old" != "$new" ]] || { echo "nothing to do (slug is $old)" >&2; exit 1; }
upper() { echo "$1" | tr 'a-z-' 'A-Z_'; }
old_env="$(upper "$old")_" new_env="$(upper "$new")_"
new_module=${module:-$old_module}
[[ "$old_module" == "$old" && -z "$module" ]] && new_module="$new"
name=${name:-$([[ "$old_name" == "$old" ]] && echo "$new" || echo "$old_name")}

echo "slug:   $old -> $new"
echo "name:   $old_name -> $name"
echo "env:    $old_env -> $new_env"
echo "module: $old_module -> $new_module"

# Tracked (or, without git, all) text files, excluding generated output.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  files=$(git ls-files --cached --others --exclude-standard)
else
  files=$(find . -type f -not -path './.git/*' | sed 's#^\./##')
fi
files=$(echo "$files" | grep -vE '(^|/)(node_modules|dist)/|pnpm-lock\.yaml$|go\.sum$|\.(gz|vsix|png|ico|woff2?)$' || true)

if [[ -n "$dry" ]]; then
  echo "files that would change:"
  echo "$files" | xargs grep -lI -e "$old" -e "$old_env" 2>/dev/null || true
  exit 0
fi

export OLD="$old" NEW="$new" OLD_ENV="$old_env" NEW_ENV="$new_env" OLD_MOD="$old_module" NEW_MOD="$new_module" OLD_NAME="$old_name" NEW_NAME="$name"
echo "$files" | while IFS= read -r f; do
  [[ -f "$f" ]] && grep -qI . "$f" 2>/dev/null || continue
  # The module path is swapped through a placeholder so that the slug
  # replacement never rewrites an explicitly chosen --module.
  perl -pi -e '
    s{"\Q$ENV{OLD_MOD}\E/}{"\x00MOD\x00/}g;
    s{^module \Q$ENV{OLD_MOD}\E$}{module \x00MOD\x00};
    s/\Q$ENV{OLD_ENV}\E/$ENV{NEW_ENV}/g;
    s/\Q$ENV{OLD}\E/$ENV{NEW}/g;
    s/\x00MOD\x00/$ENV{NEW_MOD}/g;
  ' "$f"
done

# Display name (only where it is defined).
if [[ "$name" != "$new" ]]; then
  perl -pi -e 's/^(\s*Name = )"[^"]*"/$1"$ENV{NEW_NAME}"/' internal/brand/brand.go
  perl -pi -e "s/^(export const APP_NAME = )'[^']*'/\$1'\$ENV{NEW_NAME}'/" web/src/brand.ts
fi

# Record the old names for migration.
perl -0pi -e 's/(LegacyDataDirNames = \[\]string\{)/$1".$ENV{OLD}", /; s/(LegacySlugs = \[\]string\{)/$1"$ENV{OLD}", /; s/(LegacyBridgeExtIDs = \[\]string\{)/$1"$ENV{OLD}.$ENV{OLD}-bridge", /' internal/brand/brand.go
perl -0pi -e "s/(export const LEGACY_SLUGS: string\[\] = \[)/\$1'\$ENV{OLD}', /; s/, \]/]/" web/src/brand.ts

mv_path() {
  [[ -e "$1" ]] || return 0
  if git ls-files --error-unmatch "$1" >/dev/null 2>&1; then git mv "$1" "$2"; else mv "$1" "$2"; fi
}
mv_path "cmd/$old-agent" "cmd/$new-agent"
mv_path "cmd/$old" "cmd/$new"
mv_path "extensions/$old-bridge" "extensions/$new-bridge"
rm -rf dist internal/embedded/agents/*.gz internal/embedded/ext/*.vsix "extensions/$new-bridge/"*.vsix "extensions/$new-bridge/dist"

gofmt -w internal cmd >/dev/null
go build ./...
go test ./internal/brand
echo "done. Run: make check && scripts/build.sh, then review the diff."
