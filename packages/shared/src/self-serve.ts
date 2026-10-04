/**
 * Self-serve requests (docs/PLAN.md, Day 14 workstream 7): the messages an agent's owner signs
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
      timestamp: number;
    }
  | { action: "rate"; chainId: number; agentId: string; timestamp: number };

/** The exact text the owner signs. Addresses and hashes are lowercased so case can't differ. */
export function selfServeMessage(request: SelfServeRequest): string {
  const lines = [
    `Bonded: ${request.action === "register" ? "register agent for ratings" : "rate agent"}`,
    `chain ${request.chainId}`,
    `agent ${request.agentId}`,
  ];
  if (request.action === "register")
    lines.push(
      `vault ${request.vault.toLowerCase()}`,
      `design ${request.kind}`,
      `mandate ${request.mandateHash.toLowerCase()}`,
    );
  lines.push(`time ${request.timestamp}`);
  return lines.join("\n");
}
