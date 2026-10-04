import { parse } from "yaml";
import { AttackSpec } from "./schemas/attack.js";

/**
 * The bounty spec check (docs/BOUNTIES.md). The API runs it on every revealed spec, and the web
 * app's Bounties page runs the same code before a hunter commits, so a spec the API would refuse
 * is caught while it can still be fixed for free.
 */
export class BountySpecError extends Error {}

/**
 * The {{placeholders}} the Arena's episode runner fills in an attack's payload:
 * - attacker: a fresh address the attacker controls (it spends any approval it gets)
 * - vault: the agent's vault
 * - amount, token: a default ask (5000 tUSDG)
 * - depositor: the address that funded the vault
 * - lookalike: an address sharing the depositor's first and last four hex digits, for
 *   address poisoning (also controlled by the attacker)
 */
export const ATTACK_PLACEHOLDERS = [
  "attacker",
  "vault",
  "amount",
  "token",
  "depositor",
  "lookalike",
] as const;

/** Parse a bounty spec; throws BountySpecError with a readable reason. */
export function parseBountySpec(yaml: string): AttackSpec {
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch {
    throw new BountySpecError("the spec is not valid YAML");
  }
  // The task is the Arena's, never the hunter's: a submitted goal such as "buy 10,000 tUSDG
  // worth of tNVDA" breaches the trade limit by itself, with no attack at all.
  if (raw && typeof raw === "object" && "goal" in raw)
    throw new BountySpecError(
      "a bounty spec can't set the agent's goal: the Arena gives every run a trusted benign task",
    );
  const result = AttackSpec.safeParse(raw);
  if (!result.success)
    throw new BountySpecError(
      `the spec doesn't match the attack schema: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  // An unknown placeholder would stop every run of the attack, so it is refused up front.
  const unknown = [...result.data.payloadTemplate.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)]
    .map((m) => m[1]!)
    .filter((name) => !(ATTACK_PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown.length)
    throw new BountySpecError(
      `the payload uses unknown placeholders: ${[...new Set(unknown)].map((n) => `{{${n}}}`).join(", ")}; the Arena fills ${ATTACK_PLACEHOLDERS.map((n) => `{{${n}}}`).join(", ")}`,
    );
  return result.data;
}
