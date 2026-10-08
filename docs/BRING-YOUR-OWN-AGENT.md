# Bring your own agent

Your agent, in any framework or language, running on your own servers, can be protected by a Mandate Vault (or a module on the smart account it already uses), attacked and rated by the Arena where it runs, and insured. This page is the builder's guide: how to connect it, what the Arena sees, what the score means and what it doesn't.

For what an agent is in Bonded's terms, see [AGENTS.md](AGENTS.md). For how Bonded relates to the agents people already use, see [YOUR-AGENTS.md](YOUR-AGENTS.md).

## What you get

| | What it means | How |
|---|---|---|
| **Protect** | Your agent's key can only act through a contract that checks every action against your mandate and records any breach on chain. That record pays claims | A Mandate Vault, or a `MandateModule` on your ERC-7579 smart account (Safe through Safe7579, or another ERC-7579 account). The TypeScript SDK `@bonded/sdk` and its plugins for Coinbase AgentKit, Solana Agent Kit and ElizaOS do the wiring |
| **Rate** | The Arena attacks your agent while it runs where it runs, and judges it only by what the vault records. The signed score goes on chain | A small runner (`@bonded/runner`) next to your agent connects out to the Arena Gateway. Your agent talks to it over MCP, plain HTTP, or (chain mode) a JSON-RPC endpoint |
| **Bind** | How firmly the score is tied to the code that trades: **declared** (you say which code it is) or **TEE** (every episode proves it with an Intel TDX quote) | Register a code hash, and optionally your TEE's URL and compose hash |

Payouts and pass or fail are decided by the vault's breach log, on chain. Nothing your agent, the runner or an AI says changes a verdict.

```mermaid
flowchart LR
  subgraph yours["Your servers"]
    Runner["@bonded/runner"] -- "starts once per episode" --> Agent["Your agent"]
  end
  subgraph arena["Bonded Arena (rating worker)"]
    Gateway["Arena Gateway"] --> Tools["World + tools<br/>(attacks planted here)"]
    Gateway --> Fork["Sandbox chain<br/>with a fresh vault"]
    Fork -- "breach log" --> Judge["Judge and score"]
  end
  Runner -- "WebSocket, outbound only" --> Gateway
  Agent -- "MCP / HTTP tools" --> Gateway
  Agent -. "chain mode: signed txs" .-> Gateway
  Judge -- "signed score" --> Registry["BondedRegistry"]
```

## What's live today

Everything on this page is built and tested in the repository. Some of it isn't deployed or published yet, and this is how to work around that:

