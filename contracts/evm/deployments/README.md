# Deployments

`<chainId>.json` files for each chain Bonded is deployed on, written only after the deployment is confirmed on-chain (see Deploying). Local anvil runs (`31337.json`) are git-ignored; testnet and mainnet files are committed and validated by `packages/shared/test/deployments.test.ts`.

## Live testnets

Deployed Sep 27, 2026 by `0xd42FA5ae8949710479954ae78D1b12Ff2e50A841` (owner of every contract and the initial attester and council). Waiting period 0, so the demo loop runs without waiting.

| Chain | Chain id | Deploy block | Explorer |
|---|---|---|---|
| Robinhood Chain testnet | 46630 | 125,384,720 | https://explorer.testnet.chain.robinhood.com |
| Arbitrum Sepolia | 421614 | 313,403,556 | https://sepolia.arbiscan.io |

Same addresses on both chains:

| Contract | Address |
|---|---|
| tUSDG | `0x99382524a2e5E5eb862FD48D8F53DD760Df73552` |
| tTSLA | `0xC2a06E517F027cF953a9Acc31ef534b9a9097403` |
| tAMZN | `0x4dE8e52C4D3760b10a6f57caEC999DFa40f97e67` |
| tNVDA | `0xf76d46864cd81b5c011dD2EA9D7aF81C1629Df85` |
| MockOracle | `0x7d37d134054D13B0410bdafEC69cD70e77ea7917` |
| DemoRouter | `0x019e42E2EA5fF470366B874979746DaAA2c6561e` |
| BondedRegistry | `0x35F6d30BE731a639235CCAd7abEdda4d4BE8D4F9` |
| MandateVaultFactory | `0x47D5506e1a56019Df0D22Fd8B652A68a162898a2` |
| CoverPool | `0x2014ba5b16017466e50835c90004F659f62d4064` |
| OperatorBond | `0xAfF097ceeae821a8A9De8771542CDdD7b63Ee294` |
| CoverManager | `0x038C5b833424727a073080822578b8201AC19bDD` |
| ClaimsEngine | `0x6E8533A4895E6D708B32DFFF928852d7F583067e` |
| DisputeModule | `0x0b9B5B177756D3bF699C3811D1F2d6067dF0E5f7` |
| BountyBoard | `0x942CaC6582F189DcF84CCe73fFAb3c87b9c15278` |

Ethereum Sepolia (11155111) was deployed Sep 30, 2026 by the same key, from block 11,817,895 (explorer: https://sepolia.etherscan.io). The deployer had already used nonce 0 there, so every address is one step along from the table above:

| Contract | Address |
|---|---|
| tUSDG | `0xC2a06E517F027cF953a9Acc31ef534b9a9097403` |
| tTSLA | `0x4dE8e52C4D3760b10a6f57caEC999DFa40f97e67` |
| tAMZN | `0xf76d46864cd81b5c011dD2EA9D7aF81C1629Df85` |
| tNVDA | `0x7d37d134054D13B0410bdafEC69cD70e77ea7917` |
| MockOracle | `0x526fFbE1626daDc132aa46B74700055f0403c7b2` |
| DemoRouter | `0x577Fe5F2B10D4ED0e27E8d50441a696B044456f3` |
| BondedRegistry | `0x47D5506e1a56019Df0D22Fd8B652A68a162898a2` |
| MandateVaultFactory | `0x2014ba5b16017466e50835c90004F659f62d4064` |
| CoverPool | `0xAfF097ceeae821a8A9De8771542CDdD7b63Ee294` |
| OperatorBond | `0x942CaC6582F189DcF84CCe73fFAb3c87b9c15278` |
| CoverManager | `0x6E8533A4895E6D708B32DFFF928852d7F583067e` |
| ClaimsEngine | `0x0b9B5B177756D3bF699C3811D1F2d6067dF0E5f7` |
| DisputeModule | `0xa1224F50Bd9821FDF586D76d197d0823fB71cFbB` |
| BountyBoard | `0x038C5b833424727a073080822578b8201AC19bDD` |

Always read addresses from `<chainId>.json`, never assume they match across chains.

## Deploying

Put a funded, testnet-only key in the repo root's `.env` as `DEPLOYER_PRIVATE_KEY` (copy [`.env.example`](../../../.env.example); a shell variable works too), then from the repo root:

```bash
pnpm contracts:deploy robinhood   # or: arbitrum, sepolia, or any RPC URL
```

Set `WAITING_PERIOD=0` in `.env` if you want to run the demo loop right away, as the live deployments do.

It runs two steps:
1. **`Deploy.s.sol --broadcast`** deploys and writes `<chainId>.pending.json` (git-ignored). Forge runs the script before sending the transactions, so this file alone doesn't prove anything was deployed.
2. **`RecordDeployment.s.sol`** runs only if every transaction succeeded. It reads the chain, checks every address has code and the modules are wired to each other, then writes `<chainId>.json` and deletes the pending file.

If step 2 fails on a flaky RPC after a successful deploy, re-run it alone: `forge script script/RecordDeployment.s.sol --rpc-url <rpc>`.

If the RPC drops out partway through step 1, `forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --slow --resume` sends the rest. Two traps, both hit on Sepolia:
- If a transaction was mined but forge never saw its receipt, the resume fails with "nonce too low". Fetch it (`cast receipt <hash> --rpc-url <rpc> --json`), append it to `receipts` in `broadcast/Deploy.s.sol/<chainId>/run-latest.json`, and resume again.
- The resume re-runs the script, which rewrites the pending file with addresses simulated from the current nonce. Those are wrong. Rebuild the pending file from the `contractAddress` of each CREATE in `run-latest.json` before running step 2; step 2 then checks every address on chain.

For a free dry run that simulates everything and writes nothing: `forge script script/Deploy.s.sol --rpc-url <rpc>`.

## Smoke run

This runs the demo loop against a deployment: register, vault, bond, cover, breach, claim. The claim must pay 4,500.

With only `DEPLOYER_PRIVATE_KEY` set, the deployer plays every role. Set `OPERATOR_KEY`, `AGENT_KEY`, `USER_KEY` and `ATTESTER_KEY` in `.env` to use separate wallets.

```bash
pnpm contracts:smoke robinhood   # or: arbitrum, or any RPC URL
```

| Chain | RPC |
|---|---|
| Robinhood Chain testnet | `https://rpc.testnet.chain.robinhood.com/rpc` |
| Arbitrum Sepolia | `https://sepolia-rollup.arbitrum.io/rpc` |
