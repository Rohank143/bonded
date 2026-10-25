import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AttackClassId, CampaignStep } from "@bondedhq/shared";
import { parse } from "yaml";
import { z } from "zod";
import { benignTrade } from "./goal-trade.js";

/**
 * Benign twins (apps/arena/benign-seeds): for an attack class, true content on the same surface
 * its attacks use, with a task that makes acting on it the job. A legitimate order from the
 * portfolio manager in the inbox, a real trading halt in the market alerts, a genuine queue in
 * the market report. The right outcome is doing what the content says, within the mandate.
 *
 * They measure the other side of the security grade: an agent that ignores everything it reads
 * is never tricked, but it can't do a job that depends on what it reads either. Their results go
 * into the Task score (task-score.ts), never into the security grade or the insurance score.
 */
export const BENIGN_SEEDS_DIR = fileURLToPath(new URL("../benign-seeds", import.meta.url));

/** The stock tokens a benign twin may buy: every one is in the demo mandate. */
const STOCK = z.enum(["tTSLA", "tAMZN", "tNVDA"]);

export const BenignSeed = z
  .object({
    id: z
      .string()
      .regex(/^B-A(?:10|[1-9])-[a-z0-9-]+-\d{3}$/, "id must look like B-A6-pm-order-001"),
    /** The attack class this seed is the benign twin of. */
    class: AttackClassId,
    title: z.string().min(1),
    description: z.string().min(1),
    /** The true content, one step per surface, planted like a campaign step. */
    steps: z.array(CampaignStep).min(1),
    goal: z.string().min(1),
    /**
     * What doing the job means, read from the chain after the episode: the vault holds at least
     * TASK_COMPLETION_SHARE of `buy` (valued at the oracle), and none of the `avoid` tokens (the
     * order the content replaced, or the options it ruled out).
     */
    expect: z.object({
      buy: z.object({ token: STOCK, amountUsd: z.number().positive().max(5_000) }),
      avoid: z.array(STOCK).default([]),
    }),
    tags: z.array(z.string()).default([]),
  })
  .superRefine((seed, ctx) => {
    if (seed.expect.avoid.includes(seed.expect.buy.token))
      ctx.addIssue({ code: "custom", message: "expect.avoid must not include the token to buy" });
    // The goal must not name the right order itself: an agent that never reads would pass.
    const standing = benignTrade(seed.goal);
    if (standing && standing.tokenOut.toLowerCase() === seed.expect.buy.token.toLowerCase())
      ctx.addIssue({
        code: "custom",
        message: "the goal names the expected buy; the content must",
      });
  });
export type BenignSeed = z.infer<typeof BenignSeed>;

/** Loads and validates every benign twin. Throws on any invalid file or duplicate id. */
export function loadBenignSeeds(dir: string = BENIGN_SEEDS_DIR): BenignSeed[] {
  const seeds: BenignSeed[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const result = BenignSeed.safeParse(parse(readFileSync(path, "utf8")));
    if (!result.success)
      throw new Error(`${path}: ${result.error.issues.map((i) => i.message).join("; ")}`);
    seeds.push(result.data);
  }
  const ids = seeds.map((s) => s.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`duplicate benign seed id ${duplicate}`);
  return seeds.sort((a, b) => a.id.localeCompare(b.id));
}
