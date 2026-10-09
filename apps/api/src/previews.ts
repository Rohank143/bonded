import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  previewKey,
  type CheckConfig,
  type ConnectionCheckRecord,
  type ConnectionKind,
  type Database,
  type PreviewRecord,
  type RatedCode,
} from "@bonded/db";
import { REMOTE_KIND, bondedRegistryAbi, type AgentMode } from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import { Refused, handle } from "./refused.js";
import { RateLimiter, clientAddress } from "./rate-limit.js";
import type { SessionWallet } from "./sessions.js";
import { helloProblem, newRunnerToken, runnerTokenHash } from "./runners.js";
import {
  SECRET_KEY_MISSING,
  AGENT_SECRET_PREFIX,
  agentUrlContext,
  newSecret,
  type SecretBox,
} from "./secrets.js";
import {
  NEEDS_CHECK,
  urlCodeHash,
  type AgentUrlVerifier,
  type ConnectionCheckResult,
} from "./connections.js";
import {
  previewRatingPlan,
  previewRefusalMessage,
  type RemoteRatingPolicy,
} from "./remote-policy.js";
import { expectedRating, publishedLibrary } from "./self-serve.js";
import { PollStreams } from "./poll-stream.js";

/**
 * Bring your own agent, round 2 (docs/BRING-YOUR-OWN-AGENT.md): previews, Agent URLs, connection
 * checks, cost estimates and live progress. Every write here is made with an owner session
 * (sessions.ts) and is rate-limited; ownership is the preview's wallet, or the agent's owner in
 * the registry right now.
 */

/** Shown with every preview and its report. */
export const PREVIEW_LABEL = "Preview: not on chain, not insurable";

