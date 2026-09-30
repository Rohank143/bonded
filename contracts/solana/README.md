# Bonded on Solana

Three Anchor programs, mirroring the EVM contracts (design: `docs/decisions/011-solana-programs.md`):

- `bonded_registry`: agents and their attester-signed scores.
- `bonded_vault`: checks every agent call, keeps the breach log, freezes on a breach.
- `bonded_cover`: underwriting pool, operator bonds, signed quotes and parametric claims.

Two supporting crates:

- `crates/bonded_client`: addresses and instruction builders for all three programs. The tests, the devnet runner and the keeper build instructions with it, so the LiteSVM tests (`tests/flow.rs`) check the same code that runs on devnet.
- `crates/bonded_devnet`: the `bonded-devnet` command, which sets up and exercises the programs on devnet.

## Build and test

From the repository root:

```bash
pnpm solana:test
```

This builds the programs and runs the tests on LiteSVM.

## Devnet

The program ids come from keypairs in `target/deploy/`, which stay out of git (ADR-011, section 6). Deploy with the matching keypairs, never with `--ignore-keys`.

**1. Deploy**, from `contracts/solana`, with the deployer wallet (`~/.config/solana/id.json`) holding devnet SOL. `--max-len` sizes each program to its binary, which roughly halves the rent; an upgrade to a larger binary first needs `solana program extend`.

```bash
for p in bonded_registry bonded_vault bonded_cover; do solana program deploy -u devnet --program-id target/deploy/$p-keypair.json --max-len $(stat -f%z target/deploy/$p.so) target/deploy/$p.so; done
```

At the Day 10 sizes this costs about 5.7 SOL, with about 5.3 SOL needed at the peak of the largest deploy. The deployer becomes each program's upgrade authority, which the programs require to initialize.

**2. Set up**, once and safe to repeat: a test-USD mint, the three programs initialized, test accounts funded and the pool seeded with 1,000,000 test USD. It writes `deployments/devnet.json`.

```bash
cargo run -p bonded_devnet -- setup
```

**3. Run the end-to-end flow.** Each run registers a new agent, posts a signed score, creates a vault holding 50,000, bonds 500, buys 20,000 of cover with a signed quote, has the agent send 1,000 out (a breach), and files the claim. It checks the vault froze, that 900 came back (the 10% deductible), the bond paid first and the pool the rest, and prints an explorer link for every transaction.

```bash
cargo run -p bonded_devnet -- e2e ../../docs/progress/evidence/solana-devnet-e2e.json
```

The test keys (attester, operator, agent, underwriter, mint) are created on first use in `~/.config/bonded/solana-devnet/`, outside the repository. `SOLANA_RPC_URL=http://127.0.0.1:8899` runs the same commands against a local validator, for a rehearsal.
