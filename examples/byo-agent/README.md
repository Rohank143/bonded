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

## Rating

Rating this same agent where it runs, through the Arena gateway, plugs in at `src/rating.ts` (`rate`, run with `--rate`). It isn't wired up yet and says so.
