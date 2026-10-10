# Deployments

`<chainId>.json` files for each chain Bonded is deployed on, written only after the deployment is confirmed on-chain (see Deploying). Local anvil runs (`31337.json`) are git-ignored, and the Arena's throwaway sandboxes write to `sandbox/` (also git-ignored) by setting `DEPLOYMENTS_DIR`; testnet and mainnet files are committed and validated by `packages/shared/test/deployments.test.ts`.

## Live testnets

Deployed Oct 10, 2026 by `0xd42FA5ae8949710479954ae78D1b12Ff2e50A841`, which owns every contract and is the attester and the dispute council (a single key on testnet; a multisig is a mainnet prerequisite). Waiting period 0, so the demo loop runs without waiting. The test tokens, MockOracle and DemoRouter are testnet stand-ins: they have no value.

| Chain | Chain id | Deploy block | Explorer | File |
|---|---|---|---|---|
| Robinhood Chain testnet | 46630 | 132,181,779 | https://explorer.testnet.chain.robinhood.com | [`46630.json`](46630.json) |
| Arbitrum Sepolia | 421614 | 317,698,201 | https://sepolia.arbiscan.io | [`421614.json`](421614.json) |
| Ethereum Sepolia | 11155111 | 11,883,864 | https://sepolia.etherscan.io | [`11155111.json`](11155111.json) |

### Robinhood Chain testnet (46630)

