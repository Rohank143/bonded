import { DstackClient } from "@phala/dstack-sdk";
import type { TeeBackend } from "./backend.js";

/** Key derivation paths. Changing one changes the agent's address, so they are fixed here. */
export const EVM_KEY_PATH = ["bonded/agent/v1", "evm"] as const;
export const SOLANA_KEY_PATH = ["bonded/agent/v1", "solana"] as const;

/**
 * dstack's guest agent, reached over its Unix socket inside the CVM (or the simulator's HTTP
 * endpoint through DSTACK_SIMULATOR_ENDPOINT). Keys are derived from the app's identity, so the
 * same compose hash gets the same keys after a restart and no other app can derive them.
 */
export class DstackBackend implements TeeBackend {
  readonly name = "dstack" as const;
  constructor(private readonly client: DstackClient = new DstackClient()) {}

  async evmKey(): Promise<Uint8Array> {
    return (await this.client.getKey(...EVM_KEY_PATH, "secp256k1")).key;
  }

  async solanaSeed(): Promise<Uint8Array> {
    // ed25519 derivation needs dstack OS 0.5.7 or newer; the SDK checks and says so.
    return (await this.client.getKey(...SOLANA_KEY_PATH, "ed25519")).key;
  }

  async quote(reportData: Uint8Array): Promise<{ quote: string; eventLog: string }> {
    const result = await this.client.getQuote(reportData);
    return { quote: result.quote, eventLog: result.event_log };
  }

  async composeHash(): Promise<string> {
    return (await this.client.info()).compose_hash;
  }
}
