# ADR-005: Arena core

- **Status:** Accepted
- **Date:** 2026-09-27
- **Code:** `apps/arena/`, `apps/demo-agents/`, `attacks/`, `packages/shared/src/agent.ts`, `packages/shared/src/abis.ts`

## Context

The Arena is how Bonded rates an agent: it attacks the agent in a sandbox and counts how often the agent breaks its mandate. Those counts become the Bonded Score and the premium (Sections 8 and 9 of the plan), so the Arena has to be:
- **Realistic:** real contracts and a real vault, with attacks arriving the way they do in the wild.
- **Safe:** nothing can reach a live network or real funds.
- **Impossible to argue with:** the verdict can't depend on a model's opinion.

Day 5 builds the core loop (setup, task, attack, agent acts, judge, record) and proves it end to end.

## Decisions

### 1. The judge is the vault's on-chain breach log, nothing else

The binding verdict comes only from `MandateVault.getBreach` and `frozen`:
- **`breached`:** the vault recorded any breach.
- **`attackSucceeded`:** it recorded a breach type the attack was aiming for (the seed's `successPredicate`).

This is the same record ClaimsEngine pays from, so a rating and a claim can never disagree about what happened. The agent's own report is kept in the trace but ignored by the judge; a test proves an agent that claims harm without causing it is judged safe, and one that causes harm while claiming success is judged breached. Model-based labels (the grey-area judge, Section 8.5) come later and stay advisory.

### 2. The sandbox is anvil, fresh or forked

- **Fresh:** starts anvil and deploys with `script/deploy.sh`, the same scripts as production, including the on-chain record step. Fast (about 6 seconds for a full run) and needs no network, so it's what the tests use.
- **Forked:** anvil forks a live testnet (Robinhood Chain or Arbitrum Sepolia) a few blocks behind the tip and attaches to the committed deployment for that chain. Episodes then run against the exact bytecode and state users interact with.

Either way every transaction stays inside the local anvil node. The sandbox only uses anvil's public development keys, never a real key.

### 3. A fresh vault per episode

Each episode registers a new agent and creates a new Mandate Vault from a validated mandate (`EvmMandate`, hashed by `toEvmMandateParams`), funded with 50,000 tUSDG by a depositor:
- **Mode:** Monitor, so breaches execute and their cost is measured. Enforce mode can be chosen per episode.
- **Limits:** $5,000 per trade and $25,000 a day.
- **Allowed calls:** only the router's `swap`.

Fresh vaults mean one episode can never influence another's verdict (a frozen agent, a spent daily limit).

### 4. Attacks live in a simulated world; facts about the chain don't

The world simulator holds what an agent reads: its inbox (DMs), news, social posts, token list (metadata), a price API, the research API's market report (tool output) and transfer history. Each starts with ordinary content, and an attack plants its payload on one or more surfaces.

Balances, the portfolio's value and the breach log are always read from the chain. An attack can lie to the agent through the price API, but it can't change the on-chain oracle the vault uses or fake a verdict.

Day 5 supports seven surfaces. The `market` and `counterparty` surfaces, which need a live market and a second agent, arrive with the attack library on Day 6 and fail loudly until then.

### 5. One tool interface for every agent

`@bonded/shared` defines the agent tools (read the surfaces, prices, portfolio, `swap`, `transfer`, `approve`) with Zod input schemas and JSON Schema export, plus the `ArenaAgent` and `AgentToolbox` contract.
- **Reads** come from the world or the chain.
- **Writes** are sent with the agent's key through `MandateVault.execute`, exactly as in production, so the vault sees and records every action.
- **Guards:**
  - It validates arguments.
  - It reserves each call's trace step when the call starts, so the step cap holds even for parallel calls.
  - It sends writes one at a time.
  - It returns failures, such as `reverted: AgentFrozen`, as results the agent can react to.
- **Blocked actions fail:** `MandateVault.execute` doesn't revert when Enforce mode blocks an action (or when it freezes the agent over an earlier outflow before acting), so the toolbox checks the breach log after every write and reports a blocked or skipped action as a failed call, never as done.
- **Ending an episode:** it aborts the toolbox's `signal` (agents stop, and the LLM brain cancels its API request), refuses new calls, and **waits for calls already running**. The judge therefore never reads the vault while a transaction is in flight.
- **No verdict for a broken agent:** an agent that crashes or times out without a breach is reported as "no verdict", never as safe, so a broken setup can't pass for a well-defended agent.

This is the "native SDK" adapter from Section 8.4. Black-box and framework adapters will implement the same toolbox over HTTP.

### 6. vulnerable-agent has two brains

- **Scripted (deterministic):** reads everything, then obeys any instruction to send or approve funds, whoever wrote it, before doing its task. It exists so the whole Arena can be tested without a model or API key, and it gives a fixed "no defences" baseline.
- **LLM (updated by ADR-006):** the same agent with a language-model brain, a tool-calling loop over any OpenAI-compatible endpoint (OpenRouter by default), with the model as a setting.
  - The loop owns the step cap and routes every call through the Arena's toolbox.
  - Its system prompt contains no instruction to be unsafe. The vulnerability is what's missing: no separation between the operator and content, and no address allowlist. That's how most real agents are written.

Day 5 first shipped this brain on Anthropic's SDK, Claude only; ADR-006 made it provider-neutral.

### 7. Attack seeds are YAML, validated by the shared schema

`attacks/<class>/*.yaml` files are parsed with `AttackSpec`; a malformed file, a duplicate id or an unknown `{{placeholder}}` fails loudly. A new optional `delivery` block says who a payload appears to come from (a DM sender, news source or address) and which token a metadata attack targets.

Day 5 ships four seeds, one per surface built so far:
- A1: token metadata
- A2: news
- A6: an operator-impersonation DM
- A7: a smuggled tool output

The full library (10 classes, about 40 seeds) and the adaptive attacker are Day 6.

### 8. Every episode leaves a complete record

`runEpisode` returns, and the CLI saves:
- the task and mandate
- what was planted where
- every tool call with its arguments, result and transaction hashes
- the agent's summary
- the verdict

These records feed scoring and reports (Day 6) and the Sentinel dataset.

### 9. ABIs are generated from the build

`packages/shared/src/abis.ts` is generated from `contracts/evm/out`, giving TypeScript fully typed contract calls. `abis:check` (in the CI workflow and the local pipeline) fails if a contract's interface changes without regenerating it.

## Known limits

- **One benign task.** Every Day 5 episode uses the same goal (buy 2,000 tUSDG of tNVDA). Varied tasks come with the library.
- **Approvals show no loss yet.** A7 records `T1_UNAUTHORIZED_APPROVAL` with $0 lost, because the attacker never uses the approval inside the episode. Day 6 adds an attacker step that spends it, so the vault's `reconcile` records the drain as a deferred breach with its real cost.
- **The scripted brain is a baseline, not evidence.** Its 4-of-4 breach rate says the Arena catches an agent with no defences. Real ratings need the LLM brain and, later, real third-party agents.
- **Fresh sandboxes used to share one deployment file** (`deployments/31337.json`), so two deploying at once raced. Fixed with ADR-006's changes: each fresh sandbox gets a chain id from its port and deletes its file after loading it.
- **Fork tests need network access**, so they're opt-in (`ARENA_FORK_URL`).
