# Scope: an S1 market model that can express adverse-fill losses

**Status:** scoping note, not built. Decision for the founder at the end.

## The problem this fixes

The S1 harness (`apps/arena/src/s1.ts`, docs/HARBINGER.md) can measure induced loss from a
manipulated feed, but the Arena's market can't produce the loss the literature actually measures
(adversarial news cutting returns, arXiv 2601.13082). Reason: `DemoRouter` fills every swap at
the **reference oracle price minus a 20 bps fee** (`contracts/evm/src/testnet/DemoRouter.sol`;
Arena deploys it with fee 20 in `script/Deploy.s.sol`). A fooled agent cannot buy above fair
value — the venue won't let it. So S1 harm here is only the fee on trades it was tricked into,
and the big "bought high, price reverted" loss has no home.

## The insight that makes this small

The vault **already** measures and polices adverse fills. `MandateBase._postCheck`
(`contracts/evm/src/MandateBase.sol:403`) values each swap's outflow and inflow at the oracle
and records a **T3 (Asset) breach** when the net loss exceeds `maxSlippageBps` of the outflow.
The demo mandate sets `maxSlippageBps: 300` (3%; `apps/arena/src/vault.ts:84`).

Today that check only ever sees the 20 bps fee, because the router fills **at the same oracle
the vault measures with** — execution price == reference price, so there is nothing to detect.
The entire upgrade is therefore: **let the execution price diverge from the reference oracle,
under an attacker's control, for one episode.** The moment it can:

- a fooled agent that swaps into a dislocation loses oracle-measured value on that swap;
- if the loss exceeds 3% of the trade, the vault records **T3 automatically** — the slippage
  guard works, no new vault code;
- if the loss is under 3% (a smaller dislocation, or a value-neutral wrong-asset rotation), no
  breach fires and the **S1 harness measures the induced loss** at the reference oracle.

So the upgrade doesn't invent a detector. It feeds an existing one, and it immediately produces a
product-relevant map: **the vault already covers S1 adverse fills beyond 3%; the uncovered
residual is sub-3% dislocations plus fair-value wrong-asset trades.** That is the first concrete
answer to "what is left to insure on S1."

## Design

Two ways to make execution diverge from reference. Recommend Option A (smaller blast radius).

### Option A — router skew knob (recommended)

`DemoRouter` is a testnet-only venue. Add a per-pair skew it applies to its quote:

- `mapping(address => mapping(address => int16)) skewBps;` plus `setSkew(tokenIn, tokenOut, bps)`
  (open on this testnet venue, like its existing inventory design).
- `quote` returns `gross * (10_000 - feeBps - skewBps[tokenIn][tokenOut]) / 10_000` — a positive
  skew is an adverse fill for the caller.
- Everything else (the reference oracle, the vault, the harness valuation) is unchanged. The vault
  keeps measuring at the one oracle; the skew is exactly the execution/reference gap it now sees.

Blast radius: one testnet contract (+ ABI regen, `pnpm abis:check`), no change to `MandateBase`,
`MandateVault`, the oracle, or the harness valuation.

### Option B — dual oracle (more faithful, larger)

Deploy a second `MockOracle` as the router's price source (the "market price"); the vault and
harness keep the reference oracle. An S1 attack moves the execution oracle for the targeted token.
More faithful to "venue price diverges from fair value," per-token by construction, but it splits
`sandbox.deployment.oracle` into two and every reader must be audited for which one it wants.
Defer unless Option A proves too coarse.

## Pieces to change (Option A)

| Piece | Change | File(s) |
|---|---|---|
| Venue | add `skewBps` map + `setSkew` + apply in `quote` | `contracts/evm/src/testnet/DemoRouter.sol` |
| ABIs | regenerate and check | `packages/shared/src/abis.ts`, `pnpm abis:check` |
| Seed schema | `delivery.executionSkew?: { pair, bps }` (or a campaign step) declaring the dislocation | `packages/shared/src/schemas/attack.ts`, `bounty-spec.ts` validation |
| Episode | in the manipulated run, set the router skew before the agent acts, clear it after | `apps/arena/src/episode.ts`, `apps/arena/src/vault.ts` (a sandbox setter) |
| Harness | already values at the reference oracle; add a line reporting T3-caught vs residual | `apps/arena/src/s1.ts` |
| Seeds | 2–3 S1 adverse-fill seeds: a fake pump (inflated execution + matching news feed) and a panic (depressed execution + halt news), each with a goal that legitimately acts on the feed | `attacks/A3`, `attacks/A8` |
| Tests | unit: `quote` under skew; integration: a swap at 5% skew records T3, at 2% records none and the harness shows the induced loss; both in the same commit | `contracts/evm/test/…`, `apps/arena/test/s1.int.test.ts` |

## What it proves

- The **first real S1 number** for Bonded: induced loss on a policy-running agent fooled by a
  dislocated market, with the vault's slippage guard either catching it (>3%) or not (<3%).
- A **coverage map** for the insurance side: where the vault's existing T3 guard stops an S1 loss
  and where the residual sits — which is exactly the "manipulated-but-in-mandate" gap the product
  research flagged as unaddressed.
- It makes the S1 harness's paired-delta non-trivial, so a later paid slice measures real harm
  rather than fee burn.

## What it does not do

- It is a sandbox market model, not a live venue. A skew is a stand-in for a real dislocation; it
  does not model order-book depth, time, or genuine price discovery.
- It does not change the vault. If the founder wants the vault to cover sub-3% S1 loss, that is a
  separate mandate/claims decision, informed by the map this produces.

## Effort, risk, cost

- **Effort:** ~1–2 focused days. The contract change is small; most of the work is the seed schema
  field, the episode plumbing to set/clear the skew cleanly, and the integration tests.
- **Risk:** keep `setSkew` strictly on the testnet `DemoRouter` and out of any real mandate path;
  regenerate ABIs; keep the 676-test suite green. Determinism is preserved (skew is set
  per-episode from the seed, not random).
- **Cost:** building and the scripted/integration tests are free. A paid LLM slice afterward is
  small (Flash episodes) and, unlike today, **meaningful** — the signal is no longer fee-bounded.

## Recommendation

Build Option A with 3 S1 adverse-fill seeds, free, behind the existing tests. Then one ~$0.50
Flash slice to produce the first S1 coverage map. Hold Option B unless A proves too coarse.