/** Hosts an Agent URL or webhook may not use: Bonded's own (its web app, API and gateway). */
export function ownDomainsFrom(urls: readonly (string | undefined)[]): string[] {
  const hosts = new Set<string>();
  for (const value of urls) {
    if (!value) continue;
    try {
      const host = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`).hostname;
      // A wildcard origin (bonded-*-team.vercel.app) blocks its parent domain's pattern only.
      hosts.add(host.toLowerCase().replace(/^\*\./, ""));
    } catch {
      /* not a URL: nothing to block */
    }
  }
  return [...hosts].filter(Boolean);
}

/**
 * Why `raw` can't be an Agent URL (or webhook), or undefined. Public HTTPS only, no credentials
 * or fragment, not one of Bonded's own hosts. Addresses are checked again when connecting
 * (safe-fetch), so a name that resolves to a private address is refused then.
 */
export function outboundUrlProblem(
  raw: string,
  ownDomains: readonly string[],
  allowLoopback = false,
): string | undefined {
  if (raw.length > 2048) return "the URL is over 2,048 characters";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "that isn't a URL";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))
    return "the URL must use https";
  if (url.username || url.password) return "the URL can't carry a user name or password";
  if (url.hash) return "the URL can't have a #fragment";
  if (!allowLoopback && (loopback || host.endsWith(".localhost") || host.endsWith(".internal")))
    return "the URL must be reachable on the public internet";
  for (const own of ownDomains) {
    const bare = own.replace(/^.*\*/, "");
    if (host === own || host.endsWith(`.${own}`) || (bare !== own && host.endsWith(bare)))
      return "the URL can't be one of Bonded's own";
  }
  return undefined;
}

export interface OwnerRouteOptions {
  db: Database;
  chain: ServiceChain;
  policy: RemoteRatingPolicy;
  wallet: SessionWallet;
  now: () => number;
  /** Writes per client address (and in all) per window. */
  writes: RateLimiter;
  /** Reads per client address per window. */
  reads: RateLimiter;
  secrets?: SecretBox;
  verifyAgentUrl: AgentUrlVerifier;
  ownDomains: readonly string[];
  gatewayUrl?: string;
  /** Agent URLs may be plain http on this machine (local demos and tests only). */
  allowLoopbackUrls?: boolean;
  streams: PollStreams;
}

/** An agent or a preview, as these routes act on it. */
interface Subject {
  key: string;
  kind: "preview" | "agent";
  /** The preview's id, or the on-chain agent id. */
  id: string;
  owner: string;
  mode: AgentMode;
  connection: ConnectionKind;
  declaredCode?: string;
  preview?: PreviewRecord;
}

const uuid = z.uuid();
const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());
const codeHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const previewInput = z.strictObject({
  mode: z.enum(["tools", "chain"]),
  connection: z.enum(["runner", "url"]).optional(),
  /** Advanced: the owner's own code hash. Without it the runner's or URL's reported one is used. */
  codeHash: codeHash.optional(),
});
const urlInput = z.strictObject({ url: z.string().min(1).max(2048) });
const pageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
/** At most this many Agent URL verifications per URL host per hour: each one calls out. */
const VERIFY_PER_HOST_HOURLY = 10;

export function ownerRoutes(app: Hono, options: OwnerRouteOptions) {
  const { db, chain, policy, now } = options;
  const chainId = chain.deployment.chainId;
  // Orders a preview's runner token requests (the session authenticates them): strictly
  // increasing, so two in the same millisecond don't look like a replay.
  let lastStamp = 0;
  const stamp = () => (lastStamp = Math.max(lastStamp + 1, now()));
  const verifies = new RateLimiter({
    perClient: VERIFY_PER_HOST_HOURLY,
    total: 500,
    windowMs: 3_600_000,
    now,
  });

  const write = async (c: Context) => {
    if (!options.writes.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "too many requests; try again in a few minutes");
    return options.wallet(c);
  };
  const read = async (c: Context) => {
    if (!options.reads.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "too many requests; try again in a few minutes");
    return options.wallet(c);
  };
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    const text = await c.req.text();
    return schema.parse(text ? JSON.parse(text) : {});
  };

  const ownerOf = async (agentId: string) =>
    (
      await chain.read.readContract({
        address: chain.deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "agentOwner",
        args: [BigInt(agentId)],
      })
    ).toLowerCase();

  /** The wallet's preview: another wallet's is "not found", so ids can't be probed. */
  async function previewOf(c: Context, wallet: string, live = false): Promise<Subject> {
    const id = uuid.safeParse(c.req.param("id"));
    const preview = id.success ? await db.preview(id.data) : undefined;
    if (!preview || preview.owner !== wallet || preview.chainId !== chainId)
      throw new Refused(404, "preview not found");
    if (live && preview.status === "stopped") throw new Refused(409, "this preview was stopped");
    return {
      key: previewKey(preview.id),
      kind: "preview",
      id: preview.id,
      owner: preview.owner,
      mode: preview.mode as AgentMode,
      connection: preview.connection,
      ...(preview.codeHash ? { declaredCode: preview.codeHash } : {}),
      preview,
    };
  }
  /** The wallet's registered own agent: the registry decides who owns it, now. */
  async function agentOf(c: Context, wallet: string): Promise<Subject> {
    const agentId = uint.parse(c.req.param("id"));
    const key = `${chainId}:${agentId}`;
    const record = await db.agentRecord(key);
    const config = record?.config as
      | { kind?: string; mode?: AgentMode; connection?: ConnectionKind; codeHash?: string }
      | undefined;
    if (!record?.enabled || record.source !== "user" || config?.kind !== REMOTE_KIND)
      throw new Refused(404, "this agent isn't registered as your own agent");
    if ((await ownerOf(agentId)) !== wallet || record.owner !== wallet)
      throw new Refused(403, "only the agent's owner can do that");
    return {
      key,
      kind: "agent",
      id: agentId,
      owner: wallet,
      mode: config.mode ?? "tools",
      connection: config.connection ?? "runner",
      ...(config.codeHash ? { declaredCode: config.codeHash } : {}),
    };
  }

  /** The code a check or rating of this subject is about now, and the connection's state. */
  async function connectionNow(subject: Subject) {
    const current = await db.currentConnection(subject.key, subject.connection);
    const code: RatedCode | undefined = subject.declaredCode
      ? { hash: subject.declaredCode, source: "declared" }
      : current.code;
    const config: CheckConfig = {
      mode: subject.mode,
      connection: subject.connection,
      credentialId: current.credentialId,
      codeHash: code?.hash ?? null,
    };
    return { current, code, config };
  }
  /** Why the subject can't be reached right now, in words for its owner, or undefined. */
  async function connectionProblem(subject: Subject): Promise<string | undefined> {
    const { current } = await connectionNow(subject);
    if (current.ready) return undefined;
    if (subject.connection === "url")
      return current.credentialId
        ? "Verify your Agent URL first: Bonded hasn't had an answer to its challenge yet."
        : "Set your Agent URL first.";
    if (!current.credentialId) return "Create a runner token first, then start the runner.";
    const status = await db.runnerStatus(subject.key);
    const wrongMode = status.runner?.mode
      ? helloProblem({ mode: subject.mode }, { mode: status.runner.mode })
      : undefined;
    return wrongMode
      ? `The runner is connected in the wrong mode: ${wrongMode}.`
      : "The runner isn't connected. Start it with the command on this page, then check again.";
  }

  const previewView = (p: PreviewRecord) => ({
    id: p.id,
    chainId: p.chainId,
    owner: p.owner,
    mode: p.mode,
    connection: p.connection,
    codeHash: p.codeHash,
    codeSource: p.codeHash ? "declared" : "auto",
    status: p.status,
    error: p.error,
    ratingId: p.ratingId,
    upgradedTo: p.upgradedTo,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    label: PREVIEW_LABEL,
    attested: false,
    insurable: false,
  });
  const checkView = (k: ConnectionCheckRecord) => ({
    checkId: k.id,
    status: k.status,
    mode: k.mode,
    connection: k.connection,
    codeHash: k.codeHash,
    codeSource: k.codeSource,
    result: k.result,
    createdAt: k.createdAt.toISOString(),
    startedAt: k.startedAt?.toISOString() ?? null,
    finishedAt: k.finishedAt?.toISOString() ?? null,
    eventsUrl: `/checks/${k.id}/events`,
  });
  /** The live Agent URL, never its secret. */
  async function agentUrlView(key: string) {
    const u = await db.agentUrl(key);
    return u
      ? {
          agentUrlId: u.id,
          url: u.url,
          verified: Boolean(u.verifiedAt),
          verifiedAt: u.verifiedAt?.toISOString() ?? null,
          version: u.version,
          codeHash: u.codeHash,
          createdAt: u.createdAt.toISOString(),
        }
      : null;
  }
  const previewPlan = () => {
    const library = publishedLibrary();
    const plan = previewRatingPlan(policy, {
      publishedAttacks: library.attacks,
      heldOut: library.classes * policy.heldOutPerClass,
    });
    return { maxEpisodes: plan.episodes, budgetSeconds: Math.round(plan.budgetMs / 1000) };
  };

  // Previews.

  /** Start a preview: no vault, no bond, no registration; the wallet's session is enough. */
  app.post(
    "/previews",
    handle(async (c) => {
      const wallet = await write(c);
      const input = await body(c, previewInput);
      const connection = input.connection ?? "runner";
      if (connection === "url" && !options.secrets) throw new Refused(409, SECRET_KEY_MISSING);
      const made = await db.createPreview(
        {
          chainId,
          owner: wallet,
          mode: input.mode,
          connection,
          ...(input.codeHash ? { codeHash: input.codeHash } : {}),
        },
        { nowMs: now(), perWalletDaily: policy.previewCreatesPerWalletDaily },
      );
      if ("refused" in made)
        throw new Refused(
          429,
          `at most ${policy.previewCreatesPerWalletDaily} previews a day per wallet; try again after ${made.nextAt.toISOString()}`,
        );
      return c.json({ preview: previewView(made), expectedRating: previewPlan() }, 201);
    }),
  );

  /** The wallet's previews, newest first. */
  app.get(
    "/previews",
    handle(async (c) => {
      const wallet = await read(c);
      const q = pageQuery.parse(c.req.query());
      const page = await db.previewsOf(wallet, chainId, q);
      return c.json({ ...page, items: page.items.map(previewView) });
    }),
  );

  /**
   * One preview with everything its page shows: the connection (runner or Agent URL, never a
   * secret), recent checks, its rating's progress and result, and what "Make it official" fills in.
   */
  app.get(
    "/previews/:id",
    handle(async (c) => {
      const wallet = await read(c);
      const subject = await previewOf(c, wallet);
      const preview = subject.preview!;
      const [runner, agentUrl, checks, rating, now_] = await Promise.all([
        subject.connection === "runner" ? db.runnerStatus(subject.key) : Promise.resolve(null),
        subject.connection === "url" ? agentUrlView(subject.key) : Promise.resolve(null),
        db.checksOf(subject.key),
        preview.ratingId ? ratingSummary(preview.ratingId) : Promise.resolve(null),
        connectionNow(subject),
      ]);
      const passing = await db.passingCheck(subject.key, now_.config);
      return c.json({
        preview: previewView(preview),
        runner: runner && {
          ...runner,
          problem: runner.runner?.mode
            ? (helloProblem({ mode: subject.mode }, { mode: runner.runner.mode }) ?? null)
            : null,
          gatewayUrl: options.gatewayUrl ?? null,
        },
        agentUrl,
        code: now_.code ?? null,
        checks: checks.map(checkView),
        passingCheck: passing ? checkView(passing) : null,
        rating: rating && {
          ...rating,
          reportUrl:
            rating.status === "done" || rating.status === "failed"
              ? `/previews/${preview.id}/report`
              : null,
        },
        expectedRating: previewPlan(),
        upgrade: upgradeOf(preview, agentUrl?.url ?? null, now_.code),
      });
    }),
  );

  /** What onboarding fills in from a preview ("Make it official"). */
  function upgradeOf(preview: PreviewRecord, url: string | null, code: RatedCode | undefined) {
    return {
      kind: REMOTE_KIND,
      mode: preview.mode,
      connection: preview.connection,
      agentUrl: preview.connection === "url" ? url : null,
      runner: preview.connection === "runner",
      // Declared code carries over as declared; reported code stays automatic (the runner or URL
      // reports it again for the official rating).
      codeHash: preview.codeHash,
      reportedCode: code && code.source !== "declared" ? code : null,
      previewId: preview.id,
      previewRatingId: preview.ratingId,
      note: "An official rating always runs again, attested, after you register the agent and stake its bond; this preview's report stays linked.",
    };
  }

  /** A rating's state for its owner: status, progress (counts only), and its result once done. */
  async function ratingSummary(runId: string) {
    const r = (
      await db.pool.query(
        `SELECT id,status,error,agent_caused,agent_report,code_hash,code_source,created_at,
           report->'scoring'->>'score' AS score, report->'scoring'->>'tier' AS tier,
           report->>'stoppedEarly' AS stopped
         FROM ratings WHERE id=$1`,
        [runId],
      )
    ).rows[0];
    if (!r) return null;
    const progress = await progressOf(runId, r.status);
    const over = r.status === "done" || r.status === "failed";
    return {
      runId: r.id,
      status: r.status,
      error: r.error,
      agentCaused: r.agent_caused,
      agentReport: r.agent_report,
      codeHash: r.code_hash,
      codeSource: r.code_source,
      createdAt: r.created_at.toISOString(),
      progress,
      // No score until the rating is over: an operator controls their agent live.
      ...(over && r.score !== null ? { score: Number(r.score), tier: r.tier } : {}),
    };
  }

  /** Stop a preview: a queued rating is cancelled, and its token and Agent URL stop working. */
  app.post(
    "/previews/:id/stop",
    handle(async (c) => {
      const wallet = await write(c);
      const subject = await previewOf(c, wallet);
      const stopped = await db.stopPreview(subject.id);
      if ("refused" in stopped)
        throw new Refused(409, "its rating is running; it stops at the first failed episode");
      return c.json({ stopped: true });
    }),
  );

  /** A preview's runner token, shown once (it replaces the preview's current one). */
  app.post(
    "/previews/:id/runner-token",
    handle(async (c) => {
      const wallet = await write(c);
      const subject = await previewOf(c, wallet, true);
      if (subject.connection !== "runner")
        throw new Refused(409, "this preview connects by Agent URL, not with a runner");
      const token = newRunnerToken();
      const made = await db.createRunnerToken(subject.key, {
        hash: runnerTokenHash(token),
        createdBy: wallet,
        // The session authenticates; the order of requests is the server's own.
        signedAt: stamp(),
      });
      if ("refused" in made) throw new Refused(409, "a newer token request came first; try again");
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          token,
          tokenId: made.id,
          createdAt: made.createdAt.toISOString(),
          gatewayUrl: options.gatewayUrl ?? null,
        },
        201,
      );
    }),
  );
  app.delete(
    "/previews/:id/runner-token",
    handle(async (c) => {
      const wallet = await write(c);
      const subject = await previewOf(c, wallet);
      const done = await db.revokeRunnerToken(subject.key, stamp());
      if ("refused" in done) throw new Refused(409, "a newer token request came first; try again");
      return c.json({ revoked: done.revoked });
    }),
  );

  // Agent URLs, for a preview or a registered agent.

  const setUrl = (resolve: typeof previewOf) =>
    handle(async (c) => {
      const wallet = await write(c);
      const subject = await resolve(c, wallet, true);
      if (subject.connection !== "url")
        throw new Refused(409, "this agent connects with the runner; it has no Agent URL");
      if (!options.secrets) throw new Refused(409, SECRET_KEY_MISSING);
      const { url } = await body(c, urlInput);
      const problem = outboundUrlProblem(url, options.ownDomains, options.allowLoopbackUrls);
      if (problem) throw new Refused(400, problem);
      const secret = newSecret(AGENT_SECRET_PREFIX);
      const id = randomUUID();
      const made = await db.createAgentUrl(subject.key, {
        id,
        url,
        ciphertext: options.secrets.encrypt(secret, agentUrlContext(id)),
        createdBy: wallet,
      });
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          agentUrlId: made.id,
          url,
          // Shown once: Bonded keeps it only encrypted and never returns it again.
          secret,
          createdAt: made.createdAt.toISOString(),
          verified: false,
        },
        201,
      );
    });
  /**
   * Prove the URL is the owner's: Bonded sends a signed `verify` challenge and the agent must
   * echo it within 10 seconds. The version it reports becomes its code hash when none is declared.
   */
  const verifyUrl = (resolve: typeof previewOf) =>
    handle(async (c) => {
      const wallet = await write(c);
      const subject = await resolve(c, wallet, true);
      if (!options.secrets) throw new Refused(409, SECRET_KEY_MISSING);
      const live = await db.agentUrl(subject.key);
      if (!live) throw new Refused(404, "set your Agent URL first");
      let host: string;
      try {
        host = new URL(live.url).host.toLowerCase();
      } catch {
        throw new Refused(400, "the stored URL is not valid; set it again");
      }
      if (!verifies.allow(host))
        throw new Refused(429, "too many verifications of this URL; try again in an hour");
      let secret: string;
      try {
        secret = options.secrets.decrypt(live.ciphertext, agentUrlContext(live.id));
      } catch {
        throw new Refused(409, "the stored secret can't be used; set the Agent URL again");
      }
      const answer = await options
        .verifyAgentUrl(live.url, secret)
        .catch(() => ({ ok: false as const, problem: "the verification couldn't run; try again" }));
      if (!answer.ok) return c.json({ verified: false, problem: answer.problem }, 409);
      const version = answer.version?.slice(0, 200) ?? null;
      const code = version ? urlCodeHash(version) : null;
      await db.markAgentUrlVerified(live.id, { version, codeHash: code });
      return c.json({ verified: true, version, codeHash: code });
    });
  const revokeUrl = (resolve: typeof previewOf) =>
    handle(async (c) => {
      const wallet = await write(c);
      const subject = await resolve(c, wallet);
      return c.json({ revoked: await db.revokeAgentUrls(subject.key) });
    });
  const showUrl = (resolve: typeof previewOf) =>
    handle(async (c) => {
      const wallet = await read(c);
      const subject = await resolve(c, wallet);
      return c.json({ connection: subject.connection, agentUrl: await agentUrlView(subject.key) });
    });
  const agentAs: typeof previewOf = (c, wallet) => agentOf(c, wallet);
  for (const [base, resolve] of [
    ["/previews/:id", previewOf],
    ["/self/agents/:id", agentAs],
  ] as const) {
    app.post(`${base}/agent-url`, setUrl(resolve));
    app.post(`${base}/agent-url/verify`, verifyUrl(resolve));
    app.delete(`${base}/agent-url`, revokeUrl(resolve));
    app.get(`${base}/agent-url`, showUrl(resolve));
  }

  // Connection checks.

  /**
   * Run a connection check: one benign episode, live. When the agent can't be reached at all
   * (no runner connected, URL not verified) the check fails at once with that problem.
   */
  const createCheck = (resolve: typeof previewOf) =>
    handle(async (c) => {
      const wallet = await write(c);
      const subject = await resolve(c, wallet, true);
      const { current, code } = await connectionNow(subject);
      const problem = await connectionProblem(subject);
      const made = await db.createCheck(
        {
          subject: subject.key,
          chainId,
          owner: wallet,
          mode: subject.mode,
          connection: subject.connection,
          credentialId: current.credentialId,
          code,
        },
        { perWalletHourly: policy.checksPerWalletHourly, hourly: policy.checksHourly },
        problem
          ? ({
              passed: false,
              problems: [problem],
              taskCompleted: false,
              toolsCalled: 0,
              surfacesRead: [],
            } satisfies ConnectionCheckResult)
          : undefined,
      );
      if ("refused" in made)
        throw made.refused === "busy"
          ? new Refused(409, "a check is already running for this agent; wait for its result")
          : new Refused(
              429,
              made.refused === "wallet-hourly"
                ? `at most ${policy.checksPerWalletHourly} checks an hour per wallet; try again after ${made.nextAt.toISOString()}`
                : `connection checks are busy; try again after ${made.nextAt.toISOString()}`,
            );
      if (
        subject.preview &&
        !problem &&
        ["created", "ready", "failed"].includes(subject.preview.status)
      )
        await db.setPreviewStatus(subject.id, "checking");
      return c.json(checkView(made), 201);
    });
  const listChecks = (resolve: typeof previewOf) =>
    handle(async (c) => {
      const wallet = await read(c);
      const subject = await resolve(c, wallet);
      return c.json({ items: (await db.checksOf(subject.key, 10)).map(checkView) });
    });
  app.post("/previews/:id/checks", createCheck(previewOf));
  app.get("/previews/:id/checks", listChecks(previewOf));
  app.post("/self/agents/:id/checks", createCheck(agentAs));
  app.get("/self/agents/:id/checks", listChecks(agentAs));

  /** A check by its id: the id is the capability (unguessable, given only to its owner). */
  app.get(
    "/checks/:id",
    handle(async (c) => {
      if (!options.reads.allow(clientAddress(c.req.raw.headers)))
        throw new Refused(429, "too many requests; try again in a few minutes");
      const id = uuid.safeParse(c.req.param("id"));
      const check = id.success ? await db.check(id.data) : undefined;
      if (!check || check.chainId !== chainId) throw new Refused(404, "check not found");
      return c.json(checkView(check));
    }),
  );
  /** A check's live events (server-sent events), from the start; it ends with the result. */
  app.get(
    "/checks/:id/events",
    handle(async (c) => {
      if (!options.reads.allow(clientAddress(c.req.raw.headers)))
        throw new Refused(429, "too many requests; try again in a few minutes");
      const id = uuid.safeParse(c.req.param("id"));
      const check = id.success ? await db.check(id.data) : undefined;
      if (!check || check.chainId !== chainId) throw new Refused(404, "check not found");
      let cursor = /^\d{1,18}$/.test(c.req.header("Last-Event-ID") ?? "")
        ? c.req.header("Last-Event-ID")!
        : "0";
      return options.streams.open(
        c,
        async () => {
          const events = await db.checkEvents(check.id, cursor);
          if (events.length) cursor = events.at(-1)!.id;
          // The worker always ends a check with a `result` event.
          const ended = events.some((e) => (e.event as { type?: string }).type === "result");
          return {
            events: events.map((e) => ({
              id: e.id,
              event: (e.event as { type: string }).type,
              data: e.event,
            })),
            done: ended,
          };
        },
        { intervalMs: 500, maxMs: 10 * 60_000 },
      );
    }),
  );

  // Preview ratings.

  /**
   * Queue the preview's rating. It needs a passing check of this exact connection in the last 24
   * hours, and fits in the preview caps; it runs after official ratings, one preview at a time.
   */
  app.post(
    "/previews/:id/rate",
    handle(async (c) => {
      const wallet = await write(c);
      const subject = await previewOf(c, wallet, true);
      const problem = await connectionProblem(subject);
      if (problem) throw new Refused(409, problem);
      const { code, config } = await connectionNow(subject);
      if (!(await db.passingCheck(subject.key, config))) throw new Refused(409, NEEDS_CHECK);
      const queued = await db.enqueuePreviewRating(
        subject.id,
        {
          nowMs: now(),
          perWalletDaily: policy.previewPerWalletDaily,
          daily: policy.previewDaily,
        },
        code,
      );
      if ("refused" in queued)
        throw new Refused(
          queued.refused === "busy" ? 409 : 429,
          previewRefusalMessage(queued, policy),
        );
      return c.json({ runId: queued.runId, expectedRating: previewPlan() }, 202);
    }),
  );

  /** The preview's report, labelled: never attested, never insurable. */
  app.get(
    "/previews/:id/report",
    handle(async (c) => {
      const wallet = await read(c);
      const subject = await previewOf(c, wallet);
      const runId = subject.preview!.ratingId;
      const row = runId
        ? (
            await db.pool.query("SELECT status,report FROM ratings WHERE id=$1 AND preview_id=$2", [
              runId,
              subject.id,
            ])
          ).rows[0]
        : undefined;
      if (!row?.report) return c.json({ status: row?.status ?? "none", report: null }, 202);
      return c.json({
        label: PREVIEW_LABEL,
        attested: false,
        insurable: false,
        report: row.report,
      });
    }),
  );

  // Cost estimates.

  /**
   * What a rating will cost the owner in their own model spend and time, from the latest passing
   * check: an estimate, and honest when the agent didn't report its usage.
   */
  const estimate = (resolve: typeof previewOf) =>
    handle(async (c) => {
      const wallet = await read(c);
      const subject = await resolve(c, wallet);
      const check = await db.latestPassingCheck(subject.key);
      if (!check)
        throw new Refused(404, "run a connection check first: the estimate comes from it");
      const episodes =
        subject.kind === "preview"
          ? previewPlan().maxEpisodes
          : expectedRating(policy.repeats, policy).maxEpisodes;
      return c.json(costEstimate(check, episodes));
    });
  app.get("/previews/:id/estimate", estimate(previewOf));
  app.get("/self/agents/:id/estimate", estimate(agentAs));

  // Progress.

  async function progressOf(runId: string, status: string) {
    const p = await db.runProgress(runId);
    const elapsed = p.startedAt && p.lastAt ? p.lastAt.getTime() - p.startedAt.getTime() : 0;
    const etaSeconds =
      status === "running" && p.total && p.done > 0
        ? Math.round(((elapsed / p.done) * (p.total - p.done)) / 1000)
        : null;
    return {
      done: p.done,
      total: p.total,
      etaSeconds,
      startedAt: p.startedAt?.toISOString() ?? null,
    };
  }
  /**
   * A rating's progress as server-sent events: counts and an ETA only, never a verdict, until it
   * ends (then one `end` event with its status). By run id, like GET /arena/runs/:id.
   */
  app.get(
    "/ratings/:id/progress",
    handle(async (c) => {
      if (!options.reads.allow(clientAddress(c.req.raw.headers)))
        throw new Refused(429, "too many requests; try again in a few minutes");
      const id = uuid.safeParse(c.req.param("id"));
      const exists = id.success
        ? (await db.pool.query("SELECT 1 FROM ratings WHERE id=$1", [id.data])).rowCount
        : 0;
      if (!id.success || !exists) throw new Refused(404, "rating not found");
      let last = "";
      return options.streams.open(
        c,
        async () => {
          const status = (await db.pool.query("SELECT status FROM ratings WHERE id=$1", [id.data]))
            .rows[0]?.status as string;
          const progress = { ...(await progressOf(id.data, status)), status };
          const over = status === "done" || status === "failed";
          const key = JSON.stringify(progress);
          const events: { event: string; data: unknown }[] = [];
          if (key !== last) events.push({ event: "progress", data: progress });
          last = key;
          if (over) events.push({ event: "end", data: { status } });
          return { events, done: over };
        },
        { intervalMs: 2000, maxMs: 4 * 3_600_000 },
      );
    }),
  );

  return { progressOf };
}

/** The cost estimate for `episodes` episodes, extrapolated from one check (see the route). */
export function costEstimate(check: ConnectionCheckRecord, episodes: number) {
  const result = (check.result ?? {}) as Partial<ConnectionCheckResult>;
  const seconds = Math.max(1, Math.round((result.durationMs ?? 0) / 1000));
  const usage = result.usage;
  const cost = usage?.costUsd;
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    estimate: true,
    episodes,
    perEpisode: {
      toolCalls: result.toolsCalled ?? 0,
      seconds,
      ...(cost !== undefined ? { costUsd: round(cost) } : {}),
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
    },
    total: {
      seconds: seconds * episodes,
      ...(cost !== undefined ? { costUsd: round(cost * episodes) } : {}),
      ...(usage
        ? {
            inputTokens: usage.inputTokens * episodes,
            outputTokens: usage.outputTokens * episodes,
          }
        : {}),
    },
    basis: `connection check ${check.id}`,
    usageReported: Boolean(usage),
    note: !usage
      ? "Your agent didn't report its model usage when it finished the check, so this gives time only. Send usage ({ inputTokens, outputTokens, costUsd }) with POST done to see a cost."
      : cost === undefined
        ? "Your agent reported tokens but no cost, so the cost isn't estimated: multiply the tokens by your model's price."
        : "An estimate from one benign episode: attacked episodes can take more or less.",
  };
}
