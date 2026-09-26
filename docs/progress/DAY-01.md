# Day 1: Sun Sep 27, 2026

Plan reference: docs/PLAN.md Section 20, Day 1.

## Done

- **Monorepo:** pnpm workspaces, Turborepo, TypeScript 6 (strict), ESLint, Prettier, EditorConfig, Node 22. See `docs/decisions/001-stack.md`.
- **CI:** `.github/workflows/ci.yml` runs on every PR and on pushes to `main`:
  - TypeScript job: format check, typecheck, lint, tests.
  - Contracts job: `forge fmt --check`, `forge build --sizes`, `forge test`.
- **`@bonded/shared`:**
  - `Mandate` (EVM and Solana variants), with `mandateHash` (canonical JSON + keccak256) and `toEvmMandateParams` (whole-dollar limits → 6-decimal on-chain values).
  - `AttackSpec`, the ten attack classes, attack surfaces and breach-type codes.
  - `Attestation` and `Quote`, model-family codes, EIP-712 types and signing helpers.
  - Score tiers and underwriting rules (Section 9.3).
  - Chain configs with a source recorded for every fact.
  - 35 tests.
- **Contracts:** Foundry project with forge-std 1.16.2 and OpenZeppelin 5.7.0 (pinned submodules). `BondedTypes.sol` holds the shared enums, structs and EIP-712 typehashes. 4 tests pin the encoding to the TypeScript side.

## Chain facts found

| Chain | Chain ID | Status |
|---|---|---|
| Robinhood Chain testnet | 46630 | RPC `https://rpc.testnet.chain.robinhood.com/rpc`, explorer and faucet confirmed from docs. Settles to Sepolia. The faucet drips test Stock Tokens (TSLA, AMZN, PLTR, NFLX, AMD). Uniswap, Morpho and Chainlink were live at testnet launch. The stablecoin is **Paxos USDG**, not USDC; its address still needs confirming |
| Robinhood Chain mainnet | 4663 | RPC and explorer from docs. Chainlink feeds exist for Stock Tokens |
| Arbitrum Sepolia | 421614 | Circle USDC address recorded; needs an on-chain check |
| Ethereum Sepolia | 11155111 | Canonical ERC-8004 identity and reputation registries confirmed from docs; Circle USDC recorded, needs an on-chain check |
| Solana devnet | n/a | Circle USDC mint recorded; needs an on-chain check |

Everything marked "unverified" in `packages/shared/src/chains.ts` gets checked on-chain on Day 4.

## Blockers

- **Network access from the build environment.** All testnet RPCs, docs.robinhood.com and Hugging Face are blocked by the environment's network policy. Deployments (Day 4) need the RPC hosts allowlisted. See docs/PLAN.md Section 24, item 3.
- **Anthropic API key** is still needed before Day 5 (Section 24, item 2).

## Next (Day 2)

`MandateVault` + factory + oracle adapters: action classification (T1–T3), `reconcile`, freeze and rotate, ERC-4626 NAV, with Forge tests for every breach type in both modes.

## Review asks

- Check the mandate fields in `packages/shared/src/schemas/mandate.ts`. They define what operators can restrict.
- Check the tier rules in `packages/shared/src/tiers.ts` against docs/PLAN.md Section 9.3.
