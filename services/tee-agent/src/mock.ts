import { createHash } from "node:crypto";
import type { TeeBackend } from "./backend.js";

/**
 * A stand-in for local development. Its keys are derived from a public label, and its "quote" is
 * not a quote: the Arena's verifier rejects it, so a mock agent can never earn a TEE badge.
 */
export class MockBackend implements TeeBackend {
  readonly name = "mock" as const;
  private seed = (label: string) => new Uint8Array(createHash("sha256").update(label).digest());

  async evmKey(): Promise<Uint8Array> {
    return this.seed("bonded-mock-evm");
  }

  async arenaKey(keyId: string): Promise<Uint8Array> {
    return this.seed(`bonded-mock-arena:${keyId.replace(/^0x/, "").toLowerCase()}`);
  }

  async solanaSeed(): Promise<Uint8Array> {
    return this.seed("bonded-mock-solana");
  }

  async quote(reportData: Uint8Array): Promise<{ quote: string; eventLog: string }> {
    // Not a TDX quote: only the report data, so it is obvious what it is and it never verifies.
    return { quote: Buffer.from(reportData).toString("hex"), eventLog: "[]" };
  }

  async composeHash(): Promise<string> {
    return "00".repeat(32);
  }
}
