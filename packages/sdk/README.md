# @bonded/sdk

Trade through a Bonded Mandate Vault from any TypeScript agent, wherever it runs, and get it rated
by the Bonded Arena without changing how it works.

The vault holds the agent's funds. The agent's key can only act through `MandateVault.execute(target, data)`, which checks every action against the mandate (tokens, contracts, recipients, per-trade and daily limits) and records any breach on chain. In **Monitor** mode a breach goes through and is recorded; in **Enforce** mode it is blocked and recorded. That breach log decides ratings and pays claims. This SDK is the agent's side of it: send actions, preview what the vault would decide, and ask Sentinel for advice.

```bash
npm install @bonded/sdk viem
```

ESM only, Node 22 or later. Not yet published to npm (the founder publishes with
`pnpm release:packages`); inside this repository use `"@bonded/sdk": "workspace:*"`.

| Entry point | What it is | Peer dependency |
|---|---|---|
| `@bonded/sdk` | The vault client, dry runs, the guard, Sentinel, mandates, `fromBondedEnv` | |
| `@bonded/sdk/mcp` | An episode's tools over MCP, `/done`, MCP config | |
| `@bonded/sdk/agent-url` | The Agent URL handler | |
| `@bonded/sdk/langchain` | The episode's tools as LangChain `StructuredTool`s | `@langchain/core` 1 |
| `@bonded/sdk/ai-sdk` | The episode's tools as a Vercel AI SDK tool set | `ai` 5 to 7 |
| `@bonded/sdk/eliza` | The ElizaOS plugin, with a rating mode | `@elizaos/core` 1.7 |
| `@bonded/sdk/agentkit` | AgentKit wallet provider for the vault; the episode's tools as actions | `@coinbase/agentkit` 0.10 |
| `@bonded/sdk/solana-agent-kit` | Solana Agent Kit plugin for the Solana vault | `solana-agent-kit` 2, `@bonded/solana` |

## The vault

```ts
import { BondedVault } from "@bonded/sdk";
import { privateKeyToAccount } from "viem/accounts";

const vault = new BondedVault({
  vault: "0xYourVault",
  chain, // a viem Chain; or pass publicClient
  account: privateKeyToAccount(agentKey), // the vault's agent key; or pass walletClient
  router: "0xRouter", // the swap venue your mandate allows (for swap)
});

await vault.swap({ tokenIn: usdg, tokenOut: tsla, amountIn: 1_000_000_000n });
await vault.transfer({ token: usdg, to: depositor, amount: 250_000_000n });
await vault.approve({ token: usdg, spender: router, amount: 0n });
await vault.call({ target, data }); // anything else the mandate allows

const status = await vault.status(); // { frozen, mode, breachCount, agent, guardian, mandateHash, agentId, freezeOnBreach }
const log = await vault.breaches(); // the vault's breach log, oldest first
```

Amounts are in the token's base units (`bigint`). Each write waits for its transaction and returns `{ hashes, breaches }`. A swap approves the router for exactly `amountIn` first when the vault's allowance is short, so it can take two transactions. `swap` speaks the interface of Bonded's testnet market (`DemoRouter`); for any other venue pass a `SwapRouter` (`{ address, encodeSwap, quote? }`) as `router`, or encode the call yourself and use `call`.

### Mandate modules on smart accounts

The same client works for a `MandateModule`: the mandate on an ERC-7579 smart account the operator already uses (Safe through Safe7579, or any ERC-7579 account). Pass the module's address as `vault`. The SDK tells the two apart on chain (`identify()`; `status()` reports `kind` and `holder`, where the funds are: the vault itself or the module's account), and swaps approve and pay out to the account. Build the mandate with `buildMandate(rules, { for: "module" })`: a module's on-chain hash is the commitment to its params, which `MandateModuleFactory.createModule` checks. When the account's call fails, Safe7579 reverts with `ExecutionFailed()` and no reason; that comes back as `CallRevertedError`. A module not installed on its account gives code `MODULE_NOT_INSTALLED`. For AgentKit, use `await BondedWalletProvider.create(...)` so the wallet's address is the account.

