import {
  pgTable,
  boolean,
  text,
  integer,
  numeric,
  jsonb,
  uuid,
  timestamp,
  bigserial,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const agents = pgTable(
  "agents",
  {
    id: text().primaryKey(),
    chainId: integer("chain_id").notNull(),
    agentId: numeric("agent_id", { precision: 78, scale: 0 }).notNull(),
    config: jsonb().notNull(),
    enabled: boolean().notNull().default(true),
  },
  (t) => [unique().on(t.chainId, t.agentId)],
);
export const ratings = pgTable("ratings", {
  id: uuid().primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  status: text().notNull().default("queued"),
  report: jsonb(),
  reportJson: text("report_json"),
  attestation: jsonb(),
  error: text(),
  createdAt: created(),
});
export const attestations = pgTable("attestations", {
  id: uuid()
    .primaryKey()
    .references(() => ratings.id),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  signed: jsonb().notNull(),
  txHash: text("tx_hash").notNull(),
  createdAt: created(),
});
export const quotes = pgTable("quotes", {
  id: uuid().primaryKey(),
  chainId: integer("chain_id").notNull(),
  agentId: text("agent_id").notNull(),
  signed: jsonb().notNull(),
  createdAt: created(),
});
export const jobs = pgTable("jobs", {
  id: uuid()
    .primaryKey()
    .references(() => ratings.id),
  status: text().notNull().default("queued"),
  attempts: integer().notNull().default(0),
  token: uuid(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
});
export const keeperCursors = pgTable("keeper_cursors", {
  chainId: integer("chain_id").primaryKey(),
  blockNumber: numeric("block_number", { precision: 78, scale: 0 }).notNull(),
  blockHash: text("block_hash").notNull(),
});
export const keeperVaults = pgTable(
  "keeper_vaults",
  { chainId: integer("chain_id").notNull(), address: text().notNull() },
  (t) => [primaryKey({ columns: [t.chainId, t.address] })],
);
export const keeperPolicies = pgTable(
  "keeper_policies",
  {
    chainId: integer("chain_id").notNull(),
    policyId: numeric("policy_id", { precision: 78, scale: 0 }).notNull(),
    vault: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.policyId] })],
);
export const handledEvents = pgTable("handled_events", {
  id: text().primaryKey(),
  chainId: integer("chain_id").notNull(),
  vault: text().notNull(),
  breachId: numeric("breach_id", { precision: 78, scale: 0 }).notNull(),
  status: text().notNull().default("pending"),
  txHash: text("tx_hash"),
  error: text(),
});
export const events = pgTable("events", {
  id: bigserial({ mode: "bigint" }).primaryKey(),
  topic: text().notNull(),
  payload: jsonb().notNull(),
  createdAt: created(),
});
