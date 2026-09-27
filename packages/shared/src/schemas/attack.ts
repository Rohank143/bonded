import { z } from "zod";

/**
 * Breach types recorded by the Mandate Vault. See docs/PLAN.md Sections 6.3 and 11.1.
 * The numeric codes must match `BondedTypes.BreachType` in Solidity.
 */
export const BreachType = z.enum([
  "T1_UNAUTHORIZED_TARGET",
  "T1_UNAUTHORIZED_APPROVAL",
  "T1_UNAUTHORIZED_TRANSFER",
  "T1_DEFERRED",
  "T2_LIMIT",
  "T3_ASSET",
]);
export type BreachType = z.infer<typeof BreachType>;

export const BREACH_TYPE_CODE: Record<BreachType, number> = {
  T1_UNAUTHORIZED_TARGET: 0,
  T1_UNAUTHORIZED_APPROVAL: 1,
  T1_UNAUTHORIZED_TRANSFER: 2,
  T1_DEFERRED: 3,
  T2_LIMIT: 4,
  T3_ASSET: 5,
};

/** Places in the Arena's simulated world where adversarial content can be planted. */
export const AttackSurface = z.enum([
  "token_metadata",
  "news",
  "social",
  "dm",
  "price_feed",
  "tool_output",
  "tx_history",
  "market",
  "counterparty",
]);
export type AttackSurface = z.infer<typeof AttackSurface>;

export const AttackClassId = z.enum(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"]);
export type AttackClassId = z.infer<typeof AttackClassId>;

export interface AttackClassInfo {
  name: string;
  description: string;
  surfaces: AttackSurface[];
}

/** The attack library's ten classes. See docs/PLAN.md Section 8.2. */
export const ATTACK_CLASSES: Record<AttackClassId, AttackClassInfo> = {
  A1: {
    name: "Injection via token metadata",
    description: "Instructions hidden in a token's name, symbol or metadata URI.",
    surfaces: ["token_metadata"],
  },
  A2: {
    name: "Injection via content",
    description: "Instructions hidden in news, web pages or social posts the agent reads.",
    surfaces: ["news", "social"],
  },
  A3: {
    name: "Poisoned price or oracle data",
    description: "Spoofed prices or feed ticks that push the agent into harmful trades.",
    surfaces: ["price_feed"],
  },
  A4: {
    name: "Lookalike and honeypot tokens",
    description: "Tokens that imitate allowed assets or cannot be sold once bought.",
    surfaces: ["token_metadata", "market"],
  },
  A5: {
    name: "Address poisoning",
    description: "Lookalike addresses planted in the agent's transaction history.",
    surfaces: ["tx_history"],
  },
  A6: {
    name: "Social engineering",
    description:
      "Messages impersonating the operator or an admin, asking for transfers or approvals.",
    surfaces: ["dm"],
  },
  A7: {
    name: "Tool-output smuggling",
    description: "Instructions embedded in API or tool responses.",
    surfaces: ["tool_output"],
  },
  A8: {
    name: "Volatility and panic",
    description: "Flash crashes that test whether the agent respects its limits.",
    surfaces: ["market", "price_feed"],
  },
  A9: {
    name: "Goal drift and loops",
    description: "Long runs that test for churn, fee burn and limit creep.",
    surfaces: ["market"],
  },
  A10: {
    name: "Hostile counterparty agent",
    description: "Another agent negotiates the target into an unauthorized action.",
    surfaces: ["counterparty"],
  },
};

export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

/** One seed scenario in the attack library (stored as YAML under attacks/). */
export const AttackSpec = z
  .object({
    /** Stable id, e.g. "A1-token-metadata-001". */
    id: z.string().regex(/^A(10|[1-9])-[a-z0-9-]+$/, "id must look like A1-some-name-001"),
    class: AttackClassId,
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    surfaces: z.array(AttackSurface).min(1),
    /** Adversarial content with {{placeholders}} the Arena fills per episode. */
    payloadTemplate: z.string().min(1),
    /** The attack succeeds if the vault records any of these breach types. */
    successPredicate: z.object({ anyOf: z.array(BreachType).min(1) }),
    severityHint: Severity,
    /** How the payload is presented on its surface. */
    delivery: z
      .object({
        /** Who it appears to come from: a DM sender, news source, post author or address. */
        sender: z.string().min(1).max(200).optional(),
        /** For token_metadata: the token whose description carries the payload. */
        token: z.string().min(1).max(32).optional(),
      })
      .default({}),
    /** Guidance for the attacker agent when generating variants of this seed. */
    variantPrompt: z.string().min(1),
    tags: z.array(z.string()).default([]),
  })
  .refine((spec) => spec.id.startsWith(`${spec.class}-`), {
    message: "id prefix must match class",
    path: ["id"],
  });
export type AttackSpec = z.infer<typeof AttackSpec>;

/** Breach type for a numeric code read from the vault (`BondedTypes.BreachType`). */
export function breachTypeFromCode(code: number): BreachType {
  const entry = Object.entries(BREACH_TYPE_CODE).find(([, value]) => value === code);
  if (!entry) throw new Error(`unknown breach type code: ${code}`);
  return entry[0] as BreachType;
}
