import { parse, stringify } from "yaml";
import {
  ARENA_TOKENS,
  ATTACK_CLASSES,
  BreachType,
  Severity,
  type AttackClassId,
} from "@bondedhq/shared";

/**
 * The bounty spec as a form (Bounties page, Form mode). The YAML is still what gets hashed,
 * committed and checked: the form only writes it (`formToYaml`) and reads it back (`yamlToForm`),
 * so switching between Form and YAML never changes what's submitted.
 */
export interface SpecForm {
  attackClass: AttackClassId;
  /** The id after the class: "fake-auditor-001" makes "A6-fake-auditor-001". */
  name: string;
  title: string;
  description: string;
  surfaces: string[];
  /** Who it appears to come from; a tx_history attack needs an address placeholder here. */
  sender: string;
  /** token_metadata: the token whose details carry the payload. */
  token: string;
  /** price_feed: the prices the feed reports instead of the oracle's. */
  prices: { token: string; price: string }[];
  payload: string;
  breaches: string[];
  severity: string;
  variantPrompt: string;
  /** Comma-separated. */
  tags: string;
}

export const BREACH_TYPES = BreachType.options;
export const SEVERITIES = Severity.options;

export function emptyForm(attackClass: AttackClassId = "A6"): SpecForm {
  return {
    attackClass,
    name: "",
    title: "",
    description: "",
    surfaces: [ATTACK_CLASSES[attackClass].surfaces[0]!],
    sender: "",
    token: "",
    prices: [],
    payload: "",
    breaches: ["T1_UNAUTHORIZED_TRANSFER"],
    severity: "high",
    variantPrompt: "",
    tags: "",
  };
}

/** A class change keeps only the surfaces the new class allows, and at least one. */
export function withClass(form: SpecForm, attackClass: AttackClassId): SpecForm {
  const allowed = ATTACK_CLASSES[attackClass].surfaces as readonly string[];
  const surfaces = form.surfaces.filter((s) => allowed.includes(s));
  return { ...form, attackClass, surfaces: surfaces.length ? surfaces : [allowed[0]!] };
}

/** "Fake Auditor 001!" → "fake-auditor-001". */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The YAML the form stands for. Empty fields are left out, so the spec check names them. */
export function formToYaml(f: SpecForm): string {
  const prices = f.prices.filter((p) => p.token.trim() && p.price.trim());
  const delivery = {
    ...(f.sender.trim() ? { sender: f.sender.trim() } : {}),
    ...(f.surfaces.includes("token_metadata") && f.token ? { token: f.token } : {}),
    ...(f.surfaces.includes("price_feed") && prices.length
      ? { prices: Object.fromEntries(prices.map((p) => [p.token.trim(), Number(p.price)])) }
      : {}),
  };
  const tags = f.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return stringify({
    id: `${f.attackClass}-${slug(f.name) || "my-attack-001"}`,
    class: f.attackClass,
    title: f.title,
    description: f.description,
    surfaces: f.surfaces,
    ...(Object.keys(delivery).length ? { delivery } : {}),
    payloadTemplate: f.payload,
    successPredicate: { anyOf: f.breaches },
    severityHint: f.severity,
    variantPrompt: f.variantPrompt,
    ...(tags.length ? { tags } : {}),
  });
}

const FORM_KEYS = new Set([
  "id",
  "class",
  "title",
  "description",
  "surfaces",
  "delivery",
  "payloadTemplate",
  "successPredicate",
  "severityHint",
  "variantPrompt",
  "tags",
]);

/**
 * The form for some YAML, or why the form can't show it (so the page stays in YAML mode and
 * nothing written is lost). An empty editor is an empty form.
 */
export function yamlToForm(yaml: string): { form: SpecForm } | { error: string } {
  if (!yaml.trim()) return { form: emptyForm() };
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch {
    return { error: "it isn't valid YAML yet" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { error: "it isn't a spec (a set of fields)" };
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !FORM_KEYS.has(k));
  if (extra.length) return { error: `it has fields the form doesn't: ${extra.join(", ")}` };
  const cls = r.class;
  if (typeof cls !== "string" || !(cls in ATTACK_CLASSES))
    return { error: "its class isn't one of A1 to A10" };
  const attackClass = cls as AttackClassId;
  const text = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : String(v));
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const id = text(r.id);
  const delivery = (r.delivery ?? {}) as Record<string, unknown>;
  if (typeof delivery !== "object" || Array.isArray(delivery))
    return { error: "its delivery isn't a set of fields" };
  const deliveryExtra = Object.keys(delivery).filter(
    (k) => !["sender", "token", "prices"].includes(k),
  );
  if (deliveryExtra.length)
    return { error: `its delivery has fields the form doesn't: ${deliveryExtra.join(", ")}` };
  const prices = delivery.prices as Record<string, unknown> | undefined;
  const predicate = (r.successPredicate ?? {}) as { anyOf?: unknown };
  return {
    form: {
      attackClass,
      name: id.startsWith(`${attackClass}-`) ? id.slice(attackClass.length + 1) : id,
      title: text(r.title),
      description: text(r.description),
      surfaces: list(r.surfaces),
      sender: text(delivery.sender),
      token: text(delivery.token),
      prices:
        prices && typeof prices === "object"
          ? Object.entries(prices).map(([token, price]) => ({ token, price: String(price) }))
          : [],
      payload: text(r.payloadTemplate),
      breaches: list(predicate.anyOf),
      severity: text(r.severityHint) || "high",
      variantPrompt: text(r.variantPrompt),
      tags: list(r.tags).join(", "),
    },
  };
}

/** Tokens the Arena lists, for the token and price pickers. */
export const TOKENS = ARENA_TOKENS;
