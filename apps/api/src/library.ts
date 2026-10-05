import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "@bonded/db";
import { isHeldOutId, loadAttackLibrary } from "@bonded/arena";
import { AttackSpec, BountySpecError, parseBountySpec } from "@bonded/shared";
import { chainLibrary } from "./bounty-worker.js";

/**
 * The attack library a rating runs (issue #11, docs/decisions/007-ratings.md): the published seeds,
 * accepted bounties and the held-out set. Bounties and held-out attacks are never published, and
 * the report counts them, so a reader can see how much of a rating the operator couldn't study.
 * Bounty validation doesn't check against the held-out set: its rejection reason would tell a
 * hunter that a hidden attack is close to theirs.
 */
export async function ratingLibrary(
  db: Database,
  chainId: number,
  now = new Date(),
): Promise<{ attacks: AttackSpec[]; unpublished: Set<string> }> {
  const published = new Set(loadAttackLibrary().map((a) => a.id));
  const heldOut = (await db.activeHeldOutAttacks(chainId, now)).map((s) => AttackSpec.parse(s));
  const attacks = [...(await chainLibrary(db, chainId)), ...heldOut];
  return {
    attacks,
    unpublished: new Set(attacks.filter((a) => !published.has(a.id)).map((a) => a.id)),
  };
}

const upload = z.strictObject({
  /** Each held-out attack's YAML, as pnpm heldout:generate wrote it (the API takes 16 KB a request, so a few at a time). */
  specs: z.array(z.string().min(1).max(4_000)).min(1).max(10),
  /** When this set retires (ISO date): between a day and a year from now. */
  retireAfter: z.iso.datetime(),
});

/**
 * GET /library: what ratings run, as counts only (never a held-out payload or id).
 * POST /library/held-out: upload a held-out set (operator token; see index.ts).
 */
export function libraryRoutes(app: Hono, options: { db: Database; chainId: number }) {
  const { db, chainId } = options;
  app.get("/library", async (c) => {
    const published = loadAttackLibrary().length;
    const all = await chainLibrary(db, chainId);
    const heldOut = await db.heldOutSummary(chainId);
    return c.json({
      published,
      acceptedBounties: all.length - published,
      heldOut: {
        active: heldOut.active,
        retiresFrom: heldOut.retiresFrom ? heldOut.retiresFrom.toISOString() : null,
      },
    });
  });
  app.post("/library/held-out", async (c) => {
    const input = upload.parse(await c.req.json());
    const retireAfter = new Date(input.retireAfter);
    const days = (retireAfter.getTime() - Date.now()) / 86_400_000;
    if (!(days >= 1 && days <= 366))
      return c.json({ error: "retireAfter must be between a day and a year from now" }, 400);
    const specs: AttackSpec[] = [];
    for (const [i, yaml] of input.specs.entries()) {
      try {
        const spec = parseBountySpec(yaml);
        if (!isHeldOutId(spec.id))
          return c.json({ error: `spec ${i}: a held-out id looks like A6-held-out-1a2b3c4d` }, 400);
        specs.push(spec);
      } catch (e) {
        if (e instanceof BountySpecError) return c.json({ error: `spec ${i}: ${e.message}` }, 400);
        throw e;
      }
    }
    const added = await db.addHeldOutAttacks(chainId, specs, retireAfter);
    return c.json({ added, retireAfter: retireAfter.toISOString() }, 201);
  });
}
