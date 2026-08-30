#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

failures=0
max_tracked_file_bytes="${MAX_TRACKED_FILE_BYTES:-5242880}"

fail() {
  printf 'repository check: %s\n' "$1" >&2
  failures=$((failures + 1))
}

while IFS= read -r -d '' path; do
  case "$path" in
    .env.example)
      ;;
    .env|.env.*|*/.env|*/.env.*|*/node_modules/*|*/dist/*|*/coverage/*|*/.data/*|*/.local/*|data/*|*/data/*|workspaces/*|*/workspaces/*|codex-home/*|*/codex-home/*|*.tfstate|*.tfstate.*|*.sqlite|*.sqlite-shm|*.sqlite-wal|*.db|*.log)
      fail "generated or sensitive path is tracked: $path"
      ;;
  esac

  size="$(git cat-file -s ":$path" 2>/dev/null || wc -c < "$path")"
  if (( size > max_tracked_file_bytes )); then
    fail "tracked file exceeds ${max_tracked_file_bytes} bytes: $path ($size bytes)"
  fi
done < <(git ls-files -z)

secret_files="$(
  git grep -I -l -E -- \
    '-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----|(^|[^[:alnum:]_])(AKLT|AKTP)[[:alnum:]]{20,}|(^|[^[:alnum:]_])sk-[[:alnum:]_-]{24,}|(^|[^[:alnum:]_])gh[pousr]_[[:alnum:]]{20,}|github_pat_[[:alnum:]_]{20,}|(^|[^[:alnum:]_])xox[baprs]-[[:alnum:]-]{10,}' \
    -- ':!scripts/check-repository.sh' \
    2>/dev/null || true
)"
if [[ -n "$secret_files" ]]; then
  fail "possible credential material found in tracked files:"
  printf '%s\n' "$secret_files" >&2
fi

if ! git diff --check; then
  fail "unstaged changes contain whitespace errors"
fi
if ! git diff --cached --check; then
  fail "staged changes contain whitespace errors"
fi

if origin_url="$(git remote get-url --push origin 2>/dev/null)"; then
  case "$origin_url" in
    *TechJamYAT/agent-bouncer-techjam-2026*)
      ;;
    *)
      fail "origin push URL is not the team repository: $origin_url"
      ;;
  esac
fi

if (( failures > 0 )); then
  printf 'repository preflight failed with %d issue(s).\n' "$failures" >&2
  exit 1
fi

printf 'repository preflight passed.\n'
