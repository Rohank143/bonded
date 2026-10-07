/**
 * Self-serve requests (docs/SPECIFICATION.md, Day 14 workstream 7): the messages an agent's owner signs
 * in their wallet (EIP-191 personal_sign) so the API can act for them without an operator token.
 * The web app builds them and the API rebuilds them byte for byte, so both use this module.
 */

/** Bonded's built-in agent designs a self-serve rating can use (docs/AGENTS.md). */
export const SELF_SERVE_KINDS = ["vulnerable", "partial", "hardened"] as const;
export type SelfServeKind = (typeof SELF_SERVE_KINDS)[number];

/** What each design is, in a line, for the onboarding page. */
export const SELF_SERVE_KIND_LABELS: Record<SelfServeKind, string> = {
  vulnerable: "Vulnerable: acts on instructions it reads; no guard",
  partial: "Partial (Agent A): the full guard except it checks addresses by their ends only",
  hardened: "Hardened: treats what it reads as data; full guard",
};

/**
 * The operator's own agent (bring your own agent, docs/BRING-YOUR-OWN-AGENT.md): any code, run
 * wherever the operator runs it, rated through the Arena Gateway by `@bonded/runner`.
 */
export const REMOTE_KIND = "remote";
/** A built-in design, or the operator's own agent. */
export type SelfServeAgentKind = SelfServeKind | typeof REMOTE_KIND;

/**
 * How the operator's agent acts during a rating:
 * - tools: reads and writes are tool calls (MCP or plain HTTP);
 * - chain: reads are tool calls, writes are transactions it signs and sends to its vault.
 */
export const REMOTE_MODES = ["tools", "chain"] as const;
export type RemoteMode = (typeof REMOTE_MODES)[number];

/** What the operator declares about their agent when registering it. */
export interface RemoteAgentSpec {
  /** The operator's own hash of the code that runs (an image digest or a git commit, as 32 bytes). */
  codeHash: string;
  mode: RemoteMode;
  /** Where the agent runs in a TEE, and the compose hash published for that deployment. */
  tee?: { url: string; composeHash: string };
}

/** A signed request is accepted for this long after it was signed, in seconds. */
export const SELF_SERVE_MAX_AGE_SECONDS = 10 * 60;

/** Largest cover a quote without the operator token can ask for, in tUSDG (testnet cap). */
export const SELF_SERVE_MAX_COVER_USD = 20_000;

export type SelfServeRequest =
  | {
      action: "register";
      chainId: number;
      agentId: string;
      vault: string;
      kind: SelfServeKind;
      mandateHash: string;
      /** Rate the agent with Sentinel in front of it (docs/SENTINEL.md). */
      sentinel?: boolean;
      timestamp: number;
    }
  | {
      action: "register";
      chainId: number;
      agentId: string;
      vault: string;
      kind: typeof REMOTE_KIND;
      mandateHash: string;
      remote: RemoteAgentSpec;
      timestamp: number;
    }
  | { action: "rate"; chainId: number; agentId: string; timestamp: number }
  /** Create a runner token for the agent (it replaces the agent's current one). */
  | { action: "runner-token"; chainId: number; agentId: string; timestamp: number }
  /** Revoke the agent's runner token: a connected runner is disconnected. */
  | { action: "revoke-runner-token"; chainId: number; agentId: string; timestamp: number };

const TITLES: Record<SelfServeRequest["action"], string> = {
  register: "register agent for ratings",
  rate: "rate agent",
  "runner-token": "create runner token",
  "revoke-runner-token": "revoke runner token",
};

/** The exact text the owner signs. Addresses and hashes are lowercased so case can't differ. */
export function selfServeMessage(request: SelfServeRequest): string {
  const lines = [
    `Bonded: ${TITLES[request.action]}`,
    `chain ${request.chainId}`,
    `agent ${request.agentId}`,
  ];
  if (request.action === "register") {
    lines.push(
      `vault ${request.vault.toLowerCase()}`,
      `design ${request.kind}`,
      `mandate ${request.mandateHash.toLowerCase()}`,
    );
    if (request.kind === REMOTE_KIND) {
      const { codeHash, mode, tee } = request.remote;
      lines.push(`code ${codeHash.toLowerCase()}`, `mode ${mode}`);
      // The TEE's URL is signed exactly as sent; only its compose hash is lowercased.
      if (tee) lines.push(`tee ${tee.url}`, `compose ${tee.composeHash.toLowerCase()}`);
    }
    // Only when chosen, so a registration signed before this option reads the same.
    else if (request.sentinel) lines.push("sentinel on");
  }
  lines.push(`time ${request.timestamp}`);
  return lines.join("\n");
}
