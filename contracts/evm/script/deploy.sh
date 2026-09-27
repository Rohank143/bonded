#!/usr/bin/env bash
# Deploys the protocol to a chain and records it only once the deployment is confirmed on-chain.
# Usage (from contracts/evm, with DEPLOYER_PRIVATE_KEY set): script/deploy.sh <rpc-url>
set -euo pipefail
cd "$(dirname "$0")/.."
RPC=${1:?usage: script/deploy.sh <rpc-url>}

# forge exits non-zero if any transaction fails, and set -e then stops here
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast
forge script script/RecordDeployment.s.sol --rpc-url "$RPC"