| Contract | Address | What it does |
|---|---|---|
| BondedRegistry | [`0x691563A85D1D80f2891c0ecb2096E58CC4b4DFBA`](https://explorer.testnet.chain.robinhood.com/address/0x691563A85D1D80f2891c0ecb2096E58CC4b4DFBA) | agents, scores and attesters |
| MandateVaultFactory | [`0xB63392D0451877B6c5cFb15eBF78062B7CdcD45f`](https://explorer.testnet.chain.robinhood.com/address/0xB63392D0451877B6c5cFb15eBF78062B7CdcD45f) | creates Mandate Vaults |
| MandateModuleFactory | [`0x0DafdC13b77114e472C910B58608f905972a801a`](https://explorer.testnet.chain.robinhood.com/address/0x0DafdC13b77114e472C910B58608f905972a801a) | creates MandateModules for ERC-7579 smart accounts |
| CoverManager | [`0x17F6aebb3976669F6b5D6def2eb0fd12a08678Be`](https://explorer.testnet.chain.robinhood.com/address/0x17F6aebb3976669F6b5D6def2eb0fd12a08678Be) | buys and renews cover |
| CoverPool | [`0x8D66B526e5bBDbc3BFd46B8c0e199E6555362b75`](https://explorer.testnet.chain.robinhood.com/address/0x8D66B526e5bBDbc3BFd46B8c0e199E6555362b75) | holds the capital that pays claims |
| OperatorBond | [`0x6001e51A208F11EfdD8716B1aa5986AABfb76Ca5`](https://explorer.testnet.chain.robinhood.com/address/0x6001e51A208F11EfdD8716B1aa5986AABfb76Ca5) | operators' bonds |
| ClaimsEngine | [`0xCE05398FCcddbc1E5874f7A6bC517eD24d4bE849`](https://explorer.testnet.chain.robinhood.com/address/0xCE05398FCcddbc1E5874f7A6bC517eD24d4bE849) | pays claims from on-chain breach records |
| DisputeModule | [`0xA21Eb03BC2D067f9068c44e2952BE7473e626377`](https://explorer.testnet.chain.robinhood.com/address/0xA21Eb03BC2D067f9068c44e2952BE7473e626377) | disputes and the council's decisions |
| BountyBoard | [`0xE78Afc3309A28c2c0a827451A8aB3A22EcCB1b06`](https://explorer.testnet.chain.robinhood.com/address/0xE78Afc3309A28c2c0a827451A8aB3A22EcCB1b06) | attack bounties |
| tUSDG | [`0xee6994766d49962CfbC6C592E724828f80815b1D`](https://explorer.testnet.chain.robinhood.com/address/0xee6994766d49962CfbC6C592E724828f80815b1D) | test dollar, the base asset |
| tTSLA | [`0x09Dbb4537432997d96f8c594676644Bc0A6169FF`](https://explorer.testnet.chain.robinhood.com/address/0x09Dbb4537432997d96f8c594676644Bc0A6169FF) | test token |
| tAMZN | [`0xF70580bfA582d08DC3a0DE0811D558a12451de73`](https://explorer.testnet.chain.robinhood.com/address/0xF70580bfA582d08DC3a0DE0811D558a12451de73) | test token |
| tNVDA | [`0x2021867c5Be6DD58B292c0993B3850a19789888b`](https://explorer.testnet.chain.robinhood.com/address/0x2021867c5Be6DD58B292c0993B3850a19789888b) | test token |
| MockOracle | [`0xccAf39258CD76766fCBa2E339c5932f1d027d9C2`](https://explorer.testnet.chain.robinhood.com/address/0xccAf39258CD76766fCBa2E339c5932f1d027d9C2) | test prices, set by the owner |
| DemoRouter | [`0xcC29B5a0b2E6c6F6b3F582F2d191cBE3425C8e5B`](https://explorer.testnet.chain.robinhood.com/address/0xcC29B5a0b2E6c6F6b3F582F2d191cBE3425C8e5B) | test swaps |

### Arbitrum Sepolia (421614)

| Contract | Address | What it does |
|---|---|---|
| BondedRegistry | [`0xa8896AEd5c2bF49De4Da3578C515eb5B6eB56B42`](https://sepolia.arbiscan.io/address/0xa8896AEd5c2bF49De4Da3578C515eb5B6eB56B42) | agents, scores and attesters |
| MandateVaultFactory | [`0x245acb12F05dC60ac9B7547Dae9bF0215769e308`](https://sepolia.arbiscan.io/address/0x245acb12F05dC60ac9B7547Dae9bF0215769e308) | creates Mandate Vaults |
| MandateModuleFactory | [`0x7DFb980BD1Ed4B12EB149F4e48AF433adE6058c6`](https://sepolia.arbiscan.io/address/0x7DFb980BD1Ed4B12EB149F4e48AF433adE6058c6) | creates MandateModules for ERC-7579 smart accounts |
| CoverManager | [`0xF9020e6DFaE001f58dd2380C0724b04157367CCF`](https://sepolia.arbiscan.io/address/0xF9020e6DFaE001f58dd2380C0724b04157367CCF) | buys and renews cover |
| CoverPool | [`0x2AAc3078ec420e5727c5A83D414f6818Ca87AAae`](https://sepolia.arbiscan.io/address/0x2AAc3078ec420e5727c5A83D414f6818Ca87AAae) | holds the capital that pays claims |
| OperatorBond | [`0x470ae0b43FcFd302964921745ac2Fb83718B330E`](https://sepolia.arbiscan.io/address/0x470ae0b43FcFd302964921745ac2Fb83718B330E) | operators' bonds |
| ClaimsEngine | [`0x0a98FF1647fFc1cB411851Fd24cA7Ad459eB75a4`](https://sepolia.arbiscan.io/address/0x0a98FF1647fFc1cB411851Fd24cA7Ad459eB75a4) | pays claims from on-chain breach records |
| DisputeModule | [`0x7F4b4379Fd4e56Cc0b545a344316e6bb2994b0a1`](https://sepolia.arbiscan.io/address/0x7F4b4379Fd4e56Cc0b545a344316e6bb2994b0a1) | disputes and the council's decisions |
| BountyBoard | [`0x92FE64fCAD46065e4d93Fe0b6F8ECD5Fbfb8B0D1`](https://sepolia.arbiscan.io/address/0x92FE64fCAD46065e4d93Fe0b6F8ECD5Fbfb8B0D1) | attack bounties |
| tUSDG | [`0x6a4FDda2F20e7FD99d1C21Cb74F953F0F15035AC`](https://sepolia.arbiscan.io/address/0x6a4FDda2F20e7FD99d1C21Cb74F953F0F15035AC) | test dollar, the base asset |
| tTSLA | [`0xCb77Ab45E93FB775d28f01233F70B4CD10311f55`](https://sepolia.arbiscan.io/address/0xCb77Ab45E93FB775d28f01233F70B4CD10311f55) | test token |
| tAMZN | [`0xd5A86802B28Da2407D9e25C174a72241d052e291`](https://sepolia.arbiscan.io/address/0xd5A86802B28Da2407D9e25C174a72241d052e291) | test token |
| tNVDA | [`0xD0Fd33EB27416CAEFa8e9eaB3150687d4098d907`](https://sepolia.arbiscan.io/address/0xD0Fd33EB27416CAEFa8e9eaB3150687d4098d907) | test token |
| MockOracle | [`0x36DfFc9D91Cc40cBB0cDE7c808291e323f48dD5d`](https://sepolia.arbiscan.io/address/0x36DfFc9D91Cc40cBB0cDE7c808291e323f48dD5d) | test prices, set by the owner |
| DemoRouter | [`0xF2BCEBA860806D0DE44edA2c9489284a869F55f7`](https://sepolia.arbiscan.io/address/0xF2BCEBA860806D0DE44edA2c9489284a869F55f7) | test swaps |

### Ethereum Sepolia (11155111)

| Contract | Address | What it does |
|---|---|---|
| BondedRegistry | [`0x2AAc3078ec420e5727c5A83D414f6818Ca87AAae`](https://sepolia.etherscan.io/address/0x2AAc3078ec420e5727c5A83D414f6818Ca87AAae) | agents, scores and attesters |
| MandateVaultFactory | [`0x470ae0b43FcFd302964921745ac2Fb83718B330E`](https://sepolia.etherscan.io/address/0x470ae0b43FcFd302964921745ac2Fb83718B330E) | creates Mandate Vaults |
| MandateModuleFactory | [`0x6FA4Bc8cF38BeDE702D588D93f14585F0033eb34`](https://sepolia.etherscan.io/address/0x6FA4Bc8cF38BeDE702D588D93f14585F0033eb34) | creates MandateModules for ERC-7579 smart accounts |
| CoverManager | [`0x7F4b4379Fd4e56Cc0b545a344316e6bb2994b0a1`](https://sepolia.etherscan.io/address/0x7F4b4379Fd4e56Cc0b545a344316e6bb2994b0a1) | buys and renews cover |
| CoverPool | [`0x92FE64fCAD46065e4d93Fe0b6F8ECD5Fbfb8B0D1`](https://sepolia.etherscan.io/address/0x92FE64fCAD46065e4d93Fe0b6F8ECD5Fbfb8B0D1) | holds the capital that pays claims |
| OperatorBond | [`0xF9020e6DFaE001f58dd2380C0724b04157367CCF`](https://sepolia.etherscan.io/address/0xF9020e6DFaE001f58dd2380C0724b04157367CCF) | operators' bonds |
| ClaimsEngine | [`0x74e6ea49f417a791789db5Ad3B3186d1bd2DF622`](https://sepolia.etherscan.io/address/0x74e6ea49f417a791789db5Ad3B3186d1bd2DF622) | pays claims from on-chain breach records |
| DisputeModule | [`0x6CdFa3d9D206AA5F4F3B24C620CB4eD4eE002d5D`](https://sepolia.etherscan.io/address/0x6CdFa3d9D206AA5F4F3B24C620CB4eD4eE002d5D) | disputes and the council's decisions |
| BountyBoard | [`0x0a98FF1647fFc1cB411851Fd24cA7Ad459eB75a4`](https://sepolia.etherscan.io/address/0x0a98FF1647fFc1cB411851Fd24cA7Ad459eB75a4) | attack bounties |
| tUSDG | [`0xd5A86802B28Da2407D9e25C174a72241d052e291`](https://sepolia.etherscan.io/address/0xd5A86802B28Da2407D9e25C174a72241d052e291) | test dollar, the base asset |
| tTSLA | [`0xD0Fd33EB27416CAEFa8e9eaB3150687d4098d907`](https://sepolia.etherscan.io/address/0xD0Fd33EB27416CAEFa8e9eaB3150687d4098d907) | test token |
| tAMZN | [`0x36DfFc9D91Cc40cBB0cDE7c808291e323f48dD5d`](https://sepolia.etherscan.io/address/0x36DfFc9D91Cc40cBB0cDE7c808291e323f48dD5d) | test token |
| tNVDA | [`0xf2Ca3a0643cE644a02D286B7b7487CA21Ea646B1`](https://sepolia.etherscan.io/address/0xf2Ca3a0643cE644a02D286B7b7487CA21Ea646B1) | test token |
| MockOracle | [`0x60B909C5c854fAF427094604955fF1D2e5575bF9`](https://sepolia.etherscan.io/address/0x60B909C5c854fAF427094604955fF1D2e5575bF9) | test prices, set by the owner |
| DemoRouter | [`0xBAd7809808f112b2E3cbebD666BBdACc4379A438`](https://sepolia.etherscan.io/address/0xBAd7809808f112b2E3cbebD666BBdACc4379A438) | test swaps |

Addresses differ between chains, so always read them from `<chainId>.json` (or `@bondedhq/shared`), never from another chain.

An earlier deployment (Sep 27, 2026 on Robinhood and Arbitrum Sepolia, Sep 30 on Ethereum Sepolia) predates MandateModule and is no longer used by the hosted service; agents, vaults, bonds and cover made on it stay there. Its addresses are in this file's git history.

## Deploying

Put a funded, testnet-only key in the repo root's `.env` as `DEPLOYER_PRIVATE_KEY` (copy [`.env.example`](../../../.env.example); a shell variable works too), then from the repo root:

```bash
pnpm contracts:deploy robinhood   # or: arbitrum, sepolia, or any RPC URL
```

Set `WAITING_PERIOD=0` in `.env` if you want to run the demo loop right away, as the live deployments do.

Extra arguments after the chain go to `forge script`. Ethereum Sepolia needs one: it now charges about 5.3 times more gas to create a contract than forge's built-in EVM expects, so with forge's own estimates the first transaction runs out of gas. Give every transaction more headroom (unused gas isn't charged):

```bash
contracts/evm/script/deploy.sh sepolia --gas-estimate-multiplier 750
```

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
