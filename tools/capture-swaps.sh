#!/usr/bin/env bash
# Long-running read-only swap capture for γ/κ calibration.
#
# Runs the production bridge with DRY_RUN=true, which starts the §6 swap stream
# for every pool in POOL_ALLOWLIST and appends rows to SWAP_STREAM_PATH. No
# signer is loaded and no verb is ever sent: the bridge's stdin is held open by
# an idle `tail` purely so the process stays alive.
#
# Restart caveat: stream cursors live in memory, so a reconnect inside one
# process backfills its gap but a process restart does not. Restarts are logged
# with a timestamp so the gap is auditable, and the JSONL sink is append-only,
# so the capture file survives them.
#
#   tools/capture-swaps.sh [env-file]        # default: .env.capture (see .env.example)
#
set -euo pipefail

cd "$(dirname "$0")/.."
env_file="${1:-.env.capture}"
[ -f "$env_file" ] || { echo "no env file: $env_file (see .env.capture.example)" >&2; exit 1; }
set -a; . "$env_file"; set +a
: "${SWAP_STREAM_PATH:?SWAP_STREAM_PATH must be set}"
[ "${DRY_RUN:-}" = "true" ] || { echo "refusing to capture with DRY_RUN != true" >&2; exit 1; }

npm run build >/dev/null
echo "$(date -Is) capture → $SWAP_STREAM_PATH (pools: $POOL_ALLOWLIST)" >&2
while true; do
  tail -f /dev/null | node dist/bridge.js || true
  echo "$(date -Is) bridge exited; restarting in 10s — swaps in this window are NOT backfilled" >&2
  sleep 10
done
