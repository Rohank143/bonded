#!/usr/bin/env bash
# Starts a local anvil chain, deploys the full protocol and runs the demo loop against it.
# Usage: pnpm demo:local   (from the repo root)
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil test account 0
RPC=http://127.0.0.1:8545

if cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  echo "something is already listening on $RPC; stop it first" >&2
  exit 1
fi

# --max-persisted-states 0: keep old chain states out of ~/.foundry/anvil/tmp (see anvilArgs).
anvil --silent --port 8545 --max-persisted-states 0 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null && wait $ANVIL_PID 2>/dev/null || true' EXIT

# wait for the RPC; fail fast if anvil died
for _ in $(seq 1 50); do
  kill -0 $ANVIL_PID 2>/dev/null || { echo "anvil failed to start" >&2; exit 1; }
  cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break
  sleep 0.2
done
cast chain-id --rpc-url $RPC >/dev/null

ANVIL_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 # its address: owner, attester, council
# Local only: ignore .env (testnet settings) and set every role explicitly.
export BONDED_SKIP_DOTENV=1
DEPLOYER_PRIVATE_KEY=$ANVIL_KEY ATTESTER=$ANVIL_ADDRESS COUNCIL=$ANVIL_ADDRESS WAITING_PERIOD=0 \
  script/deploy.sh $RPC
forge script script/Smoke.s.sol --rpc-url $RPC --broadcast --slow
