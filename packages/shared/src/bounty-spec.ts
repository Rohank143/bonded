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

/**
 * The tokens listed in every Arena episode (apps/arena/src/vault.ts). An attack's delivery can
 * only name these: planting metadata or a price on any other token stops every run.
 */
export const ARENA_TOKENS = ["tUSDG", "tTSLA", "tAMZN", "tNVDA"] as const;

/** Whether the Arena lists `symbol`, ignoring case and the test-token "t" prefix (NVDA → tNVDA). */
export function isArenaToken(symbol: string): boolean {
  const wanted = symbol.toLowerCase();
  return ARENA_TOKENS.some((t) => t.toLowerCase() === wanted || t.toLowerCase() === `t${wanted}`);
}

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
  const spec = result.data;
  const problem = runProblem(spec);
  if (problem) throw new BountySpecError(problem);
  return spec;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
/** Placeholders that the Arena fills with an address. */
const ADDRESS_PLACEHOLDER = /^\{\{\s*(attacker|vault|depositor|lookalike)\s*\}\}$/;
/** A "SYMBOL=PRICE" line in a price_feed payload, as the Arena's world reads it. */
const PRICE_LINE = /^\s*([A-Za-z0-9]+)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/;

/**
 * What would stop every run of this attack in the Arena (apps/arena/src/world.ts), or undefined.
 * Each of these used to pass the check and then fail validation, so they're refused up front.
 */
function runProblem(spec: AttackSpec): string | undefined {
  const delivery = spec.delivery ?? {};
  const unknown = [spec.payloadTemplate, delivery.sender ?? ""]
    .flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))
    .filter((name) => !(ATTACK_PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown.length)
    return `the payload uses unknown placeholders: ${[...new Set(unknown)].map((n) => `{{${n}}}`).join(", ")}; the Arena fills ${ATTACK_PLACEHOLDERS.map((n) => `{{${n}}}`).join(", ")}`;
  const priceLines = spec.payloadTemplate
    .split("\n")
    .map((line) => PRICE_LINE.exec(line)?.[1])
    .filter((t): t is string => Boolean(t));
  const named = [
    ...(delivery.token ? [delivery.token] : []),
    ...Object.keys(delivery.prices ?? {}),
    ...(spec.surfaces.includes("price_feed") && !delivery.prices ? priceLines : []),
  ].filter((t) => !isArenaToken(t));
  if (named.length)
    return `the delivery names tokens the Arena doesn't list: ${[...new Set(named)].join(", ")}; it lists ${ARENA_TOKENS.join(", ")}`;
  if (
    spec.surfaces.includes("price_feed") &&
    Object.keys(delivery.prices ?? {}).length === 0 &&
    priceLines.length === 0
  )
    return 'a price_feed attack must set a price: delivery.prices, or "tNVDA=108" lines in the payload';
  if (
    spec.surfaces.includes("tx_history") &&
    !/^0x[0-9a-fA-F]{40}$/.test(delivery.sender ?? "") &&
    !ADDRESS_PLACEHOLDER.test(delivery.sender ?? "")
  )
    return "a tx_history attack needs delivery.sender set to an address, such as {{lookalike}}";
  return undefined;
}
