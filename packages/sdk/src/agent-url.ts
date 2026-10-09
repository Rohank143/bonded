import type { IncomingMessage, ServerResponse } from "node:http";
import { EpisodeMessage } from "@bonded/shared";
import type { BondedEpisode } from "./episode.js";
import { finishEpisode } from "./done.js";
import type { EpisodeUsage } from "./mcp.js";
import {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  TIMESTAMP_HEADER,
  verifyBondedSignature,
} from "./signature.js";

export {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  signBondedRequest,
  type SignatureCheck,
  TIMESTAMP_HEADER,
  verifyBondedSignature,
} from "./signature.js";

/**
 * Agent URL mode: instead of running the Bonded runner, an agent serves one HTTPS endpoint and
 * Bonded calls it once per episode. Every call is a signed `POST` of one JSON message:
 *
 * - `{ type: "verify", challenge }` when the URL is registered: answer `200 { challenge, version? }`.
 * - `{ type: "episode", ... }` (the runner protocol's `EpisodeMessage`): answer `2xx` within
 *   10 seconds, then work: call the episode's tools and `POST {done}` when finished.
 * - `{ type: "cancel", episodeId }`: stop that episode (best effort).
 *
 * `createBondedHandler` does all of that: it checks signatures, answers challenges, acknowledges an
 * episode at once and runs your `onEpisode` in the background, aborts it on cancel or at the
 * deadline, and posts `/done` (with the usage you return) when it resolves.
 */

/** What `onEpisode` may return: posted to the episode's `/done`. */
export interface EpisodeOutcome {
  finalMessage?: string;
  /** Your model's usage for the episode; Bonded uses it to estimate a full rating's cost. */
  usage?: EpisodeUsage;
}

export interface EpisodeContext {
  /**
   * Aborted when Bonded cancels the episode or its deadline passes. Stop then: the episode is
   * over and its endpoints refuse further calls. Pass it to your model and HTTP calls.
   */
  signal: AbortSignal;
}

export interface BondedHandlerOptions {
  /** The agent secret Bonded showed you when you registered the URL (`bonded_as_...`). */
  secret: string;
  /** Runs one episode. Resolve when the agent is finished; the handler then posts `/done`. */
  onEpisode(
    episode: BondedEpisode,
    context: EpisodeContext,
  ): Promise<EpisodeOutcome | void> | EpisodeOutcome | void;
  /**
   * Your agent's version (a release tag, a git commit). Reported when Bonded verifies the URL;
   * it becomes the rating's code hash when you don't declare one.
   */
  version?: string;
  /** Called when `onEpisode` throws (default: `console.error`). `/done` is still posted. */
  onError?: (error: unknown, episode: BondedEpisode) => void;
  /**
   * Keeps the background work alive on platforms that stop at the response (Cloudflare's
   * `ctx.waitUntil`, Vercel's `waitUntil`, Next.js `after`). The handler's second argument wins.
   */
  waitUntil?: (work: Promise<unknown>) => void;
  /** How far a request's timestamp may be from this server's clock. Default 300 seconds. */
  toleranceSeconds?: number;
  /** Largest request body accepted. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Most episodes run at once (Bonded sends one at a time per agent). Default 8. */
  maxConcurrent?: number;
  /** For tests: the clock, in milliseconds. */
  now?: () => number;
  /** For tests: the `fetch` used to post `/done`. */
  fetch?: typeof fetch;
}

/** A standard Fetch API handler: Hono, Next.js route handlers, Bun, Deno, Cloudflare Workers. */
export type BondedHandler = (
  request: Request,
  context?: { waitUntil?: (work: Promise<unknown>) => void },
) => Promise<Response>;

const MAX_BODY_BYTES = 1024 * 1024;
const REPLAY_CACHE_LIMIT = 10_000;

/**
 * An Agent URL endpoint for your agent.
 *
 * ```ts
 * const handler = createBondedHandler({
 *   secret: process.env.BONDED_AGENT_SECRET!,
 *   version: process.env.GIT_SHA,
 *   async onEpisode(episode, { signal }) {
 *     const tools = await bondedAiSdkTools(episode);
 *     const { usage } = await generateText({ model, tools, prompt: episode.task.goal, abortSignal: signal });
 *     return { usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
 *   },
 * });
 * export const POST = handler; // Next.js; or app.post("/bonded", handler) in Hono
 * ```
 */
