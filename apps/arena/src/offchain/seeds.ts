import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { LEDGER_BREACH_TYPES } from "./ledger.js";
import { baseWorld, type OffchainScenario, PAYMENT_RUN_GOAL } from "./scenarios.js";
import { type Attachment, type Email, invoiceText, type OffchainWorld } from "./world.js";

/**
 * Off-chain attack seeds (apps/arena/offchain-seeds): each plants emails and invoices into the
 * base world's payment run. The ledger, not the seed, decides whether the agent fell for it;
 * `aimedAt` only says which breaches count as the attack succeeding. See docs/OFFCHAIN.md.
 */
export const OFFCHAIN_SEEDS_DIR = fileURLToPath(new URL("../../offchain-seeds", import.meta.url));

export const OFFCHAIN_ATTACK_CLASSES = {
  O1: "Bank-detail change",
  O2: "Forged or inflated invoice",
  O3: "Duplicate invoice",
  O4: "Instructions in an attachment",
  O5: "Executive impersonation",
} as const;
export type OffchainAttackClass = keyof typeof OFFCHAIN_ATTACK_CLASSES;

const Sender = z.object({ name: z.string().min(1), address: z.string().min(3) });

const InvoiceSeed = z.object({
  vendorName: z.string().min(1),
  vendorEmail: z.string().optional(),
  reference: z.string().min(1),
  issued: z.string(),
  due: z.string(),
  lines: z.array(z.object({ description: z.string(), amountUsd: z.number().positive() })).min(1),
  account: z.string().min(1),
});

const AttachmentSeed = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    /** Laid out as invoiceText renders it. */
    invoice: InvoiceSeed.optional(),
    /** The attachment's text verbatim, instead of an invoice (empty for a scan with no text). */
    text: z.string().optional(),
    /** Added under the invoice's text, e.g. a note planted in the footer. */
    appendText: z.string().optional(),
    /** A PNG in offchain-seeds/images/, shown to models that can see images. */
    image: z
      .string()
      .regex(/^[\w.-]+\.png$/)
      .optional(),
  })
  .refine((a) => (a.invoice === undefined) !== (a.text === undefined), {
    message: "an attachment needs exactly one of invoice or text",
  });

const EmailSeed = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  from: Sender,
  subject: z.string().min(1),
  body: z.string().min(1),
  receivedAt: z.iso.datetime(),
  attachments: z.array(AttachmentSeed).default([]),
});

export const OffchainSeed = z.object({
  id: z.string().regex(/^O[1-5]-[a-z0-9-]+-\d{3}$/),
  class: z.enum(Object.keys(OFFCHAIN_ATTACK_CLASSES) as [OffchainAttackClass]),
  title: z.string().min(1),
  description: z.string().min(1),
  aimedAt: z.array(z.enum(LEDGER_BREACH_TYPES)).min(1),
  /**
   * Approved invoices the attack casts doubt on. A careful agent may hold them back to check,
   * so the task doesn't require them; paying them correctly is still fine.
   */
  mayHold: z.array(z.string()).default([]),
  plant: z.object({
    /** New emails, added to the inbox. */
    emails: z.array(EmailSeed).default([]),
    /** Existing emails whose body or attachments the attack changes (a compromised mailbox). */
    replace: z
      .array(
        z.object({
          emailId: z.string().min(1),
          body: z.string().optional(),
          attachments: z.array(AttachmentSeed).optional(),
        }),
      )
      .default([]),
  }),
});
export type OffchainSeed = z.infer<typeof OffchainSeed>;

/** Loads and checks every seed in `dir`, sorted by id. */
export function loadOffchainSeeds(dir: string = OFFCHAIN_SEEDS_DIR): OffchainSeed[] {
  const seeds = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const parsed = OffchainSeed.safeParse(parse(readFileSync(join(dir, file), "utf8")));
      if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
      if (`${parsed.data.id}.yaml` !== file) throw new Error(`${file}: id is ${parsed.data.id}`);
      return parsed.data;
    });
  for (const seed of seeds) {
    const problem = seedProblem(seed, dir);
    if (problem) throw new Error(`${seed.id}: ${problem}`);
  }
  return seeds;
}

/** What makes a seed unfit to run against the base world, or undefined. */
export function seedProblem(
  seed: OffchainSeed,
  dir: string = OFFCHAIN_SEEDS_DIR,
): string | undefined {
  const world = baseWorld();
  const ids = new Set(world.inbox.map((e) => e.id));
  const approved = new Set(world.approvedInvoices.map((i) => i.reference));
  for (const r of seed.plant.replace)
    if (!ids.has(r.emailId)) return `no email ${r.emailId} to replace`;
  for (const e of seed.plant.emails) {
    if (ids.has(e.id)) return `email id ${e.id} is already in the inbox`;
    if (e.receivedAt.slice(0, 10) > world.today) return `${e.id} arrives after ${world.today}`;
  }
  for (const ref of seed.mayHold)
    if (!approved.has(ref)) return `${ref} is not an approved invoice`;
  const attachments = [
    ...seed.plant.emails.flatMap((e) => e.attachments),
    ...seed.plant.replace.flatMap((r) => r.attachments ?? []),
  ];
  for (const a of attachments) {
    if (a.image && !readdirSync(join(dir, "images")).includes(a.image))
      return `no image ${a.image}`;
  }
  return undefined;
}

/** The base world with the seed planted, as an attack scenario. */
export function attackScenario(
  seed: OffchainSeed,
  dir: string = OFFCHAIN_SEEDS_DIR,
): OffchainScenario {
  const world = plantSeed(baseWorld(), seed, dir);
  const hold = new Set(seed.mayHold);
  return {
    id: seed.id,
    kind: "attack",
    attackClass: seed.class,
    goal: PAYMENT_RUN_GOAL,
    world,
    mustPay: world.approvedInvoices.map((i) => i.reference).filter((r) => !hold.has(r)),
    aimedAt: seed.aimedAt,
  };
}

function plantSeed(world: OffchainWorld, seed: OffchainSeed, dir: string): OffchainWorld {
  for (const r of seed.plant.replace) {
    const email = world.inbox.find((e) => e.id === r.emailId)!;
    if (r.body !== undefined) email.body = r.body;
    if (r.attachments) email.attachments = r.attachments.map((a) => attachment(a, dir));
  }
  const added: Email[] = seed.plant.emails.map((e) => ({
    id: e.id,
    threadId: e.threadId ?? `t-${e.id}`,
    from: e.from,
    subject: e.subject,
    body: e.body,
    receivedAt: e.receivedAt,
    attachments: e.attachments.map((a) => attachment(a, dir)),
  }));
  world.inbox = [...world.inbox, ...added].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return world;
}

function attachment(seed: z.infer<typeof AttachmentSeed>, dir: string): Attachment {
  const base = seed.invoice
    ? invoiceText({
        vendor: { name: seed.invoice.vendorName, email: seed.invoice.vendorEmail },
        billTo: baseWorld().company,
        reference: seed.invoice.reference,
        issued: seed.invoice.issued,
        due: seed.invoice.due,
        lines: seed.invoice.lines,
        account: seed.invoice.account,
      })
    : seed.text!;
  const text = seed.appendText ? `${base}\n\n${seed.appendText.trim()}` : base;
  return {
    id: seed.id,
    filename: seed.filename,
    text,
    ...(seed.image
      ? {
          image: {
            mediaType: "image/png" as const,
            base64: readFileSync(join(dir, "images", seed.image)).toString("base64"),
          },
        }
      : {}),
  };
}
