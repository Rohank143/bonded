# ADR-001: Tech stack and repo layout

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Bonded spans EVM contracts, Solana programs, an AI red-team service, an API, a keeper, a web app and a Python model service. Two builders (one human, one AI) have 16 days. We need one repo where shared definitions (mandates, attack specs, signed messages) can't drift between languages.

## Decision

| Area | Choice | Why |
|---|---|---|
| Repo | pnpm workspaces + Turborepo monorepo | One PR can change a schema and every consumer; cached builds and tests |
| Runtime | Node 22, TypeScript 6.0 (strict) | TypeScript 7 is out, but typescript-eslint supports only up to 6.0 today |
| Schemas | Zod 4 in `@bondedhq/shared` | Runtime validation plus inferred types from one definition |
| EVM | Solidity 0.8.28, Foundry, OpenZeppelin 5.7 (git submodules, pinned tags) | Fast tests, fuzzing, standard tooling; pinned tags keep builds reproducible |
| EVM client | viem | Typed EIP-712 signing and contract calls |
| Tests | Vitest (TS), forge test (Solidity) | Fast, native to each side |
| Lint and format | ESLint 10 + typescript-eslint, Prettier (code only; Markdown excluded), forge fmt | Consistent style without reflowing docs tables |
| CI | GitHub Actions: TypeScript job + contracts job | Every PR runs format, typecheck, lint, tests, forge build and forge test |

Later days add Anchor (Solana), a Vite + React web app (ADR-010; the plan first said Next.js), Hono (API) and a Python service for Laya. Each gets its own ADR if the choice isn't already in docs/PLAN.md Section 16.

## Cross-language contract

Enum codes and EIP-712 type strings are defined twice: in `packages/shared` (TypeScript) and `contracts/evm/src/libraries/BondedTypes.sol`. Both test suites assert the same expected hashes, produced by viem from shared fixtures. Changing one side without the other fails CI.

## Consequences

- Contributors need pnpm and Foundry installed; `git clone --recursive` (or `git submodule update --init --recursive`) is required for the contracts.
- USD amounts on-chain use 6 decimals to match USDC. Mandate limits are whole dollars off-chain and converted by `toEvmMandateParams`.
