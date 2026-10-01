# Shared helpers for the deploy and smoke scripts. Source it; don't run it.

# Loads KEY=value lines from a .env file (by default the repo root's) into the environment.
# Variables already set in the shell win, and empty values are skipped, so a blank line in
# .env never overrides a default. Comments and blank lines are ignored.
load_env() {
  # Local-chain runs (the demo, the Arena's sandboxes) set this so testnet settings never leak in.
  [ "${BONDED_SKIP_DOTENV:-}" = 1 ] && return 0
  local file=${1:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/.env"}
  [ -f "$file" ] || return 0
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[2]}
    value=${BASH_REMATCH[3]}
    # Strip matching surrounding quotes.
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
    [ -n "$value" ] || continue
    [ -n "${!key+x}" ] && continue
    export "$key=$value"
  done <"$file"
}

# Foundry needs private keys with a 0x prefix; wallets often export them without one.
normalise_keys() {
  local name
  for name in DEPLOYER_PRIVATE_KEY OPERATOR_KEY AGENT_KEY USER_KEY ATTESTER_KEY; do
    if [ -n "${!name:-}" ] && [[ ${!name} != 0x* ]]; then export "$name=0x${!name}"; fi
  done
}

# Accepts a chain name (robinhood, arbitrum) or an RPC URL and prints the RPC URL.
resolve_rpc() {
  case "${1:-}" in
    robinhood) echo "https://rpc.testnet.chain.robinhood.com/rpc" ;;
    arbitrum) echo "https://sepolia-rollup.arbitrum.io/rpc" ;;
    sepolia) echo "https://ethereum-sepolia-rpc.publicnode.com" ;;
    http://* | https://*) echo "$1" ;;
    *)
      echo "unknown chain '${1:-}': use robinhood, arbitrum, sepolia or an RPC URL" >&2
      return 1
      ;;
  esac
}
