# Deployments

`<chainId>.json` files written by `script/Deploy.s.sol` when it broadcasts. Local anvil runs (`31337.json`) are git-ignored; testnet and mainnet files are committed and validated by `packages/shared/test/deployments.test.ts`.

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

## Deploying

From `contracts/evm`, with a funded key in `DEPLOYER_PRIVATE_KEY` (with `0x`):

```bash
WAITING_PERIOD=0 forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast
```

- Leave off `--broadcast` for a free dry run. It simulates everything and writes no file.
- A deploy only happened if forge ends with `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`.

## Smoke run

This runs the demo loop against a deployment: register, vault, bond, cover, breach, claim. The claim must pay 4,500. With only `DEPLOYER_PRIVATE_KEY` set, the deployer plays every role:

```bash
forge script script/Smoke.s.sol --rpc-url <rpc> --broadcast
```

| Chain | RPC |
|---|---|
| Robinhood Chain testnet | `https://rpc.testnet.chain.robinhood.com/rpc` |
| Arbitrum Sepolia | `https://sepolia-rollup.arbitrum.io/rpc` |
