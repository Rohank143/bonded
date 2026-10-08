/**
 * What the agent needs from the TEE runtime. The real implementation talks to dstack's guest
 * agent (`dstack.ts`); `mock.ts` stands in for it on a laptop and can never produce a quote the
 * Arena accepts.
 */
export interface TeeBackend {
  readonly name: "dstack" | "mock";
  /** The agent's secp256k1 key for EVM chains, 32 bytes, derived inside the TEE. */
  evmKey(): Promise<Uint8Array>;
  /** The agent's ed25519 seed for Solana, 32 bytes, derived inside the TEE. */
  solanaSeed(): Promise<Uint8Array>;
  /**
   * A secp256k1 key for one Arena rating, 32 bytes, derived inside the TEE from the key id the
   * Arena chose (32 bytes, hex). Different for every key id, and never the production key.
   */
  arenaKey(keyId: string): Promise<Uint8Array>;
  /** An Intel TDX quote whose report data is `reportData` (up to 64 bytes). */
  quote(reportData: Uint8Array): Promise<{ quote: string; eventLog: string }>;
  /** Hash of the app-compose file this app was deployed from. */
  composeHash(): Promise<string>;
}
