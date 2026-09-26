#!/usr/bin/env bash
# Starts a local anvil chain, deploys the full protocol and runs the demo loop against it.
# Usage: pnpm demo:local   (from the repo root)
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil test account 0
RPC=http://127.0.0.1:8545

anvil --silent --port 8545 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID' EXIT
sleep 2

DEPLOYER_PRIVATE_KEY=$ANVIL_KEY WAITING_PERIOD=0 forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
forge script script/Smoke.s.sol --rpc-url $RPC --broadcast
