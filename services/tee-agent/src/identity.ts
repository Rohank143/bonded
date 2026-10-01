import { Keypair } from "@solana/web3.js";
import { type TeeEvidence, teeReportData } from "@bonded/shared";
import { bytesToHex, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TeeBackend } from "./backend.js";

/**
 * The agent's identity: its two session keys and the code it runs. The private keys exist only in
 * this object's closure. Nothing here, and no route, returns them.
 */
export class AgentIdentity {
  private constructor(
    private readonly backend: TeeBackend,
    readonly codeHash: `0x${string}`,
    readonly evmAddress: `0x${string}`,
    readonly solanaPublicKey: string,
    private readonly keys: {
      evm: ReturnType<typeof privateKeyToAccount>;
      solana: Keypair;
    },
  ) {}

  static async create(backend: TeeBackend, codeHash: string): Promise<AgentIdentity> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(codeHash))
      throw new Error("CODE_HASH must be 0x followed by 64 hex digits");
    const evm = privateKeyToAccount(bytesToHex(await backend.evmKey()));
    const solana = Keypair.fromSeed(await backend.solanaSeed());
    return new AgentIdentity(
      backend,
      codeHash as `0x${string}`,
      evm.address,
      solana.publicKey.toBase58(),
      { evm, solana },
    );
  }

  /** Signs with the EVM session key. Used by the agent's own code; never exposed over HTTP. */
  signMessage(message: string): Promise<`0x${string}`> {
    return this.keys.evm.signMessage({ message });
  }

  /**
   * Evidence for one challenge: a fresh quote whose report data commits to this code, both public
   * keys and the caller's nonce. Fresh per call, so an old quote can't be replayed.
   */
  async attest(nonce: string): Promise<TeeEvidence> {
    const reportData = teeReportData({
      codeHash: this.codeHash,
      evmAddress: this.evmAddress,
      solanaPublicKey: this.solanaPublicKey,
      nonce,
    });
    const { quote, eventLog } = await this.backend.quote(hexToBytes(reportData));
    return {
      quote: `0x${quote.replace(/^0x/, "")}`,
      eventLog,
      composeHash: (await this.backend.composeHash()).replace(/^0x/, ""),
      codeHash: this.codeHash,
      evmAddress: this.evmAddress,
      solanaPublicKey: this.solanaPublicKey,
      nonce: nonce.startsWith("0x") ? nonce : `0x${nonce}`,
    };
  }
}
