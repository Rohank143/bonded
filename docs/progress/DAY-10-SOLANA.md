# Day 10: Solana on devnet

Plan reference: docs/PLAN.md Section 20, Day 10 ("Solana E2E breach → claim on devnet"). Design: ADR-011. The Sentinel half of Day 10 is in `DAY-10.md`.

## Done

### Deployed to devnet

| Program | Id | Deploy transaction |
|---|---|---|
| `bonded_registry` | `7hfPMrd4A264TfgTivV1QLmps9N5ZCf4r64csh8hfuYy` | [39JK73jd…](https://explorer.solana.com/tx/39JK73jdKixsPwMbrJgsieR5iMXoGbWYZZDGjYAANMStd2PPJUe2batPFotjuPhR4D3bvbx5W6m58smZ9gC4WALT?cluster=devnet) |
| `bonded_vault` | `8hNVDFF7aU2BJa4avnv2X7ziYEmguCaCHTZYBKo2CzFx` | [583dhRs2…](https://explorer.solana.com/tx/583dhRs2CxGLHGZgwPZoEEHdkNocYUzSgfWGeJ3TcM73EBsmh5xbKgSQuKps66hyh3fiksjQMDkbyp7KdLGxuUei?cluster=devnet) |
| `bonded_cover` | `Dcrwfd272QQxXS4oEmHPSQdGWRZ2BMRSMb3Vi7jj6Y1X` | [2U2G9gEZ…](https://explorer.solana.com/tx/2U2G9gEZjYbtnhZbeNdwhigcjKBss3k2vLrS5D2AsYCAcjurgXQq6XefzNCFMAQcvr15vCDTvdRD9X38noVBEujG?cluster=devnet) |

- Built from `main` and deployed with the keypairs that match the committed ids (ADR-011, section 6).
- The deployer wallet (`5cJyCH…`) is the upgrade authority, which the programs require to initialize.
- Each program has 50% room to grow, so the ADR-011 follow-ups can ship as upgrades. Deploying cost about 8.6 devnet SOL.
- Addresses are in `contracts/solana/deployments/devnet.json`: programs, the test-USD mint, the attester and the pool.

### Shared client and devnet runner

- **`bonded_client`:** addresses and instruction builders for the three programs. The LiteSVM flow tests moved into it and now build every instruction with it, so they check the same code the devnet runner uses. All 6 flow tests and 4 signature-check tests pass.
- **`bonded-devnet setup`:** a test-USD mint, the programs initialized, test accounts funded and the pool seeded with 1,000,000 test USD. Safe to repeat.
- **`bonded-devnet e2e`:** a new agent each run, with checks and an explorer link per transaction.
- Test keys (attester, operator, agent, underwriter, mint) live in `~/.config/bonded/solana-devnet/`, outside the repository.
- Rehearsed three times on a local validator before devnet.

### End-to-end on devnet

[Evidence](evidence/solana-devnet-e2e.json), agent 1, policy 1:

1. Register the agent, and post the attester-signed score (checked on chain with the Ed25519 program).
2. Create a vault in Monitor mode holding 50,000 test USD; the operator bonds 500.
3. Buy 20,000 of cover with an attester-signed quote.
4. The agent sends 1,000 out of the vault: recorded as an unauthorized transfer, and the vault freezes.
5. Anyone files the claim.

The payout is 900 to the vault (10% deductible): all 500 of the bond first, then 400 from the pool. The cover left is 19,100 and the breach is marked claimed. All seven checks passed.

## Done when

- **"Solana E2E breach → claim on devnet":** met.

## Not yet

- **Keeper and TypeScript SDK support for Solana:** next PR. It needs a TypeScript client generated from the program IDLs; the keeper then indexes Solana vaults and policies and files claims, as it does on EVM.
- **ADR-011 section 5 follow-ups** (streamed premiums, withdrawal cooldowns, per-agent caps, one policy per vault, bond withdrawal). These are program changes, shipped as upgrades.
- The programs are unaudited, like the EVM contracts (plan Section 25).
