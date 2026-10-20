#!/usr/bin/env bash
# Rate the hardened agent through the deployed API with its live TEE, then stop the TEE VM.
# (docs/TEE.md, step 7.) Run it after the Day 11 PR is merged and the API has redeployed.
#
# Usage, from the repository root:
#   scripts/rate-live-tee.sh <agent id>
#
# It asks for the API token with no echo; the token is never written anywhere or printed.
# Environment (defaults in brackets): API_URL [https://api-production-ba50.up.railway.app]
#   CVM_NAME [bonded-tee-agent]
#
# The token goes to curl through stdin (`-H @-`), never in its arguments, so other local users can't
# read it from the process list. API_URL must be https (http only for localhost).
#
# Cost guard: the VM is stopped when this script ends for any reason (success, failure, Ctrl-C),
# so it bills only while the rating runs. Stopped, it costs about $2 a month for its disk.
set -euo pipefail

AGENT_ID="${1:?usage: scripts/rate-live-tee.sh <agent id> (an agent with a tee entry, docs/TEE.md step 7)}"
API_URL="${API_URL:-https://api-production-ba50.up.railway.app}"
CVM_NAME="${CVM_NAME:-bonded-tee-agent}"

# Parse the host: prefix checks accept localhost@remote or localhost.remote and leak the token.
python3 - "$API_URL" <<'PYURL' || { echo "API_URL must use https (http only for localhost)." >&2; exit 1; }
import sys
from urllib.parse import urlsplit
try:
    raw = sys.argv[1]
    url = urlsplit(raw)
    port = url.port  # rejects malformed ports before any token or VM operation
    valid = (url.hostname and not url.username and not url.password
             and not any(c.isspace() or ord(c) < 32 for c in raw)
             and (url.scheme == "https" or
                  (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1"))))
except ValueError:
    valid = False
sys.exit(0 if valid else 1)
PYURL

# One run at a time: two runs would fight over starting and stopping the same VM.
LOCK="${TMPDIR:-/tmp}/rate-live-tee-$CVM_NAME.lock"
mkdir "$LOCK" 2>/dev/null || { echo "Another run is in progress (remove $LOCK if it is stale)." >&2; exit 1; }

status() { phala cvms get "$CVM_NAME" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])'; }
# Stop the VM and check that it stopped, retrying: a VM left running bills by the hour, and one
# failed call (a dropped connection, the VM still busy) must not leave it on.
stop_vm() {
  echo "Stopping ${CVM_NAME} so it stops billing…"
  for attempt in 1 2 3 4 5; do
    phala cvms stop "$CVM_NAME" >/dev/null 2>&1 || true
    for _ in $(seq 1 12); do
      [ "$(status 2>/dev/null || true)" = stopped ] && { echo "Stopped."; return 0; }
      sleep 5
    done
    echo "  not stopped yet (attempt $attempt of 5), trying again" >&2
  done
  echo "COULD NOT STOP ${CVM_NAME}: it is still billing. Run: phala cvms stop $CVM_NAME" >&2
  return 1
}
trap 'stop_vm; rmdir "$LOCK" 2>/dev/null || true' EXIT

read -rs -p "API token (not echoed): " API_TOKEN
echo

echo "Starting ${CVM_NAME}…"
phala cvms start "$CVM_NAME" >/dev/null
for _ in $(seq 1 60); do [ "$(status)" = running ] && break; sleep 10; done
[ "$(status)" = running ] || { echo "The VM did not start." >&2; exit 1; }
sleep 60 # the agent inside needs a moment after the VM is up

health="$(curl -sf -m 30 "$API_URL/health")" || { echo "The API is not answering." >&2; exit 1; }
echo "API: $health"

run="$(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$API_TOKEN" |
  curl -sf -m 30 -X POST "$API_URL/arena/runs" -H @- \
    -d "{\"agentId\":\"$AGENT_ID\"}")" || { echo "Starting the rating failed (is the token right?)." >&2; exit 1; }
RUN_ID="$(printf %s "$run" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')"
echo "Rating run $RUN_ID started."

# One poll of the run's status, or nothing when the API didn't answer with it (a dropped
# connection, an empty or non-JSON reply). Never fails, so `set -e` can't end the script mid-run.
poll() {
  curl -sf -m 30 "$API_URL/arena/runs/$RUN_ID" 2>/dev/null |
    python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["status"], d.get("error") or "")' 2>/dev/null || true
}

state=""
misses=0
for _ in $(seq 1 120); do
  polled="$(poll)"
  if [ -z "$polled" ]; then
    # A missed poll says nothing about the run, which goes on in the API: try again, and only
    # give up after several in a row.
    misses=$((misses + 1))
    echo "  (no answer from the API, $misses in a row)"
    [ "$misses" -lt 8 ] || { echo "The API stopped answering. Run $RUN_ID may still finish: check it before trying again." >&2; exit 1; }
    sleep 15
    continue
  fi
  misses=0
  state="$polled"
  echo "  $state"
  case "$state" in
    done*) break ;;
    failed*) echo "The rating failed." >&2; exit 1 ;;
  esac
  sleep 15
done
case "$state" in done*) ;; *) echo "The rating did not finish in time. Check run $RUN_ID before trying again." >&2; exit 1 ;; esac

curl -sf -m 30 "$API_URL/arena/runs/$RUN_ID" | python3 -c '
import sys,json
r=json.load(sys.stdin)["report"]
print("score", r["scoring"]["score"], r["scoring"]["tier"])
print("tee  ", r.get("tee"))' || echo "Could not read run $RUN_ID's report; the rating itself is done." >&2
curl -sf -m 30 "$API_URL/agents/$AGENT_ID/score" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print("posted tx", d["tx_hash"])
print("on-chain teeMeasurement", d["signed"]["attestation"]["teeMeasurement"])' || echo "Could not read agent $AGENT_ID's posted score." >&2