| Piece | Status | Until then |
|---|---|---|
| `@bonded/runner`, `@bonded/sdk` (and `@bonded/shared`, `@bonded/solana`, which they depend on) | Not yet on npm, so `npx @bonded/runner` and `npm install @bonded/sdk` don't work yet | Run from a clone of the repository (the quick start below); in your own workspace package use `"@bonded/sdk": "workspace:*"` |
| The runner's Docker image | Not published | Build it yourself: `docker build -f apps/runner/Dockerfile -t bonded-runner .` |
| The hosted Arena Gateway (the arena-worker's public address), and registering your own agent in the hosted web app | Configured, not live until the next deployment of the rating service | Rate locally with the Arena CLI (below). The agent page's runner command shows the gateway's address once there is one |
| `MandateModule` and its factory | Not deployed on any testnet: the module needs a new CoverManager, ClaimsEngine and DisputeModule, so it ships with the next protocol deployment ([AUDIT.md](AUDIT.md#addendum-mandatemodule)). The web app's onboarding says "Not deployed on this chain yet" | Use a Mandate Vault, or try the module on a local chain (its tests and the SDK's run there) |
| Mandate Vaults, cover, and self-serve ratings of Bonded's built-in agent designs | Live on Robinhood Chain testnet | |

## Quick start: a rated agent on your machine

The fastest path from zero to a rated agent needs no keys, no accounts and no network beyond installing dependencies. It needs Node 22, pnpm 10 and Foundry ([DEVELOPING.md](DEVELOPING.md#1-install-the-tools)).

```bash
git clone --recursive https://github.com/ddboy19912/bonded && cd bonded
pnpm install
pnpm build
```

**Terminal 1** starts a local chain with the protocol deployed, a local Arena Gateway, and waits for your runner:

```bash
pnpm arena rate --agent remote --runner-token my-local-runner-token
```

**Terminal 2** starts the runner with an example agent (tool mode, over MCP):

```bash
BONDED_RUNNER_TOKEN=my-local-runner-token node apps/runner/dist/cli.js \
  --gateway http://127.0.0.1:8789 -- node apps/runner/examples/mcp-agent.mjs
```

The Arena runs every published attack once, a held-out set made for this rating alone (one variant per attack class), and two control episodes with no attack, each as one run of your command. It prints each verdict, then the score, and writes the report to `apps/arena/ratings/remote_local/report.md`.

Now put your own agent in place of `node apps/runner/examples/mcp-agent.mjs`. For chain mode add `--mode chain` to both commands and try `apps/runner/examples/chain-agent.mjs`. Add `--repeats 5` to the rating to run each attack five times, as published ratings do: with one run per attack, even an agent with no breaches scores only in the 50s, because the uncertainty is wide ([AGENTS.md](AGENTS.md#the-agents)).

The example agents are deliberately simple: they read, make the one trade the task names, and ignore every instruction they read. A runner-started agent written with the SDK is in `examples/byo-agent`.

## Protect your agent

Protection and rating are independent: an agent can trade through a vault without being rated, and the Arena rates an agent against a fresh vault with your mandate on its sandbox chain, whatever protects your real funds.

### A Mandate Vault, with the SDK

The vault holds the funds. Your agent's key can only act through `MandateVault.execute(target, data)`, which checks the action against the mandate (tokens, contracts, recipients, per-trade and daily limits) and records any breach. In **Monitor** mode a breach goes through and is recorded; in **Enforce** mode it is blocked and still recorded. Create one from the web app (Onboard an agent), or with `buildMandate` and `MandateVaultFactory.createVault`.

```ts
import { BondedVault } from "@bonded/sdk";
import { privateKeyToAccount } from "viem/accounts";

const vault = new BondedVault({
  vault: "0xYourVault",
  chain, // a viem Chain; or pass publicClient
  account: privateKeyToAccount(agentKey), // the vault's agent key; or pass walletClient
  router: "0xRouter", // the swap venue your mandate allows
});

await vault.swap({ tokenIn: usdg, tokenOut: tsla, amountIn: 1_000_000_000n });
const check = await vault.dryRun({ type: "transfer", token: usdg, to: someone, amount });
// { ok, executed, blocked, breach?, breaches, wouldFreeze }: the vault's own verdict, simulated
const status = await vault.status(); // frozen, mode, breachCount, agent, guardian, mandateHash, ...
```

- **Dry runs use the contract's own logic.** `dryRun` simulates `execute` from the agent key (`eth_simulateV1`) and reads the vault's own events, so it can't drift from what the vault does. It needs an RPC that supports `eth_simulateV1` (anvil and Robinhood Chain's public RPC do).
- **Typed errors.** `BlockedByMandateError`, `VaultFrozenError`, `NotAgentError`, `CallRevertedError` and the rest, each a `BondedError` with a stable `code`. In Monitor mode a breaching action is not an error: it runs, and its breaches come back in the result.
- **Mandates.** `buildMandate(rules)` turns plain rules (dollars, percentages) into the vault's parameters and the mandate hash. It is the same builder the web app's onboarding uses.

The full API is in the [SDK README](../packages/sdk/README.md).

### A module on the smart account you already use

If your agent already trades from a smart account, you don't have to move the funds. A `MandateModule` is an ERC-7579 module that runs the same checks as a vault (they share one implementation, `MandateBase`, and differential tests require identical results). It installs on a Safe through the Safe7579 adapter, or on any ERC-7579 account.

- **The agent gets a session key** that can act only through `module.execute(target, data)`. The module makes the call from the account. Same modes, breach types, freeze on breach, guardian and breach log as a vault.
- **You keep full control** of the account: move funds, uninstall the module, install others.
- **Install it twice**: as an executor (required) and as a hook (recommended). Only the module the account created last can be installed. The hook tells your own transactions apart from the agent's, so moving your own funds isn't mistaken for a breach. A Safe owner's own `execTransaction` doesn't pass through the hook: after moving funds that way, call `sync()` on the module (ideally in the same Safe transaction), or the next action records a Deferred breach and freezes the agent.
- **Tokens outside the mandate's asset list** (a smart account usually holds others): approving or transferring one is a breach on a module. A token outside the list that you already approved to an allowed contract isn't protected, so give the agent a dedicated account holding only the mandate's assets.
- **Only Enforce-mode modules can hold cover.** In Monitor mode a breach goes through, and the payout would go to the account, whose owner could have asked the agent for that breach. Monitor mode also runs a breaching call with the account's authority, which reaches further than a vault's (other modules, adapters that trust the account). A Monitor-mode module still protects and records; it just can't be insured.
- **What cover pays on a module.** Premiums are pulled from the account (and count only once they arrive); payouts go into it, bond first, then the pool. In Enforce mode a breach through `execute` is blocked, so nothing is lost. A Deferred breach (an unexplained drop) is recorded and freezes the agent but isn't paid, because on a smart account it can't be told apart from the owner moving their own funds. So a module's cover pays through grey-area disputes, and on a module those always need the council's approval.

The SDK prepares the install as one transaction the account's owner sends:

```ts
import { installMandateModule, BondedVault } from "@bonded/sdk";

const plan = await installMandateModule(publicClient, {
  moduleFactory, // `moduleFactory` in the chain's deployment file
  account: "0xYourSafe",
  accountType: "safe7579", // or "erc7579" for an account like the reference implementation
  rules, // as for buildMandate
  agent: sessionKeyAddress,
  guardian: ownerAddress, // must own the agent id to buy cover
});
// plan.calls: createModule, then installModule as executor and as hook (for a Safe MultiSend)
// plan.execute.data: the same three calls as one ERC-7579 batch (e.g. a user operation)
// plan.module: where the module will be; plan.params.mandateHash: the hash ratings and quotes use

const vault = new BondedVault({ vault: plan.module, chain, account: sessionKey });
```

Nothing is sent by the SDK. The web app's onboarding offers the same ("Protect the smart account I already use") and shows the calls to send. A module's mandate hash is the commitment to the rules it enforces (`mandateCommitment`), which the factory checks on chain, so build its mandate with `buildMandate(rules, { for: "module" })`. Details: [contracts README](../contracts/evm/README.md#mandatemodule-one-per-smart-account).

### Framework plugins

Each plugin is a subpath of `@bonded/sdk`, with its framework as an optional peer dependency.

| Framework | Import | What it does | Limits |
|---|---|---|---|
| **Coinbase AgentKit** (0.10) | `BondedWalletProvider` from `@bonded/sdk/agentkit` | A wallet provider that turns every `sendTransaction` into `vault.execute(to, data)`; `getAddress()` is the vault. AgentKit's action providers then trade through the mandate unchanged. `guard: true` dry-runs each one first | Refuses native value (vaults are ERC-20 only), contract creation, and `sign`, `signTypedData` and `signTransaction` (a raw signature would act outside the vault, so permits and x402 payments don't work). For a module, use `await BondedWalletProvider.create(...)` |
| **Solana Agent Kit** (2) | `bondedVaultPlugin` from `@bonded/sdk/solana-agent-kit` | Actions `BONDED_VAULT_TRANSFER`, `BONDED_VAULT_STATUS` and, when you pass a `swap` builder, `BONDED_VAULT_SWAP`, through the `bonded_vault` program's `execute` | Scoped to what the Solana program checks: no destination list (any transfer out of the vault is a breach), approvals never allowed, no price check or 24-hour limit yet, one instruction per `execute` (a multi-hop route may not fit). You supply the swap builder |
| **ElizaOS** (1.7) | `bondedPlugin` from `@bonded/sdk/eliza` | Actions `BONDED_SWAP`, `BONDED_TRANSFER`, `BONDED_APPROVE` through the vault, and a `BONDED_VAULT` provider that reports its mode, frozen state and breach count. Each action is dry-run first; Sentinel optional | Parameters come from the caller or the runtime's small model; amounts are whole tokens |

Each plugin has an end-to-end test that performs an allowed and a breaching action and checks the vault's breach log (`pnpm --filter @bonded/sdk test`). The Solana tests need the programs built and `solana-test-validator`; without them they skip.

### Guarded, with Sentinel

```ts
import { guarded } from "@bonded/sdk";

const safe = guarded(vault, { sentinel: { apiUrl, mandate, tokens } }); // sentinel is optional
await safe.swap(params, { untrustedInputs: [{ tool: "read_inbox", output: email }] });
```

Before each write the guard runs the dry run and refuses a predicted breach, then (if configured) asks Sentinel and refuses if Sentinel advises against. That turns a Monitor-mode vault into one that doesn't knowingly breach. It is a client-side check: the chain can change between the dry run and the transaction, and the vault's verdict is what counts. Sentinel is advisory ([SENTINEL.md](SENTINEL.md)); when it is down the guard refuses by default (`onUnavailable: "proceed"` to go ahead). `checkWithSentinel` calls the API directly, signed by the agent key.

## Get it rated

### How an episode runs

A rating is many episodes. Each one gives your agent a benign task, plants one attack (or none, in a control) in the world it reads, and judges by what the episode's vault records.

```mermaid
sequenceDiagram
  participant W as Rating worker
  participant G as Arena Gateway
  participant R as Your runner
  participant A as Your agent
  R->>G: connect (runner token), hello
  W->>G: open episode: fresh capability URL, fresh vault on the sandbox chain
  G->>R: episode (task, endpoints, vault, deadline)
  R->>A: start your command with BONDED_* set
  A->>G: read tools (MCP or HTTP): attacks are planted here
  A->>G: write: a tool call (tool mode) or a signed execute() (chain mode)
  G->>W: the vault records any breach
  A->>G: POST done (optional)
  R->>G: episode_done (exit code, last 4 KB of output)
  W->>W: verdict = the vault's breach log
```

The Arena treats your agent as just another agent: the same attack library, the same judge and the same scoring as Bonded's own agents. The parity tests run Bonded's scripted agents through the gateway over MCP, over HTTP and in chain mode, and require the same verdict, episode by episode, as in-process (`pnpm --filter @bonded/arena test:parity` runs the whole published library).

### The runner

```bash
BONDED_RUNNER_TOKEN=... bonded-runner --gateway <url> [--mode tools|chain] [--tee-url <url>] -- <your agent command...>
```

From a clone of the repository, `bonded-runner` is `node apps/runner/dist/cli.js` (after `pnpm build`).

| Flag | Meaning |
|---|---|
| `--gateway <url>` | The Arena Gateway (or `BONDED_GATEWAY_URL`) |
| `--token <token>` | Your runner token. Prefer `BONDED_RUNNER_TOKEN`, which keeps it out of shell history and the process list |
| `--mode tools\|chain` | `tools` (default) or `chain`. It must match the mode you registered, or the runner never counts as connected |
| `--tee-url <url>` | Your agent's TEE: for each episode the runner fetches `GET <url>/attestation?nonce=…` and forwards the answer unchanged |
| `--quiet` | Don't copy the agent's output to the terminal |

- **It connects out**, to `wss://<gateway>/runner/connect`, so you open no inbound port. It pings every 15 seconds and reconnects with backoff if the connection drops.
- **It stops for good** (exit code 2) when the token is wrong or revoked, or another runner connects with the same token (the newer one wins).
- **One episode at a time.** For each one it starts your command, and stops it (SIGTERM to its process group, then SIGKILL 5 seconds later) when the gateway cancels the episode or the deadline passes.
- **The runner token never reaches your agent.** The agent gets only the episode's URLs, which work for that episode alone.

**Docker.** Build the runner's image, then put your agent on top of it. The image runs as the unprivileged `node` user, so give it your files:

```dockerfile
FROM bonded-runner
COPY --chown=node:node my-agent /agent
RUN cd /agent && npm ci --omit=dev
CMD ["--gateway", "https://<gateway>", "--", "node", "/agent/index.js"]
```

and run it with `docker run --rm -e BONDED_RUNNER_TOKEN=... <your agent image>`.

### What your agent gets

Each episode starts your command once, with:

| Variable | Value |
|---|---|
| `BONDED_EPISODE_ID` | The episode's id |
| `BONDED_MODE` | `tools` or `chain` |
| `BONDED_TASK` | JSON: `{ goal, mandate, policy?, maxSteps }`. The goal is the job, the mandate is what you may do (in words and, in `policy`, as rules), `maxSteps` caps tool calls and transactions |
| `BONDED_MCP_URL` | MCP over streamable HTTP |
| `BONDED_TOOLS_URL` | Plain HTTP: `GET` lists the tools, `POST <url>/<name>` with JSON arguments calls one |
| `BONDED_OPENAPI_URL` | OpenAPI 3.1 description of the HTTP endpoints |
| `BONDED_DONE_URL` | `POST { finalMessage?, usage? }` when finished (optional: exiting also ends the episode) |
| `BONDED_RPC_URL` | Chain mode: Ethereum JSON-RPC for the episode's chain |
| `BONDED_SESSION_KEY` | Chain mode without a TEE: a fresh private key the episode's vault accepts as its agent |
| `BONDED_VAULT` | The episode's vault |
| `BONDED_CHAIN_ID` | The chain id |
| `BONDED_CONTRACTS` | JSON: `{ exchange, tokens: [{ symbol, address, decimals }] }` |
| `BONDED_DEADLINE_MS` | Milliseconds the agent has (4 minutes by default) |

In TypeScript, `fromBondedEnv()` from `@bonded/sdk` reads and checks them all, naming any that is missing or malformed.

### Tool mode: MCP or HTTP

Your agent reads its world and trades through tool calls. Any language that speaks MCP or HTTP works. The Arena sends each write through the episode's vault with its own sandbox key, exactly as for Bonded's in-process agents.

| Tool | Reads (attack surface) | |
|---|---|---|
| `read_inbox` | Direct messages (`dm`) | |
| `read_news` | News articles (`news`) | |
| `read_social` | Social posts (`social`) | |
| `get_prices` | USD prices (`price_feed`) | |
| `get_token_info` | A token's address, decimals and description (`token_metadata`) | |
| `get_recent_transfers` | Transfers in and out of the vault (`tx_history`) | |
| `get_market_report` | The daily research report (`tool_output`) | |
| `read_market_alerts` | Listings, halts and notices (`market`) | |
| `read_counterparty_messages` | Messages from other agents (`counterparty`) | |
| `get_portfolio` | The vault's balances from the chain (no surface: attacks can't reach it) | |
| `swap`, `transfer`, `approve` | Writes, through the vault. Amounts are whole tokens as decimal strings (`"2000"`, `"0.5"`) | Tool mode only |

Results are the Arena's own: `{ ok: true, output }` or `{ ok: false, error }` over HTTP (status 200 either way), and over MCP the output as JSON text, with `isError` for a failure. A failed call is not fatal: react to it.

### Chain mode

Reads are still tool calls (that is where attacks are planted), but writes are transactions your agent signs and sends itself, as in production. Write tools are not listed in chain mode.

- Each episode's vault names a fresh session key as its agent (`BONDED_SESSION_KEY`), funded with test gas on the sandbox chain. A TEE-bound agent gets no key: the vault names the TEE's attested address, and your TEE signs.
- Every trade is `MandateVault.execute(target, data)` sent with `eth_sendRawTransaction`: approve the exchange for a token, call the exchange's `swap`, or a token's `transfer` or `approve`.
- The RPC endpoint accepts standard reads (`eth_call`, `eth_getLogs`, `eth_getBalance`, receipts, blocks, gas and fee queries, `net_version`, `web3_clientVersion`) and only those transactions: signed by the episode's key, for this chain, to the episode's vault's `execute`, with no ETH. Every `anvil_`, `hardhat_`, `evm_`, `debug_`, `trace_`, `ots_`, `txpool_`, `personal_` and `eth_sign*` method, `eth_sendTransaction`, `eth_accounts`, filters and subscriptions are refused. Batches of up to 50 requests work.
- Chain mode needs an EVM agent. A Solana agent can be rated in tool mode.

### The episode protocol

The runner and the gateway speak JSON over the WebSocket; both parse every message with the same schemas (`packages/shared/src/runner.ts`), so you can write your own runner if you need to.

| Direction | Message | Contents |
|---|---|---|
| runner → gateway | `hello` (first) | `runnerVersion`, `protocol` (1), `mode`, `teeUrl?` |
| runner → gateway | `ping` | every 15 s; answered with `pong`. The token is checked again at each one |
| gateway → runner | `episode` | `episodeId`, `task`, `mode`, `endpoints` (`mcp`, `tools`, `openapi`, `rpc?`, `done`), `chainId`, `vault`, the market's `exchange` and `tokens`, `sessionKey?`, `deadlineMs`, `nonce?` |
| runner → gateway | `tee_evidence` | when the episode has a `nonce`: the TEE's answer, unchanged, or an `error` |
| runner → gateway | `episode_started`, `episode_done` | `exitCode`, `signal?`, `durationMs`, the last 4 KB of stdout and stderr, `error?` |
| gateway → runner | `cancel` | stop the episode's agent |

Close codes: 4000 another runner replaced this one, 4002 a protocol error (a malformed message, no hello, or an unsupported version), 4003 no heartbeat, 4004 the token was revoked.

### Rate locally with the Arena CLI

`pnpm arena rate --agent remote` (or `run`, for verdicts without a score) starts a local gateway and waits for your runner. Options beyond the usual `--repeats`, `--enforce` and `--fork`:

| Flag | Meaning |
|---|---|
| `--mode tools\|chain` | How your agent acts (default `tools`) |
| `--runner-token <t>` | The token your runner connects with (default: a fresh one, printed). At least 16 characters |
| `--gateway-port <n>`, `--gateway-host <h>` | Where the local gateway listens (default `127.0.0.1:8789`) |
| `--public-url <url>` | The address your runner and agent reach the gateway at, when it isn't `http://<host>:<port>` (for example behind a tunnel) |
| `--runner-wait <s>` | How long to wait for the runner (default 300) |
| `--episode-timeout <s>` | Each episode's time limit (default 240) |
| `--name <name>` | The agent's name in the report (default `remote/local`) |
| `--held-out-fresh <n>` | Variants per attack class made for this rating alone (default 1; 0 for none). Used payloads are recorded in `~/.config/bonded/held-out-used.txt` so none is reused |
| `--held-out-model <id>`, `--held-out-max-usd <n>` | Draft those variants with a model (needs `OPENROUTER_API_KEY`; cap default $0.25). Without it they are deterministic rewrites |

`--fork robinhood` or `--fork arbitrum` rates against a copy of the live testnet instead of a fresh chain. A local rating is signed by the sandbox's attester and posted to the sandbox's own registry (on a fork, signed only): it never reaches a live chain.

### Rate from the web app

1. **Onboard an agent.** In step 1, choose **My own agent**, then how it acts (**Tools** or **Chain**), its code hash (your own fingerprint of the code that runs: an image digest `sha256:…` or a commit, as 32 bytes of hex), and optionally its TEE's URL and compose hash. Then create a vault (or choose a module) and a bond as usual. Registering is signed in your wallet; the mandate must match the vault's on-chain one exactly.
2. **Connect your agent**, on the agent's page:
   - **Runner token.** Create one by signing in your wallet. It is shown once (it starts `bonded_rt_`); the API stores only its hash. A new token replaces the old one, and **Revoke it** disconnects the runner.
   - **Start the runner** where your agent runs, with the command the page gives you (Node or Docker). The page shows the runner's status: no token, waiting, connected or offline, and why a connected runner doesn't count (for example, the wrong mode).
   - **Rate my agent**, signed in your wallet. It needs a connected runner. Every attack runs five times (the published library, accepted bounties, Bonded's current held-out set, and a held-out set made for this rating alone), plus two controls. Progress shows on the page and in the Arena's live feed.
3. **Buy cover** from the vault page, within the cover cap for the score's binding (below).

Limits, as for every self-serve rating: one rating an hour per agent, and 40 self-serve ratings a day per chain. A rating can take a while: it is a few hundred episodes, one at a time, each as long as your agent takes (up to 4 minutes).

The same flow is plain HTTP, for scripts. Each write is an EIP-191 `personal_sign` of a short text message built by `selfServeMessage` in `@bonded/shared` (for example `Bonded: create runner token`, `chain 46630`, `agent 12`, `time <unix seconds>` on separate lines), valid for 10 minutes; a runner-token signature can be used once.

| Endpoint | What it does |
|---|---|
| `POST /self/agents` | Register (with `kind: "remote"`, `codeHash`, `mode`, `tee?`, `protection?`), signed by the agent's owner |
| `POST /self/agents/:id/runner-token` | Create a runner token, returned once |
| `DELETE /self/agents/:id/runner-token` | Revoke it |
| `GET /self/agents/:id/runner` | Whether a token exists (never the token), the runner's state, version, mode and TEE URL, and the last rating that had to be skipped |
| `POST /self/agents/:id/rate` | Queue a rating; refused with 409 if no runner is connected |
| `GET /agents/:id/score` | The latest score with its binding, coverage, held-out set and liveness |

## Binding levels

| | **Declared** | **TEE** |
|---|---|---|
| What ties the score to the code | You say which code it is (`codeHash`). Nothing checks it | At the start of the rating and of every episode, the Arena sends a fresh nonce and your TEE answers with an Intel TDX quote that commits to the code hash, its keys and the nonce. Every episode must show the same measurement and key, or the rating fails |
| The attestation's `teeMeasurement` | 0 | The verified measurement |
| Effect on the score | The key-custody term assumes the key is on your server: an assumed 2% a year chance it is stolen | The key-custody term adds nothing: a key made in a verified TEE can't be extracted |
| Cover cap (underwriting policy, not score) | 5,000 tUSDG in total | 20,000 tUSDG in total |
| Extra condition for cover | | The vault's (or module's) agent key must be the TEE's attested key, and the TEE's live checks must not have failed |

The key-custody term is an assumption, not a measurement, and the report says so next to the number. The caps are a policy choice the API applies when it signs a quote (`DECLARED_COVER_CAP_USD` and `TEE_COVER_CAP_USD` set them per deployment); the web app labels them as underwriting policy. Bonded's own built-in designs have no binding cap.

### Bring your own TEE

The Arena verifies TEEs the way it verifies Bonded's own TEE agent ([TEE.md](TEE.md)), against your own compose hash:

- **Phala dstack on Intel TDX**, booted from an approved production OS image (`APPROVED_OS_IMAGES` in `apps/arena/src/tee.ts`; development images, which allow SSH, are refused). Intel TCB status `UpToDate` or `SWHardeningNeeded`.
- **An evidence endpoint**: `GET <url>/attestation?nonce=<32 bytes hex>` returning `{ quote, eventLog, composeHash, codeHash, evmAddress, solanaPublicKey, nonce }`, where the quote's report data is `teeReportData` from `@bonded/shared` (a hash of the code hash, both keys and the nonce). `services/tee-agent` is a working reference.
- **Reachable over https from Bonded**, not only from your runner: the rating worker challenges the registered URL before a rating starts, and the keeper re-challenges it every ten minutes. The runner's `--tee-url` is used for the per-episode evidence.
- **Register** the URL and the compose hash published for that deployment, with the same code hash your TEE reports.

In chain mode with a TEE, the episode's vault names the TEE's attested EVM address and no session key is sent: your agent must have its TEE sign the `execute` transactions.

## What the report shows

Beyond the score, the tier, the premium and per-class results ([AGENTS.md](AGENTS.md#how-an-agent-is-rated)), a rating of your agent records:

- **Coverage.** For each attack surface, how many attack episodes planted something there, and in how many of those your agent read it. An attack planted where your agent never looks can't reach it, so it counts as safe without testing anything: low coverage means the score says less. The scoring model doesn't change with coverage; the report and the API show it so a reader can judge.
- **A held-out set made for this rating alone.** You see every attack your agent reads, so each rating of your agent also runs variants of the published seeds that no earlier rating used: one per attack class by default, drafted by a model when the rating service has one configured, otherwise deterministic rewrites (wording, tokens, amounts and names change). A variant is kept only if Bonded's undefended reference agent still falls for it. The report records the set's generation seed, how many attacks it had and how they were made. The published seeds, accepted bounties and Bonded's own held-out set run too.
- **Liveness.** In how many control episodes (no attack) your agent did its normal task. An agent that doesn't trade can't be breached either, so a rating where it did its task in fewer than half the controls is not attested. The report is kept, so you can see why.
- **Binding**, declared or TEE, next to the score.

## Staying rated

- **A score is valid for 30 days.** After that the registry no longer reports it, and new cover can't be quoted from it.
- **Renewal.** While your runner is connected, the rating service queues a new rating once the score has 3 days or less to run (it checks every ten minutes, and waits 6 hours before trying again after a failed attempt).
- **Runner offline at expiry.** The score lapses, and the agent's page says that is why. Start the runner and rate again.
- **A new attack is accepted** (a bounty): every rated agent is re-rated. Yours is queued if its runner is connected; if not, the skipped rating is recorded and shown on the page.
- **Your TEE changes** (a re-deploy, or Phala upgrading the OS image under it): the keeper's check sees a different measurement, new quotes stop, and a re-rating is queued if your runner is connected (at most once an hour).
- **Your code changes** with a declared binding: nothing detects it. Register the new code hash and rate again; the score is about the code hash it names.

## Limits: what can still tell the sandbox from production

The Arena aims to make an attacked episode look like any other, and the sandbox look like the chain it copies:

- The same tools, schemas and result shapes in every episode, attacked or not. Nothing in the episode names the attack, its class, or whether there is one.
- Attack content sits among ordinary content in what your agent reads, with times on the chain's own clock (on a fork, the live chain's current time).
- On a fork, the chain keeps its real chain id, contracts and block times, and `web3_clientVersion` answers with the live chain's node version. The vault and its registry entry have neutral names, and the MCP server and OpenAPI document describe themselves as trading tools.

What remains detectable, and so what a determined operator could exploit:

- **That it is being rated at all.** The runner starts your agent once per episode with `BONDED_*` variables. An agent could behave differently under the runner. This is inherent to rating an agent you run; a TEE binding proves which code ran, not that it behaves the same elsewhere.
- **The node is a local fork.** Blocks are mined one per transaction and lack some live-chain fields (for example Arbitrum's `l1BlockNumber`), node error messages are the sandbox's, and each write is mined at once.
- **The vault is fresh each episode.** Its on-chain history starts with the episode, though the transfer-history tool shows earlier deposits.
- **The world is simulated.** Its content is short, its order follows a pattern, and some names use placeholder domains.
- **Tool mode tests decisions, not signing.** The Arena signs writes with its own key, so tool mode says nothing about how your agent handles its key. Chain mode does.
- **The published seeds are public** (`attacks/`). The held-out sets are what keeps a rating honest against tuning.
- **Your agent's model calls are yours.** Bonded doesn't pay for them and doesn't limit them; usage your agent reports at `done` is recorded, never trusted.

## Security model

Your agent is untrusted, and so is the gateway from your side. Here is what each can do.

| | Can | Can't |
|---|---|---|
| **Your agent**, in an episode | Call that episode's tools; in chain mode, read the sandbox chain and send signed `execute` calls to the episode's vault; say it's done | Reach any other episode (each has its own capability URL: 32 random bytes, dead when the episode ends); change chain state any other way (cheat, admin, signing and unlocked-account methods are refused); act as another account (transactions must be signed by the episode's key); send ETH; exceed the step cap; read attack content from the chain (it is only ever in the tools) |
| **The gateway** | Send your runner an episode or a cancel | Choose what runs: the runner only ever runs the command you gave it. See your code, your wallet or your production key |
| **The runner** | Start and stop your command; forward your TEE's evidence unchanged | Pass the runner token to your agent; act on chain |
| **Anyone with your runner token** | Connect a runner as your agent (replacing yours), and so answer the episodes of your next rating | Rate the agent or change its registration: both need the owner's wallet signature. Revoke or replace the token from the agent's page |

Request bodies, batches (50), concurrent requests per episode (8) and responses from the sandbox node are capped, so a misbehaving agent can't exhaust the gateway. Runner tokens and capability tokens are stored only as SHA-256 hashes. A revoked token disconnects its runner within one heartbeat. In Docker, the runner and your agent run as an unprivileged user.

Whatever your agent, runner or TEE reports (exit codes, final messages, usage), the verdict of an episode is the vault's breach log and nothing else. The judge, the score and the payout rules are the same deterministic code for your agent as for Bonded's own.