export function createBondedHandler(options: BondedHandlerOptions): BondedHandler {
  if (!options.secret) throw new Error("createBondedHandler needs the agent secret");
  const now = options.now ?? Date.now;
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const maxBody = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxConcurrent = options.maxConcurrent ?? 8;
  const onError =
    options.onError ??
    ((error: unknown, episode: BondedEpisode) =>
      console.error(`Bonded episode ${episode.episodeId} failed:`, error));
  /** Accepted (timestamp, signature) pairs, until they fall out of the window. */
  const seen = new Map<string, number>();
  const running = new Map<string, AbortController>();

  const rememberOnce = (key: string, timestamp: number, nowSeconds: number): boolean => {
    if (seen.size >= REPLAY_CACHE_LIMIT)
      for (const [k, expires] of seen) if (expires < nowSeconds) seen.delete(k);
    if (seen.has(key) || seen.size >= REPLAY_CACHE_LIMIT) return false;
    seen.set(key, timestamp + tolerance);
    return true;
  };

  const run = async (episode: BondedEpisode, controller: AbortController) => {
    const deadline = setTimeout(
      () => controller.abort(new Error("the episode's deadline passed")),
      episode.deadlineMs,
    );
    let outcome: EpisodeOutcome | void;
    let failed = false;
    try {
      outcome = await options.onEpisode(episode, { signal: controller.signal });
    } catch (error) {
      failed = true;
      if (!controller.signal.aborted) onError(error, episode);
      outcome = {
        finalMessage:
          `the agent failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4_000,
          ),
      };
    } finally {
      clearTimeout(deadline);
      running.delete(episode.episodeId);
    }
    // Cancelled or past its deadline: the episode is already over at the gateway.
    if (controller.signal.aborted) return;
    try {
      await finishEpisode(
        episode,
        {
          ...(outcome?.finalMessage !== undefined
            ? { finalMessage: outcome.finalMessage.slice(0, 4_000) }
            : {}),
          ...(outcome?.usage ? { usage: outcome.usage } : {}),
        },
        options.fetch ? { fetch: options.fetch } : {},
      );
    } catch (error) {
      if (!failed) onError(error, episode);
    }
  };

  return async (request, context) => {
    if (request.method !== "POST")
      return json(405, { error: "Bonded calls this endpoint with POST" }, { allow: "POST" });
    const body = await readCapped(request, maxBody);
    if (body === undefined) return json(413, { error: `the body is over ${maxBody} bytes` });

    const nowSeconds = Math.floor(now() / 1000);
    const signature = request.headers.get(SIGNATURE_HEADER);
    const check = await verifyBondedSignature({
      secret: options.secret,
      body,
      timestamp: request.headers.get(TIMESTAMP_HEADER),
      signature,
      now: nowSeconds,
      toleranceSeconds: tolerance,
    });
    if (!check.ok)
      return json(401, {
        error: {
          missing: "missing bonded-timestamp or bonded-signature",
          malformed: "malformed bonded-timestamp or bonded-signature",
          stale: "the timestamp is too far from this server's clock",
          mismatch: "the signature doesn't match",
        }[check.reason],
      });
    if (!rememberOnce(`${check.timestamp}.${signature}`, check.timestamp, nowSeconds))
      return json(401, { error: "this request was already received (replayed)" });

    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return json(400, { error: "the body isn't JSON" });
    }
    const type = (message as { type?: unknown } | null)?.type;

    if (type === "verify") {
      const challenge = (message as { challenge?: unknown }).challenge;
      if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > 1_024)
        return json(400, { error: "verify needs a challenge string" });
      return json(200, { challenge, ...(options.version ? { version: options.version } : {}) });
    }

    if (type === "cancel") {
      const episodeId = (message as { episodeId?: unknown }).episodeId;
      if (typeof episodeId !== "string") return json(400, { error: "cancel needs an episodeId" });
      const controller = running.get(episodeId);
      controller?.abort(new Error("Bonded cancelled the episode"));
      return json(200, { ok: true, cancelled: controller !== undefined });
    }

    if (type === "episode") {
      const parsed = EpisodeMessage.safeParse(message);
      if (!parsed.success)
        return json(400, {
          error: `not a valid episode: ${parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join(".")} ${i.message}`)
            .join("; ")}`,
        });
      const episode = toEpisode(parsed.data);
      if (running.has(episode.episodeId))
        return json(200, { ok: true, episodeId: episode.episodeId, alreadyRunning: true });
      if (running.size >= maxConcurrent)
        return json(429, { error: `already running ${running.size} episodes` });
      const controller = new AbortController();
      running.set(episode.episodeId, controller);
      const work = run(episode, controller);
      // Called as a method: Cloudflare's ctx.waitUntil needs its `this`.
      if (context?.waitUntil) context.waitUntil(work);
      else options.waitUntil?.(work);
      return json(202, { ok: true, episodeId: episode.episodeId });
    }

    return json(400, { error: "unknown message type" });
  };
}

/** The episode as the agent sees it (the same shape `fromBondedEnv` returns). */
function toEpisode(message: EpisodeMessage): BondedEpisode {
  return {
    episodeId: message.episodeId,
    task: message.task,
    mode: message.mode,
    endpoints: message.endpoints,
    vault: message.vault,
    chainId: message.chainId,
    contracts: { exchange: message.contracts.exchange, tokens: message.contracts.tokens },
    ...(message.sessionKey ? { sessionKey: message.sessionKey } : {}),
    deadlineMs: message.deadlineMs,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The body as text, or undefined when it is over `max` bytes (read no further than that). */
async function readCapped(request: Request, max: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The handler as a Node `http` / Express / Fastify-style listener:
 *
 * ```ts
 * app.post("/bonded", toNodeHandler(handler)); // Express: mount it before express.json()
 * http.createServer(toNodeHandler(handler)).listen(8080);
 * ```
 *
 * The signature covers the raw body, so the body must reach it unparsed: either nothing has read
 * the stream yet, or `req.body` is the raw `Buffer` or string (`express.raw()`/`express.text()`).
 */
export function toNodeHandler(
  handler: BondedHandler,
): (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let body: RequestInit["body"] | undefined;
    if (typeof req.body === "string" || req.body instanceof Uint8Array) {
      body = req.body as string | Uint8Array<ArrayBuffer>;
    } else if (req.body !== undefined && req.body !== null && !isEmptyObject(req.body)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "the body was already parsed, so its signature can't be checked: mount the Bonded handler before express.json(), or use express.raw({ type: 'application/json' })",
        }),
      );
      return;
    } else if (req.method === "POST") {
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          req.on("end", () => controller.close());
          req.on("error", (error) => controller.error(error));
        },
        cancel() {
          req.destroy();
        },
      });
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers,
      ...(body !== undefined ? { body, duplex: "half" } : {}),
    } as RequestInit);
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
