#!/usr/bin/env bash
# Runs the demo loop (register, vault, bond, cover, breach, claim) against a deployed chain.
# Usage: script/smoke.sh <robinhood|arbitrum|rpc-url>   (or from the repo root: pnpm contracts:smoke <...>)
# Keys come from OPERATOR_KEY, AGENT_KEY, USER_KEY and ATTESTER_KEY; each falls back to
# DEPLOYER_PRIVATE_KEY. Set them in your shell or the repo root's .env (see .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."
source script/env.sh
load_env
normalise_keys
RPC=$(resolve_rpc "${1:-}")
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY in .env or your shell (see .env.example)}"

forge script script/Smoke.s.sol --rpc-url "$RPC" --broadcast --slow
