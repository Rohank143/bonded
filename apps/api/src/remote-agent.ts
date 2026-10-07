import {
  TeeVerificationError,
  verifyTeeEvidence,
  type QuoteVerifier,
  type VerifiedTee,
} from "@bonded/arena";
import type { ArenaAgent, RemoteMode } from "@bonded/shared";
import type { Hex } from "viem";

/**
 * Bring your own agent (docs/BRING-YOUR-OWN-AGENT.md): the rating worker's side of a remote agent.
 * The agent runs on its operator's servers and reaches the Arena through the Arena Gateway, so to
 * the rating it is one more `ArenaAgent`. Building that agent is the gateway's job; this module is
 * the one seam between the worker and the gateway, so the worker never depends on how it works.
 */

/** What the worker tells the gateway about the agent it is about to rate. */
export interface RemoteAgentRequest {
  /** The agent's row id, "<chain id>:<agent id>": the key its runner token resolves to. */
  agentKey: string;
  chainId: number;
  /** The on-chain agent id. */
  agentId: string;
  mode: RemoteMode;
  /** The operator's declared code hash: what the rating is about. */
  codeHash: Hex;
  /**
   * A TEE-bound agent. The gateway asks the runner for evidence with a fresh nonce at the start of
   * every episode and passes it to `verify`, which throws when it doesn't hold. In chain mode the
   * episode's vault names `evmAddress`, the TEE's own key, as its agent.
   */
  tee?: {
    evmAddress: Hex;
    verify: (evidence: unknown, nonce: Hex) => Promise<VerifiedTee>;
  };
}

/** Builds the remote agent for one rating (the gateway's `RemoteAgent`). */
export type RemoteAgentFactory = (request: RemoteAgentRequest) => ArenaAgent;

/** A rating that can't run, and whether trying again could help. Its message is stored as is. */
export class RatingRefused extends Error {
  constructor(
    message: string,
    /** True when retrying can't help (the job fails at once instead of being retried). */
    readonly final: boolean,
  ) {
    super(message);
    this.name = "RatingRefused";
  }
}

/** The remote agent for a rating, or a clear refusal when this worker has no gateway. */
export function remoteAgentFor(
  factory: RemoteAgentFactory | undefined,
  request: RemoteAgentRequest,
): ArenaAgent {
  if (!factory)
    throw new RatingRefused(
      "gateway not available: this rating worker has no Arena Gateway, so it can't rate an agent that runs on its operator's servers",
      true,
    );
  return factory(request);
}

/**
 * Binds a remote agent's rating to one TEE deployment. The reference is the evidence verified
 * before the rating started; every episode's evidence must verify against its own nonce and show
 * the same measurement and the same EVM key. The first thing that doesn't hold is kept as
 * `failure`, and the worker fails the whole rating on it.
 */
export class TeeBinding {
  /** Episodes whose evidence verified and matched. */
  verified = 0;
  failure: string | undefined;

  constructor(
    readonly reference: VerifiedTee,
    private readonly expected: {
      codeHash: Hex;
      composeHash: string;
      verifyQuote?: QuoteVerifier;
      approvedOsImages?: readonly string[];
    },
  ) {}

  /** Checks one episode's evidence (see the class note). Throws `TeeVerificationError`. */
  async check(evidence: unknown, nonce: Hex): Promise<VerifiedTee> {
    try {
      const live = await verifyTeeEvidence(evidence, { ...this.expected, nonce });
      if (live.measurement.toLowerCase() !== this.reference.measurement.toLowerCase())
        throw new TeeVerificationError("the TEE measurement changed during the rating");
      if (live.evmAddress.toLowerCase() !== this.reference.evmAddress.toLowerCase())
        throw new TeeVerificationError("the TEE agent's key changed during the rating");
      this.verified++;
      return live;
    } catch (error) {
      this.failure ??=
        error instanceof Error ? error.message : "the TEE evidence could not be checked";
      throw error;
    }
  }

  /** Why the rating can't carry this TEE's measurement, or undefined when every episode proved it. */
  verdict(episodes: number): string | undefined {
    if (this.failure) return `TEE binding failed: ${this.failure}`;
    if (this.verified < episodes)
      return `TEE binding failed: ${episodes - this.verified} of ${episodes} episodes had no verified TEE evidence`;
    return undefined;
  }
}
