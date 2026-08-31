#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_parent="$(dirname "$repo_dir")"
repo_name="$(basename "$repo_dir")"
output="${1:-$repo_parent/${repo_name}-submission.zip}"

if [[ "$output" != /* ]]; then
  output="$PWD/$output"
fi
if [[ -e "$output" ]]; then
  printf '[package] Refusing to overwrite existing file: %s\n' "$output" >&2
  exit 2
fi

temporary_parent="${TMPDIR:-/tmp}"
if [[ ! -d "$temporary_parent" ]]; then
  temporary_parent="$repo_parent"
fi
temporary_dir="$(mktemp -d "$temporary_parent/launchpad-package.XXXXXX")"
cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

archive="$temporary_dir/submission.zip"
(
  cd "$repo_parent"
  zip -q -r "$archive" "$repo_name" \
    -x \
      "$repo_name/.git/*" \
      "$repo_name/.env" \
      "$repo_name/.env.production" \
      "$repo_name/node_modules/*" \
      "$repo_name/*/node_modules/*" \
      "$repo_name/*/*/node_modules/*" \
      "$repo_name/dist/*" \
      "$repo_name/*/dist/*" \
      "$repo_name/*/*/dist/*" \
      "$repo_name/.data/*" \
      "$repo_name/.local/*" \
      "$repo_name/tmp/*" \
      "$repo_name/data/*" \
      "$repo_name/workspaces/*" \
      "$repo_name/codex-home/*" \
      "$repo_name/*/workspaces/*" \
      "$repo_name/*/codex-home/*" \
      "$repo_name/*/.data/*" \
      "$repo_name/coverage/*" \
      "$repo_name/**/*.log" \
      "$repo_name/**/*.sqlite" \
      "$repo_name/**/*.sqlite-*" \
      "$repo_name/**/.DS_Store" \
      "$repo_name/**/__MACOSX/*" \
      "$repo_name/**/*.tsbuildinfo"
)

if unzip -Z1 "$archive" | grep -Eq '(^|/)(\.env|node_modules|\.data|\.local|tmp|workspaces|codex-home)(/|$)|\.sqlite(-[^/]*)?$'; then
  printf '[package] Safety check failed: the archive contains local state or secrets.\n' >&2
  exit 3
fi

mv "$archive" "$output"
printf '[package] Created clean submission: %s\n' "$output"
