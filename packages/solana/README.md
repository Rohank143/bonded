# @bonded/solana

TypeScript client for Bonded's Solana programs: the registry, the Mandate Vault and the cover pool.

- **IDLs and program ids** (`bondedVaultIdl`, `bondedRegistryIdl`, `bondedCoverIdl`, `PROGRAM_IDS`),
  generated from the Anchor build, so account layouts can't drift from the Rust.
- **Addresses**: the program-derived addresses of vaults, policies and registry entries (`address`).
- **Accounts**: `decodeVault`, `decodePolicy`, `decodeCoverConfig`, and `fetchVault(s)`,
  `fetchPolicies`, `fetchAgent`, `fetchRegistryConfig`.
- **Instructions**: create a vault, deposit, `execute` through the vault, register an agent, post a
  score, file a claim (`claimable` works out what a claim can pay).
- **Breaches**: `breachEventsFromLogs` reads the vault's breach events from a transaction's logs;
  `vaultError` names the vault's error codes.

```ts
import { Connection } from "@solana/web3.js";
import { fetchVaults } from "@bonded/solana";

const vaults = await fetchVaults(new Connection("https://api.devnet.solana.com"));
```

To trade through a vault from Solana Agent Kit, use `@bonded/sdk/solana-agent-kit`, which builds on
this package.

ESM only, Node 22 or later. See the [Bonded repository](https://github.com/ddboy19912/bonded) for
the protocol and its documentation.
