# @bonded/sdk

Trade through a Bonded Mandate Vault from any TypeScript agent, wherever it runs.

The vault holds the agent's funds. The agent's key can only act through `MandateVault.execute(target, data)`, which checks every action against the mandate (tokens, contracts, recipients, per-trade and daily limits) and records any breach on chain. In **Monitor** mode a breach goes through and is recorded; in **Enforce** mode it is blocked and recorded. That breach log decides ratings and pays claims. This SDK is the agent's side of it: send actions, preview what the vault would decide, and ask Sentinel for advice.

```bash
npm install @bonded/sdk viem
```

ESM only, Node 20 or later. Not yet published to npm; inside this repository use `"@bonded/sdk": "workspace:*"`.

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

## Running under the Bonded runner

```ts
import { fromBondedEnv } from "@bonded/sdk";

const episode = fromBondedEnv(); // { episodeId, task, mode, endpoints, vault, chainId, contracts, sessionKey?, deadlineMs }
```

When the Bonded runner starts your agent for an Arena episode, it sets `BONDED_*` variables: the task, the mode, the episode's tool endpoints (MCP and HTTP), and in chain mode a fork RPC and a session key for the episode vault. `fromBondedEnv` reads and checks them, naming every missing or malformed one. In chain mode, build a `BondedVault` from `episode.vault`, `episode.endpoints.rpc` and `episode.sessionKey`; the fork only accepts `execute` calls to the episode vault signed by that key. The example agent runs both modes.

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

Actions `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE` through the vault, and a `BONDED_VAULT` provider that tells the agent the vault's mode, whether it is frozen and its breach count. Parameters come from `options.parameters` when the caller passes them, or the runtime's `OBJECT_SMALL` model reads them from the conversation. Amounts are whole tokens; tokens can be named by symbol. Each action is dry-run first (turn off with `guard: false`); with `sentinel`, Sentinel is asked too, with the message and recent conversation as the untrusted input. Built against `@elizaos/core` 1.7.

## Development

```bash
pnpm --filter @bonded/sdk test
```

Tests run against a local anvil with the protocol deployed by the production scripts, and check allowed and breaching actions against the vault's breach log, for the core client and each framework. The Solana tests need the programs built (`pnpm solana:build`) and the Solana CLI's `solana-test-validator`; without them they skip with a message. `pnpm --filter @bonded/sdk typecheck` also checks the ElizaOS plugin against `@elizaos/core`'s own types.

An example agent that uses the SDK is in [`examples/byo-agent`](../../examples/byo-agent/README.md).
