#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo_state_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-launchpad-demo.XXXXXX")"

printf '[fresh-demo] Using isolated state: %s\n' "$demo_state_root" >&2
printf '[fresh-demo] Existing local demo data will not be read, changed, or deleted.\n' >&2

export LOCAL_POC_DATA_ROOT="$demo_state_root"
exec "$repo_dir/scripts/start-local-poc.sh"
