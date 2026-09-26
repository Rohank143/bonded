# ADR-004: Registry, disputes, bounties and deployment

- **Status:** Accepted
- **Date:** 2026-09-27
- **Code:** `contracts/evm/src/BondedRegistry.sol`, `DisputeModule.sol`, `BountyBoard.sol`, `src/testnet/`, `script/Deploy.s.sol`, `script/Smoke.s.sol`, `packages/shared/src/deployments.ts`

## Context

By Day 3 the protocol could bind cover and pay claims, but two things were missing:
- Agent identity and the attester set lived inside CoverManager.
- The operator was simply whoever first staked a bond.

Day 4 adds:
- the registry every module reads identity from
- the optimistic path for claims a vault can't prove on its own (T4)
- the bounty board that keeps the attack library growing
- scripts that deploy and exercise the whole system on any EVM chain

## Decisions

### 1. BondedRegistry follows the ERC-8004 identity shape

Agents are ERC-721 tokens:
- `register()`, `register(uri)` and `register(uri, metadata[])` mint an agent to the caller.
- The token URI points to the agent's registration file.
- Owners can set key/value metadata.

These match the ERC-8004 IdentityRegistry functions, so ERC-8004 tooling can read Bonded agents. Where a canonical ERC-8004 registry exists (Ethereum Sepolia), an agent can link its canonical id through metadata. We don't depend on a canonical registry because Robinhood Chain and Arbitrum Sepolia don't have one.

The token owner **is** the operator:
- OperatorBond and CoverManager read `agentOwner(agentId)` instead of keeping their own records.
- Transferring the agent NFT hands over operator rights, including withdrawing the bond, so operators should hold agents in a multisig.

### 2. Scores are signed attestations anyone can relay

The Arena attester signs an EIP-712 `Attestation`. `postScore` is permissionless. It checks:
- the agent exists
- the score is 0–100
- the attestation hasn't expired
- the signer is an active attester
- `issuedAt` is newer than the stored score

The last check stops anyone replaying an old, better score over a fresh one. Because only the signature matters, the keeper can post the same signed score to every chain (Day 11). Each posted score also emits an ERC-8004-style `ValidationResponse`, with the score as the response and the report hash as the response hash. `validationRequest` lets an owner ask for a rating on-chain; the Arena watches for it.

### 3. The registry holds the attester set

CoverManager (quotes) and BountyBoard (accept/reject) both ask `registry.isAttester`. One multisig-owned list means rotating an attester key is a single transaction on each chain. CoverManager's own attester mapping from Day 3 is gone.

### 4. Anyone can stake a bond, but only the operator can withdraw it

Staking is open for any registered agent (a backer can top up an operator's first-loss stake). Withdrawal goes to the agent's current owner. A bond staked against an unregistered id reverts with `UnknownAgent`, so money can't get stuck.

### 5. Grey-area claims go through an optimistic dispute

T1–T3 breaches are proven by the vault's own log and pay instantly (ADR-003). A T4 claim, such as a drawdown blamed on agent misbehaviour, needs judgment. `DisputeModule` handles it optimistically:

1. **Propose:** anyone proposes `(policyId, lossBase, evidenceHash, evidenceURI)` with a bond (250 tUSDG on testnets). The evidence is usually the AI adjudicator's report.
2. **Unchallenged:** after the challenge period (2 days; 5 minutes to 14 days allowed), anyone calls `finalize`. ClaimsEngine pays through the normal waterfall (deductible, premium netting, bond, then pool) and the proposer gets their bond back.
3. **Challenged:** a challenger posts the same bond and the council decides. The winner takes both bonds.
4. **Unpayable:** the council can reject an unchallenged proposal that can't be paid (e.g. its claim window closed), returning the proposer's bond. It can't approve an unchallenged proposal early; that path is time-based.

Details:
- `ClaimsEngine.payDispute` accepts calls from the DisputeModule only. That address is set once, so the owner can't later swap in a module that pays arbitrary amounts.
- The council is a multisig for the hackathon. UMA or Kleros can replace it without touching ClaimsEngine.

### 6. Bounties use commit-reveal bound to the hunter

A hunter commits `keccak256(abi.encode(hunter, specURI, salt))`:
- The commitment timestamps priority without showing the attack.
- Including the hunter's address means a watcher who copies the commitment can't reveal it.
- Only the committing hunter can reveal.

An attester then accepts (paying a reward from the board's balance, which is the 5% premium share) or rejects with a reason hash. Novelty and reproducibility are judged off-chain by the Arena; the contract records the decision and moves the money.

### 7. Testnets get a self-contained demo market

The chain facts (Section 15) left gaps: we couldn't confirm the USDG address, stock token addresses or AMM deployments on Robinhood Chain testnet. The demo can't depend on them, so the deploy script brings its own market:
- **`TestToken`:** tUSDG (6 decimals) plus tTSLA, tAMZN and tNVDA (18 decimals, like Robinhood Stock Tokens), each with a capped public faucet.
- **`MockOracle`:** with set prices.
- **`DemoRouter`:** swaps at the oracle price minus a 0.2% fee from its own inventory.

Because the router trades at oracle prices, the vault's slippage check (T3) behaves predictably in the demo. On mainnet the protocol uses real tokens, `ChainlinkOracle` and real venues; the testnet contracts live in `src/testnet/` and are never deployed there.

### 8. One deploy script, one smoke script, one JSON file per chain

- **`Deploy.s.sol`:**
  - Deploys the market and the protocol, wires every module and sets the cover terms.
  - Writes `deployments/<chainId>.json`.
  - The deployer owns everything at first. Ownership moves to a multisig afterwards through `Ownable2Step`.
- **`Smoke.s.sol`:**
  - Reads that file and runs the demo loop: register, create a vault, stake, fund, sign a quote, bind cover, an allowed swap, a breach, and the claim.
  - Asserts the 4,500 payout.
- **`pnpm demo:local`:** runs both against anvil.
- **Committed files:** testnet and mainnet JSON files are committed; the local one is ignored.
- **`@bonded/shared`:** `parseEvmDeployment` validates the file, so the API and keeper read addresses through one checked path.

## Known limits

- **The testnet deploy itself is pending.** The container can't reach the testnet RPCs and has no deployer key. The scripts are proven on anvil; the testnet run is one command once both are available (see DAY-04).
- **Optimistic disputes need watchers.** An unchallenged proposal pays after 2 days. The operator (whose bond pays first), underwriters and the keeper are the ones who should challenge. The keeper will flag every proposal (Day 7).
- **Dispute payouts aren't tied to breach records.** Two disputes on the same loss could both pay, up to the policy's remaining cover. The challenge game is the defence; the council should reject duplicates.
- **The council can reject any unchallenged proposal.** That is a trust assumption on the multisig until UMA or Kleros replaces it.
- **Transferring an agent transfers its bond.** This is intended (the bond follows operator rights), but a stolen owner key also controls the bond after the cooldown.
- **Bounty rewards are at the attester's discretion,** limited only by the board's balance.
