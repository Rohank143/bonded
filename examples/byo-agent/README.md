# Bring your own agent: example

A small trading agent that runs on your own server and keeps its funds in a Bonded Mandate Vault, using [`@bonded/sdk`](../../packages/sdk/README.md).

The brain (`src/agent.ts`) is a simple rebalancer, and it is naive on purpose: it also does what messages in its inbox tell it to, the way an LLM agent can be steered by what it reads. The protection doesn't depend on the brain:

- Every action is `MandateVault.execute` from the agent key, so the vault checks it against the mandate and records any breach on chain.
- Before sending, the SDK's guard dry-runs the action against the vault and refuses anything the vault would record as a breach. With `BONDED_API_URL` set, it also asks Sentinel, with the inbox as the untrusted input.

## Run it

You need a vault whose agent key you hold (create one from the web app's onboarding, or with `buildMandate` and `MandateVaultFactory.createVault`).

```bash
pnpm --filter @bonded/example-byo-agent build
BONDED_RPC_URL=https://rpc.testnet.chain.robinhood.com/rpc \
BONDED_CHAIN_ID=46630 \
BONDED_VAULT=0xYourVault \
BONDED_AGENT_KEY=0xYourAgentKey \
BONDED_ROUTER=0xTheRouterYourMandateAllows \
BONDED_TOKENS=tUSDG:0x...:6,tTSLA:0x...:18 \
BONDED_TARGET=tTSLA \
BONDED_INBOX=./inbox.txt \
pnpm --filter @bonded/example-byo-agent start
```

Each action prints `sent` or `refused` with the reason, then the vault's state. Keep the agent key out of the repository and out of shell history; load it from your secret store.

## Test

```bash
pnpm --filter @bonded/example-byo-agent test
```

The test starts a local chain with the real contracts, creates a vault, plants an instruction in the inbox, and checks that the swap goes through and the planted transfer is refused with nothing recorded.

## Rated where it runs

Started by the Bonded runner (which sets `BONDED_EPISODE_ID` and the other `BONDED_*` variables, read with the SDK's `fromBondedEnv`), the same agent runs one Arena episode instead (`src/episode.ts`):

- **Tools mode**: it reads its world through the episode's HTTP tools and writes with the `swap` and `transfer` tools; the Arena sends them through the episode vault.
- **Chain mode**: it reads through the tools, then signs `execute` on the episode vault itself through the episode's fork RPC, with the session key, guarded by the SDK as in production. A key held in a TEE (no `BONDED_SESSION_KEY`) needs your own signer.

It posts to the episode's done endpoint when finished. Either way the verdict is the episode vault's breach log, not what the agent reports. `BONDED_TARGET` picks the token to hold (default: the second token of the episode's market).

The test runs both modes against a stand-in for the gateway's tools, with chain mode on a local chain. Running it through the real gateway and runner is the Arena gateway work's to add.
