#!/usr/bin/env bash
# Deploys the protocol to a chain and records it only once the deployment is confirmed on-chain.
# Usage: script/deploy.sh <robinhood|arbitrum|rpc-url>   (or from the repo root: pnpm contracts:deploy <...>)
# Reads DEPLOYER_PRIVATE_KEY (and the optional ATTESTER, COUNCIL, WAITING_PERIOD) from your shell
# or from the repo root's .env. See .env.example.
set -euo pipefail
cd "$(dirname "$0")/.."
source script/env.sh
load_env
normalise_keys
RPC=$(resolve_rpc "${1:-}")
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY in .env or your shell (see .env.example)}"

# forge exits non-zero if any transaction fails, and set -e then stops here.
# --slow sends one transaction at a time and waits for each receipt: batch sending can leave a
# nonce gap (seen on anvil) that stalls the deploy forever, and flaky testnet RPCs are safer too.
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow
forge script script/RecordDeployment.s.sol --rpc-url "$RPC"
