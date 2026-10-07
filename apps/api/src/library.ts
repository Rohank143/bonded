import type { Hono } from "hono";
import { z } from "zod";
import { PAGE_LIMIT, type AttackStats, type Database } from "@bonded/db";
import { isHeldOutId, loadAttackLibrary } from "@bonded/arena";
import {
  AttackClassId,
  AttackSpec,
  AttackSurface,
  BountySpecError,
  Severity,
  parseBountySpec,
} from "@bonded/shared";
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

/** The API's request body limit (index.ts) and the most specs one upload takes. */
export const MAX_BODY_BYTES = 16_384;
export const MAX_UPLOAD_SPECS = 10;

/**
 * Split held-out specs into uploads that each fit the API's body limit, measured as the request's
 * UTF-8 bytes (JSON escaping included), and its spec count. A spec too large to send on its own
 * is an error naming it.
 */
export function uploadBatches(
  specs: readonly string[],
  retireAfter: string,
  names: readonly string[] = specs.map((_, i) => `spec ${i}`),
): string[][] {
  const bytes = (batch: readonly string[]) =>
    Buffer.byteLength(JSON.stringify({ specs: batch, retireAfter }), "utf8");
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const [i, spec] of specs.entries()) {
    if (bytes([spec]) > MAX_BODY_BYTES)
      throw new Error(
        `${names[i]} is too large to upload on its own (over ${MAX_BODY_BYTES} bytes)`,
      );
    if (batch.length === MAX_UPLOAD_SPECS || bytes([...batch, spec]) > MAX_BODY_BYTES) {
      batches.push(batch);
      batch = [];
    }
    batch.push(spec);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

const attacksQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT.max).optional(),
  class: AttackClassId.optional(),
  surface: AttackSurface.optional(),
  severity: Severity.optional(),
  sort: z.enum(["class", "breaches", "rate"]).optional(),
});

const NO_STATS: AttackStats = { episodes: 0, breaches: 0, runs: 0, lastAt: null };
const classOrder = (id: string) => Number(id.slice(1, id.indexOf("-")));

/** An attack in the red team list: everything but the planted text and the variant guidance. */
export function attackSummary(a: AttackSpec, stats: AttackStats) {
  return {
    id: a.id,
    class: a.class,
    title: a.title,
    description: a.description,
    surfaces: a.surfaces,
    severity: a.severityHint,
    tags: a.tags,
    stats,
  };
}

/**
 * The published attacks, filtered and sorted, as one numbered page. By class (then id), by
 * breaches, or by breach rate (attacks with no episodes last).
 */
export function pageOfAttacks(
  library: readonly AttackSpec[],
  stats: ReadonlyMap<string, AttackStats>,
  q: z.infer<typeof attacksQuery>,
) {
  const of = (a: AttackSpec) => stats.get(a.id) ?? NO_STATS;
  const rate = (a: AttackSpec) => (of(a).episodes ? of(a).breaches / of(a).episodes : -1);
  const kept = library
    .filter(
      (a) =>
        (!q.class || a.class === q.class) &&
        (!q.surface || a.surfaces.includes(q.surface)) &&
        (!q.severity || a.severityHint === q.severity),
    )
    .sort((x, y) =>
      q.sort === "breaches"
        ? of(y).breaches - of(x).breaches || x.id.localeCompare(y.id)
        : q.sort === "rate"
          ? rate(y) - rate(x) || of(y).episodes - of(x).episodes || x.id.localeCompare(y.id)
          : classOrder(x.id) - classOrder(y.id) || x.id.localeCompare(y.id),
    );
  const limit = q.limit ?? PAGE_LIMIT.default;
  const pages = Math.max(1, Math.ceil(kept.length / limit));
  const page = Math.min(q.page ?? 1, pages);
  return {
    items: kept.slice((page - 1) * limit, page * limit).map((a) => attackSummary(a, of(a))),
    page,
    pages,
    total: kept.length,
  };
}

const upload = z.strictObject({
  /** Each held-out attack's YAML, as pnpm heldout:generate wrote it (16 KB a request in all). */
  specs: z.array(z.string().min(1).max(4_000)).min(1).max(MAX_UPLOAD_SPECS),
  /** When this set retires (ISO date): between a day and a year from now. */
  retireAfter: z.iso.datetime(),
});

/**
 * GET /library: what ratings run, as counts only (never a held-out payload or id).
 * GET /library/attacks: the published attacks, a numbered page with each one's Arena record.
 * GET /library/attacks/:id: one published attack in full, planted text included. Held-out and
 * bounty attacks are never listed here: an unpublished id is "not found", like any other.
 * POST /library/held-out: upload a held-out set (operator token; see index.ts).
 */
export function libraryRoutes(
  app: Hono,
  options: { db: Database; chainId: number; statsCacheMs?: number },
) {
  const { db, chainId } = options;
  // The published library is the repo's files; it changes only with a deploy.
  const library = loadAttackLibrary();
  // Stats scan the episodes on record, so one read serves every visitor for a minute.
  const statsCacheMs = options.statsCacheMs ?? 60_000;
  let cached: { at: number; value: Awaited<ReturnType<Database["attackStats"]>> } | undefined;
  const attackStats = async () => {
    if (!cached || Date.now() - cached.at >= statsCacheMs)
      cached = { at: Date.now(), value: await db.attackStats(library.map((a) => a.id)) };
    return cached.value;
  };
  app.get("/library/attacks", async (c) => {
    const q = attacksQuery.parse(c.req.query());
    const { stats, since } = await attackStats();
    return c.json({
      ...pageOfAttacks(library, stats, q),
      statsSince: since?.toISOString() ?? null,
    });
  });
  app.get("/library/attacks/:id", async (c) => {
    const attack = library.find((a) => a.id === c.req.param("id"));
    if (!attack) return c.json({ error: "attack not found" }, 404);
    const { stats, since } = await attackStats();
    return c.json({
      attack,
      stats: stats.get(attack.id) ?? NO_STATS,
      statsSince: since?.toISOString() ?? null,
    });
  });
  app.get("/library", async (c) => {
    const published = library.length;
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
