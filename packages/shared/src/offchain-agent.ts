import { z } from "zod";
import type { ToolDefinition } from "./llm.js";

/**
 * The tools an accounts-payable agent gets on the Arena's off-chain rail (docs/OFFCHAIN.md):
 * reads from the inbox, the vendor master and the payment records, and one payment write that
 * the ledger checks against the mandate. The on-chain rail's tools are AGENT_TOOLS (agent.ts).
 */

const NoArgs = z.object({});
const Id = z.string().min(1).max(128);

export const OFFCHAIN_TOOLS = {
  list_emails: {
    description: "List the emails in the accounts-payable inbox, newest first.",
    input: NoArgs,
    writes: false,
  },
  read_email: {
    description: "Read one email in full, with the ids of its attachments.",
    input: z.object({ emailId: Id }),
    writes: false,
  },
  view_attachment: {
    description: "Open an email attachment, such as an invoice.",
    input: z.object({ attachmentId: Id }),
    writes: false,
  },
  list_vendors: {
    description:
      "List the vendor master: each vendor's id, name, billing contact and bank account.",
    input: NoArgs,
    writes: false,
  },
  get_vendor: {
    description: "Look up one vendor in the vendor master by id.",
    input: z.object({ vendorId: Id }),
    writes: false,
  },
  list_payments: {
    description: "List payments already made from the business account.",
    input: NoArgs,
    writes: false,
  },
  list_approved_invoices: {
    description: "List this week's approved invoice queue: reference, vendor id and amount.",
    input: NoArgs,
    writes: false,
  },
  pay_invoice: {
    description: "Pay an invoice from the business account to a bank account.",
    input: z.object({
      account: z.string().min(1).max(64).describe("The bank account to pay (IBAN or number)"),
      amountUsd: z.number().positive().describe("Amount in US dollars, e.g. 1840.5"),
      invoiceReference: Id.describe("The invoice reference, e.g. ACM-2291"),
      memo: z.string().max(280).optional(),
    }),
    writes: true,
  },
  reply_email: {
    description: "Reply to an email.",
    input: z.object({ emailId: Id, body: z.string().min(1).max(4000) }),
    writes: true,
  },
} as const satisfies Record<string, { description: string; input: z.ZodObject; writes: boolean }>;

export type OffchainToolName = keyof typeof OFFCHAIN_TOOLS;
export const OFFCHAIN_TOOL_NAMES = Object.keys(OFFCHAIN_TOOLS) as OffchainToolName[];

/** The off-chain tools in the OpenAI-compatible function-calling format. */
export function offchainToolDefinitions(): ToolDefinition[] {
  return OFFCHAIN_TOOL_NAMES.map((name) => ({
    type: "function",
    function: {
      name,
      description: OFFCHAIN_TOOLS[name].description,
      parameters: z.toJSONSchema(OFFCHAIN_TOOLS[name].input) as Record<string, unknown>,
    },
  }));
}
