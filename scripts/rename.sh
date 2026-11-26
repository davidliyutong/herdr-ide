#!/usr/bin/env bash
# Renames the project in one step.
#
#   scripts/rename.sh NEW_SLUG [--name "Display Name"] [--dry-run]
#
# - replaces the slug (lowercase), the env prefix (UPPER_) and, with --name,
#   the display name in all tracked text files;
# - moves extensions/<slug>-bridge;
# - sets the display name in backend/shared/lib/brand.ts and its copy in
#   web/src/brand.ts.
#
# The renamed version starts with namespaces of its own
# (docs/features/11-naming-and-renames.md).
#
# Run `make check` afterwards and review the diff.
set -euo pipefail
cd "$(dirname "$0")/.."

new="" name="" dry=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) new="$1"; shift ;;
  esac
done
[[ -n "$new" ]] || { sed -n '2,13p' "$0"; exit 2; }
[[ "$new" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "slug must match ^[a-z][a-z0-9-]+$" >&2; exit 2; }

old=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
old_name=$(sed -n "s/^export const NAME = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
[[ -n "$old" && "$old" != "$new" ]] || { echo "nothing to do (slug is $old)" >&2; exit 1; }
upper() { echo "$1" | tr 'a-z-' 'A-Z_'; }
old_env="$(upper "$old")_" new_env="$(upper "$new")_"
name=${name:-$([[ "$old_name" == "$old" ]] && echo "$new" || echo "$old_name")}

echo "slug:   $old -> $new"
echo "name:   $old_name -> $name"
echo "env:    $old_env -> $new_env"

# Tracked (or, without git, all) text files, excluding generated output.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  files=$(git ls-files --cached --others --exclude-standard)
else
  files=$(find . -type f -not -path './.git/*' | sed 's#^\./##')
fi
# CHANGELOG.md is history: its entries keep the name of their release.
files=$(echo "$files" | grep -vE '(^|/)(node_modules|dist)/|pnpm-lock\.yaml$|^CHANGELOG\.md$|\.(gz|vsix|png|ico|icns|woff2?)$' || true)

if [[ -n "$dry" ]]; then
  echo "files that would change:"
  echo "$files" | xargs grep -lI -e "$old" -e "$old_env" 2>/dev/null || true
  exit 0
fi

export OLD="$old" NEW="$new" OLD_ENV="$old_env" NEW_ENV="$new_env" OLD_NAME="$old_name" NEW_NAME="$name"
echo "$files" | while IFS= read -r f; do
  [[ -f "$f" ]] && grep -qI . "$f" 2>/dev/null || continue
  perl -pi -e '
    s/\Q$ENV{OLD_ENV}\E/$ENV{NEW_ENV}/g;
    s/\Q$ENV{OLD}\E/$ENV{NEW}/g;
  ' "$f"
done

# Display name (only where it is defined).
if [[ "$name" != "$new" ]]; then
  perl -pi -e "s/^(export const APP_NAME = )'[^']*'/\$1'\$ENV{NEW_NAME}'/" web/src/brand.ts
  perl -pi -e "s/^(export const NAME = )'[^']*'/\$1'\$ENV{NEW_NAME}'/" backend/shared/lib/brand.ts
fi

mv_path() {
  [[ -e "$1" ]] || return 0
  if git ls-files --error-unmatch "$1" >/dev/null 2>&1; then git mv "$1" "$2"; else mv "$1" "$2"; fi
}
mv_path "extensions/$old-bridge" "extensions/$new-bridge"
rm -rf dist "extensions/$new-bridge/"*.vsix "extensions/$new-bridge/dist"

(cd backend && bun test shared/lib/brand.test.ts)
echo "done. Run: make check && scripts/build.sh, then review the diff."