To put a module on an account, `installMandateModule(publicClient, { moduleFactory, account, accountType, rules, agent, guardian })` prepares the one transaction the account's owner sends: `createModule`, then `installModule` as executor and as hook. It returns the module's predicted address, the params with their commitment, the mandate JSON to keep, and the calls both as a list (for a Safe MultiSend) and as an ERC-7579 batch (`execute.data`, e.g. for a user operation). Nothing is sent by the SDK.

Without `account` or `walletClient` the vault is read-only: `status`, `breaches` and `dryRun` work, writes throw.

### Dry runs

```ts
const check = await vault.dryRun({ type: "transfer", token: usdg, to: someone, amount });
// { ok, executed, blocked, breach?, breaches, wouldFreeze }
if (!check.ok) console.log(check.breach?.type, check.breach?.reason);
```

`dryRun` simulates `execute` from the agent key against the chain's current state (`eth_simulateV1`) and reads the vault's own `BreachRecorded`, `Executed` and `Frozen` events. The verdict is the contract's own, not a copy of its rules in TypeScript, so it can't drift from what the vault does. Nothing is sent. It needs an RPC that supports `eth_simulateV1` (anvil and Robinhood Chain's public RPC do); otherwise it throws `BondedError` with code `DRY_RUN_UNSUPPORTED`.

### Errors

Every error the SDK throws on purpose is a `BondedError` with a stable `code`:

| Error | When |
|---|---|
| `BlockedByMandateError` (`BLOCKED_BY_MANDATE`) | Enforce mode stopped the action. The attempt is in the breach log (`error.breach`); nothing moved |
| `VaultFrozenError` (`VAULT_FROZEN`) | The vault is frozen, or this action found an earlier unexplained outflow and froze it first (`error.breach`) |
| `NotAgentError` (`NOT_AGENT`) | The key isn't the vault's agent key |
| `CallRevertedError` (`CALL_REVERTED`) | The call itself failed (e.g. not enough balance). Nothing changed |
| `PredictedBreachError` (`PREDICTED_BREACH`) | A guarded vault refused: the dry run predicts a breach (`error.dryRun`) |
| `SentinelRefusedError` (`SENTINEL_REFUSED`) | A guarded vault refused on Sentinel's advice (`error.verdict`) |
| `SentinelError` (`SENTINEL_ERROR`) | The Sentinel API refused the request or didn't answer (`error.status`) |

In Monitor mode a breaching action is **not** an error: it runs, and its breaches come back in the result. Check `result.breaches`, or use `guarded`.

## The guard

```ts
import { guarded } from "@bonded/sdk";

const safe = guarded(vault, {
  sentinel: { apiUrl: "https://your-bonded-api", mandate, tokens }, // optional
});
await safe.swap(params, { untrustedInputs: [{ tool: "read_inbox", output: email }] });
```

Before each write the guard runs the dry run and refuses a predicted breach; then, if configured, it asks Sentinel and refuses if Sentinel advises against. That turns a Monitor-mode vault into one that doesn't knowingly breach. It is a client-side check: the chain can change between the dry run and the transaction, and the vault's own verdict is what counts. When Sentinel is down or busy the guard refuses by default; set `onUnavailable: "proceed"` to go ahead without its advice. `safe.check(action)` runs the checks without sending.

## Sentinel

```ts
import { checkWithSentinel } from "@bonded/sdk";

const verdict = await checkWithSentinel({
  apiUrl, chainId, agentId, vault: vault.address,
  mandate: "You manage a vault holding tUSDG, tTSLA. ...",
  proposedAction: { tool: "swap", args: { tokenIn: "tUSDG", tokenOut: "tTSLA", amountIn: "250" } },
  untrustedInputs: [{ tool: "read_news", output: article }],
  account, // the vault's agent key: the API only answers checks it signed
});
// { blocked, manipulated, injection, blockThreshold, model, latencyMs, advice }
```

Signs the check (EIP-191, the message from `@bonded/shared`) and calls `POST /sentinel/check`. Sentinel is advisory: the vault's breach log, not Sentinel, decides claims and ratings. A signed check is accepted for 120 seconds; the API takes at most 20 inputs of 4,000 characters (longer ones are cut, as Sentinel reads them).

## Mandates

```ts
import { buildMandate, describeMandate } from "@bonded/sdk";

const { mandate, mandateHash, params } = buildMandate({
  chainId: 46630, agentId: 12n, mode: "enforce",
  baseAsset: usdg, assets: [tsla, nvda],
  targets: [{ address: router, functions: ["swap(address,address,uint256,address)"] }],
  destinations: [depositor],
  maxTradeUsd: 5_000, maxDailyUsd: 25_000, maxDrawdownPct: 15, maxSlippagePct: 3,
  description: "Rebalance a tech basket against tUSDG.",
});
// params goes to MandateVaultFactory.createVault; keep `mandate`, the API checks it against the hash.
const text = describeMandate(mandate, tokens); // for Sentinel checks
```

The same builder the web app's onboarding uses, so both hash the same rules the same way. Cover requires `freezeOnBreach`, which is the default.

## Getting rated by the Arena

The Bonded Arena rates an agent by running it through episodes: each one gives the agent a task and
a set of tools (market data, messages, trading) in a sandbox, plants attacks in what the tools
return, and judges the agent only by what its episode vault records. Your agent runs where it
always runs and keeps its own model and prompts; while it is being rated it uses the episode's
tools instead of its production ones. There are two ways to connect:

- **The runner** (`@bonded/runner`): it connects out to Bonded and starts your agent command once
  per episode, with the episode in `BONDED_*` environment variables.
- **Agent URL**: no install. You serve one HTTPS endpoint and Bonded calls it once per episode
  (see [Agent URL](#agent-url) below).

Either way the agent gets the same `BondedEpisode`: the task, the mode, and the episode's
endpoints (MCP, plain HTTP, `/done`, and in chain mode a fork RPC). Every endpoint URL carries the
episode's capability and stops working when the episode ends, so nothing about one episode can be
reused in the next.

### The episode

```ts
import { fromBondedEnv, isBondedEpisode } from "@bonded/sdk";

if (isBondedEpisode()) {
  const episode = fromBondedEnv(); // { episodeId, task, mode, endpoints, vault, chainId, contracts, sessionKey?, deadlineMs }
}
```

`isBondedEpisode()` is true when the runner set valid `BONDED_*` variables. `fromBondedEnv` reads
and checks them, naming every missing or malformed one (`BondedError`, code `EPISODE_ENV`).

The mode decides how the agent acts:

- **tools**: reads and writes are tool calls; `swap`, `transfer` and `approve` are tools, and the
  Arena sends each write through the episode vault.
- **chain**: reads are tool calls (that is where attacks are planted), and writes are
  transactions the agent signs itself, as in production. `episodeVault(episode)` is a
  `BondedVault` for the episode vault, signing with `episode.sessionKey` through the episode's
  fork RPC; it throws in tools mode, or when the agent's key is in a TEE (no session key).

When the agent is finished it says so, with its own model usage if it can (Bonded uses it to
estimate what a full rating will cost you; it is recorded, never trusted for limits):

```ts
import { finishEpisode } from "@bonded/sdk/mcp";

await finishEpisode(episode, {
  finalMessage: "Bought 2,000 tUSDG of tNVDA",
  usage: { inputTokens: 12_400, outputTokens: 900, costUsd: 0.04 },
});
```

Under the runner, exiting also ends the episode; so does its deadline.

### The episode's tools over MCP

```ts
import { connectEpisodeTools } from "@bonded/sdk/mcp";

const episode = await connectEpisodeTools(); // from BONDED_*; or pass the episode you were given
episode.tools; // [{ name, description, inputSchema, call(args) }]
const prices = await episode.callTool("get_prices"); // { ok: true, output, text } | { ok: false, error, text }
await episode.done({ finalMessage: "done" });
```

```ts
connectEpisodeTools(
  episode?: EpisodeToolsSource, // default fromBondedEnv()
  options?: { signal?: AbortSignal; fetch?: typeof fetch; clientName?: string },
): Promise<EpisodeTools>;

interface EpisodeTools {
  client: Client; // the official MCP SDK client
  tools: EpisodeTool[]; // listed once at connect
  listTools(): ReturnType<Client["listTools"]>; // MCP tools/list as the server answers
  callTool(name: string, args?: Record<string, unknown>): Promise<EpisodeToolResult>;
  done(body?: DoneRequest): Promise<void>; // POST {done}
  close(): Promise<void>;
}
```

A failed call is returned, not thrown (`ok: false`), so the agent's model can read the error and
react, as it would to a production tool's. `text` is what a model should read.

### Framework helpers

One call gives the episode's tools in your framework's own shape, so the agent's code stays the
same and only the tool list changes while it is being rated. Each helper takes an
`EpisodeTools` connection or an episode, and with no argument reads `BONDED_*`. Each framework is
an optional peer dependency: install the one you use.

**LangChain and LangGraph** (`@langchain/core` 1):

```ts
import { bondedLangChainTools } from "@bonded/sdk/langchain";
import { isBondedEpisode } from "@bonded/sdk";

const tools = isBondedEpisode() ? await bondedLangChainTools() : productionTools;
const agent = createReactAgent({ llm, tools }); // or model.bindTools(tools), ToolNode(tools)
```

`StructuredTool`s with each tool's own JSON Schema. They return the Arena's output as text, and
`Error: ...` for a failed call.

**Vercel AI SDK** (`ai` 5 or later; tested with 7):

```ts
import { bondedAiSdkTools } from "@bonded/sdk/ai-sdk";

const tools = isBondedEpisode() ? await bondedAiSdkTools() : productionTools;
const { text, totalUsage } = await generateText({ model, tools, stopWhen: stepCountIs(10), prompt });
```

A tool set of `tool({ inputSchema: jsonSchema(...), execute })`; `execute` returns the Arena's
output, or `{ error }` for a failed call.

**ElizaOS** (`@elizaos/core` 1.7): `bondedPlugin` has a rating mode, on by default
(`rating: "auto"`). When the runtime registers the plugin while an episode is running, it swaps
the vault actions for the episode's tools. For an agent that doesn't use the vault plugin in
production, add `bondedEpisodePlugin()` while it is being rated:

```ts
import { bondedEpisodePlugin, bondedPlugin } from "@bonded/sdk/eliza";

plugins: [isBondedEpisode() ? bondedEpisodePlugin() : myTradingPlugin];
```

Each tool becomes an action named after it in capitals (`get_prices` is `GET_PRICES`); its
parameters come from `options.parameters`, or the runtime's `OBJECT_SMALL` model reads them from
the conversation against the tool's JSON Schema. The `BONDED_TASK` provider gives the agent the
episode's task and mandate. In chain mode only the reads are tools, and the plugin adds
`BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE` on `episodeVault(episode)`. The actions are
filled in by the plugin's `init`, which the runtime calls before it reads them.

**Coinbase AgentKit** (`@coinbase/agentkit` 0.10):

```ts
import { bondedEpisodeActionProvider } from "@bonded/sdk/agentkit";

const kit = await AgentKit.from({
  walletProvider,
  actionProviders: isBondedEpisode() ? [await bondedEpisodeActionProvider()] : productionProviders,
});
// then getLangChainTools(kit) / getVercelAITools(kit) as usual
```

Actions are named `BondedEpisodeActionProvider_<tool>` and typed with a zod 3 schema built from
the tool's JSON Schema (what AgentKit's framework extensions expect). In chain mode, writes are
transactions: use a `BondedWalletProvider` for `episode.vault` with the session key and
`episode.endpoints.rpc`.

Every helper is tested end to end against a real Arena Gateway with a scripted model:
[`examples/frameworks`](../../examples/frameworks/README.md).

### MCP config for MCP-aware agents

Agents that read an `mcpServers` config (Claude Desktop, Claude Code, Cursor and most agent
frameworks) can point at the episode's MCP endpoint without any Bonded code:

```ts
import { mcpConfig } from "@bonded/sdk/mcp";

mcpConfig(episode); // { mcpServers: { "bonded-episode": { type: "http", url: "<episode MCP URL>" } } }
mcpConfig(episode, { style: "url" }); // { url } only, for clients that infer the transport
mcpConfig(episode, { style: "stdio" }); // { command: "npx", args: ["-y", "mcp-remote@0.14.3", url] }, for stdio-only clients
```

The URL is per episode: it stops working when the episode ends. Write the config at the start of
every episode, for example in the runner's agent command, with the `bonded-mcp-config` command this
package installs:

```sh
bonded-runner --gateway ... -- sh -c 'bonded-mcp-config > .mcp.json && my-agent --mcp-config .mcp.json'
```

`bonded-mcp-config [--style http|url|stdio] [--name <name>]` reads `BONDED_*` and exits 1 outside
an episode. `mcpConfigJson(episode, options)` returns the same text.

### Agent URL

In Agent URL mode Bonded `POST`s each episode to your HTTPS endpoint, signed with your agent
secret (`bonded_as_...`, shown once when you register the URL). `createBondedHandler` is the whole
endpoint: a standard Fetch API handler for Hono, Next.js route handlers, Bun, Deno and Cloudflare
Workers, with a Node adapter for Express and `node:http`.

```ts
import { createBondedHandler, toNodeHandler } from "@bonded/sdk/agent-url";
import { bondedAiSdkTools } from "@bonded/sdk/ai-sdk";

const handler = createBondedHandler({
  secret: process.env.BONDED_AGENT_SECRET!,
  version: process.env.GIT_SHA, // reported when Bonded verifies the URL; becomes the code hash
  async onEpisode(episode, { signal }) {
    const tools = await bondedAiSdkTools(episode);
    const result = await generateText({ model, tools, prompt: episode.task.goal, abortSignal: signal });
    return {
      finalMessage: result.text,
      usage: { inputTokens: result.totalUsage.inputTokens ?? 0, outputTokens: result.totalUsage.outputTokens ?? 0 },
    };
  },
});

export const POST = handler; // Next.js route handler
app.post("/bonded", (c) => handler(c.req.raw)); // Hono
export default { fetch: (req, env, ctx) => handler(req, ctx) }; // Cloudflare: keeps the work alive with ctx.waitUntil
expressApp.post("/bonded", toNodeHandler(handler)); // Express: mount before express.json()
```

What the handler does with each request:

1. **Checks the signature** before reading the message: `bonded-timestamp` (unix seconds) must be
   within 300 seconds of the server's clock, and `bonded-signature`
   (`v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`) must match, compared in constant time.
   A request it has accepted before (same timestamp and signature) is refused as a replay.
   Failures answer `401`; nothing runs.
2. `{ type: "verify", challenge }`: answers `200 { challenge, version }`.
3. `{ type: "episode", ... }`: answers `202` at once (Bonded waits at most 10 seconds) and runs
   `onEpisode` in the background. When it resolves, the handler posts `/done` with the
   `finalMessage` and `usage` it returned. If it throws, `/done` is still posted, saying the agent
   failed, and `onError` is called.
4. `{ type: "cancel", episodeId }`: aborts that episode's `signal`, and no `/done` is posted. The
   signal is also aborted when the episode's deadline passes.

Limits: 1 MiB bodies (`maxBodyBytes`), 8 episodes at once (`maxConcurrent`; Bonded sends one at a
time per agent), and the same episode delivered twice runs once. On platforms that stop work when
the response is sent, pass their `waitUntil` (as the option, or the handler's second argument).
`signBondedRequest(secret, body)` signs a request the way Bonded does, for testing your endpoint;
`verifyBondedSignature(...)` is the check on its own. A Python endpoint with no dependencies is in
[`examples/python-agent-url`](../../examples/python-agent-url/README.md).

## Coinbase AgentKit

```ts
import { AgentKit, ViemWalletProvider, erc20ActionProvider } from "@coinbase/agentkit";
import { BondedWalletProvider } from "@bonded/sdk/agentkit";

const walletProvider = new BondedWalletProvider({
  wallet: new ViemWalletProvider(agentKeyWalletClient), // signs and pays gas
  vault: "0xYourVault", // holds the funds
  guard: true, // optional: dry-run every transaction first
});
const kit = await AgentKit.from({ walletProvider, actionProviders: [erc20ActionProvider()] });
```

Every `sendTransaction` becomes `vault.execute(to, data)` from the agent key and `getAddress()` is the vault, so AgentKit's action providers trade through the mandate unchanged. Refused: native value (the vault is ERC-20 only), contract creation, and `sign`, `signTypedData` and `signTransaction` (a raw signature from the agent key would act outside the vault; permits and x402 payments don't work). `signMessage` signs with the agent key, not as the vault. In Enforce mode a blocked call still mines, so `waitForTransactionReceipt` throws `BlockedByMandateError` and the action reports a failure. AgentKit itself sends usage analytics to Coinbase from every wallet provider. Peer dependency: `@coinbase/agentkit` 0.10.

## Solana Agent Kit

```ts
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";
import { bondedVaultPlugin } from "@bonded/sdk/solana-agent-kit";

const agent = new SolanaAgentKit(new KeypairWallet(agentKey, rpcUrl), rpcUrl, {})
  .use(bondedVaultPlugin({ vault: vaultAddress, guard: true, swap: jupiterSwapBuilder }));
```

Actions `BONDED_VAULT_TRANSFER`, `BONDED_VAULT_STATUS`, and `BONDED_VAULT_SWAP` when you pass a `swap` builder; methods `bondedVaultTransfer`, `bondedVaultSwap`, `bondedVaultExecute`, `bondedVaultStatus`. Each goes through the `bonded_vault` program's `execute`, signed by the kit's wallet, which must be the vault's agent key. `SolanaBondedVault` does the same without the kit, with a `dryRun` that simulates `execute` and reads the vault's own events. Needs `@bonded/solana`, `@solana/web3.js` and `solana-agent-kit` 2.

What the Solana program checks, and so what works:

- The called program must be on the vault's allowlist.
- SPL transfers must go to a token account the vault owns. There is no destination list on Solana, so any transfer out of the vault is a breach.
- Approvals, `SetAuthority` and closing accounts are never allowed.
- The net base-asset outflow of one call must stay within the vault's limit. There is no price (T3) check and no 24h limit on Solana yet.
- One instruction per `execute`, run by CPI with the vault as signer. CPI depth and the compute budget limit which swaps fit; a Jupiter multi-hop route may not. The swap builder (e.g. from Jupiter's swap-instructions API) is yours to supply; the SDK has no DEX client of its own.

## ElizaOS

```ts
import { bondedPlugin } from "@bonded/sdk/eliza";

const plugin = bondedPlugin({ vault, tokens, sentinel: { apiUrl, mandate, tokens } });
// character.plugins / project agent plugins: [plugin]
```

Actions `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE` through the vault, and a `BONDED_VAULT` provider that tells the agent the vault's mode, whether it is frozen and its breach count. Parameters come from `options.parameters` when the caller passes them, or the runtime's `OBJECT_SMALL` model reads them from the conversation. Amounts are whole tokens; tokens can be named by symbol. Each action is dry-run first (turn off with `guard: false`); with `sentinel`, Sentinel is asked too, with the message and recent conversation as the untrusted input. Built against `@elizaos/core` 1.7. While a Bonded episode is running the plugin switches to the
episode's tools: see [Framework helpers](#framework-helpers).

## Development

```bash
pnpm --filter @bonded/sdk test
```

Tests run against a local anvil with the protocol deployed by the production scripts, and check allowed and breaching actions against the vault's breach log, for the core client and each framework. The Agent URL handler's tests (signatures, verify, acknowledging then working, cancel, deadline) run without a chain. The framework helpers are tested end to end against a real Arena Gateway in `examples/frameworks` (`pnpm --filter @bonded/example-frameworks test`). The Solana tests need the programs built (`pnpm solana:build`) and the Solana CLI's `solana-test-validator`; without them they skip with a message. `pnpm --filter @bonded/sdk typecheck` also checks the ElizaOS plugin against `@elizaos/core`'s own types.

An example agent that uses the SDK is in [`examples/byo-agent`](../../examples/byo-agent/README.md).
