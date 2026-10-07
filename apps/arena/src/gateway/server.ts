import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  AGENT_TOOLS,
  type AgentMode,
  type AttackSurface,
  DoneRequest,
  type EpisodeEndpoints,
  type HelloMessage,
  isAgentToolName,
  parseRunnerMessage,
  RUNNER_CLOSE,
  RUNNER_CONNECT_PATH,
  RUNNER_HEARTBEAT_MS,
  RUNNER_MAX_MESSAGE_BYTES,
  RUNNER_PROTOCOL_VERSION,
  RunnerToServer,
  type ServerToRunner,
  type ToolResult,
  toolSurface,
} from "@bonded/shared";
import { type WebSocket, WebSocketServer } from "ws";
import type { ArenaToolbox } from "../toolbox.js";
import { serveMcp } from "./mcp.js";
import { handleRpc, type RpcBinding } from "./rpc.js";
import {
  hashToken,
  newCapabilityToken,
  type RunnerIdentity,
  type RunnerTokenValidator,
} from "./tokens.js";
import { CHAIN_MODE_WRITE, openApiDocument, toolList } from "./tools.js";

/**
 * The Arena Gateway: serves one definition of the world (the agent tools, the world simulator
 * behind them, and the toolbox that sends writes through the vault) to agents running on their
 * operators' own servers. See docs/SPECIFICATION.md Section 8.4.
 *
 * - Runners connect out to `GET /runner/connect` (a WebSocket) with their runner token, and wait
 *   for episodes.
 * - Each episode gets an unguessable capability token `t`, and its agent calls
 *   `/e/{t}/mcp` (MCP), `/e/{t}/tools[/{name}]` (plain HTTP, described at `/e/{t}/openapi.json`),
 *   `/e/{t}/rpc` (chain mode) and `/e/{t}/done`. The token reaches exactly one episode's toolbox,
 *   and stops working the moment the episode ends.
 * - Every tool call is logged with the attack surface it reads, for coverage.
 *
 * The agent under test is untrusted: request bodies, batches, concurrent requests and upstream
 * calls are all capped, and the RPC endpoint passes only an allowlist (gateway/rpc.ts).
 */

export interface GatewayLimits {
  /** Largest request body for tools, MCP and done. */
  bodyBytes: number;
  /** Largest request body for the RPC endpoint. */
  rpcBodyBytes: number;
  /** Most requests in one JSON-RPC batch. */
  rpcBatch: number;
  /** Most requests one episode may have in flight at once. */
  concurrentPerEpisode: number;
  /** Per call to the sandbox node. */
  upstreamTimeoutMs: number;
  /** Largest sandbox node response passed on. */
  upstreamResponseBytes: number;
  /** How long a request waits for a gated episode to open (a TEE-bound agent's evidence). */
  readyTimeoutMs: number;
  /** How long a new runner has to say hello. */
  helloTimeoutMs: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
  bodyBytes: 64 * 1024,
  rpcBodyBytes: 256 * 1024,
  rpcBatch: 50,
  concurrentPerEpisode: 8,
  upstreamTimeoutMs: 15_000,
  upstreamResponseBytes: 8 * 1024 * 1024,
  readyTimeoutMs: 30_000,
  helloTimeoutMs: 10_000,
};

/** A runner came, is still there, or left. The rating service records these as runner presence. */
export interface RunnerPresenceEvent {
  type: "connected" | "heartbeat" | "disconnected";
  key: string;
  at: number;
  /** What the runner said when it connected. */
  hello?: HelloMessage;
  /** Why it left (for "disconnected"). */
  reason?: string;
}

export interface GatewayOptions {
  /** Checks runner tokens (StaticRunnerTokens, or the rating service's database). */
  tokens: RunnerTokenValidator;
  /**
   * The base URL runners and agents reach the gateway at, e.g. https://arena.example.com. Episode
   * endpoints are built from it. Default: the address `listen` binds.
   */
  publicUrl?: string;
  onRunnerPresence?: (event: RunnerPresenceEvent) => void;
  /**
   * What chain-mode RPC answers to web3_clientVersion when the sandbox isn't a fork (a fork
   * answers with its live chain's own version). Default: the sandbox node's own answer.
   */
  clientVersion?: string;
  log?: (message: string) => void;
  limits?: Partial<GatewayLimits>;
}

/** One tool call as the gateway saw it. */
export interface ToolRead {
  tool: string;
  /** The attack surface the tool shows, if it is a read of the world. */
  surface?: AttackSurface;
  ok: boolean;
  at: number;
}

type RunnerMessageListener = (message: RunnerToServer) => void;

/** A connected runner. */
export class RunnerSession {
  readonly connectedAt = Date.now();
  lastSeen = Date.now();
  hello: HelloMessage | undefined;
  /** The episode it is running, if any: one at a time. */
  episodeId: string | null = null;
  private readonly listeners = new Set<RunnerMessageListener>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closedReason: string | undefined;

  constructor(
    readonly identity: RunnerIdentity,
    private readonly socket: WebSocket,
  ) {}

  get key(): string {
    return this.identity.key;
  }

  get connected(): boolean {
    return this.closedReason === undefined && this.hello !== undefined;
  }

  get closed(): string | undefined {
    return this.closedReason;
  }

  send(message: ServerToRunner): boolean {
    if (this.closedReason !== undefined) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  onMessage(listener: RunnerMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
    this.closedWith(reason);
  }

  /** @internal */
  emit(message: RunnerToServer): void {
    for (const listener of [...this.listeners]) listener(message);
  }

  /** @internal */
  closedWith(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const listener of [...this.closeListeners]) listener(reason);
  }
}

/** What an episode needs from the gateway. */
export interface EpisodeSpec {
  episodeId: string;
  toolbox: ArenaToolbox;
  mode: AgentMode;
  /** Chain mode: where the RPC endpoint forwards, and whose transactions it accepts. */
  chain?: Omit<RpcBinding, "toolbox">;
  /** Hold every request until `open()` is called (a TEE-bound episode waits for its evidence). */
  gated?: boolean;
}

/** One episode served by the gateway, behind its capability token. */
export class GatewayEpisode {
  readonly reads: ToolRead[] = [];
  readonly done: Promise<DoneRequest>;
  /** What the agent posted to /done, once it has. */
  finished: DoneRequest | undefined;
  inFlight = 0;
  private closed = false;
  private finish!: (body: DoneRequest) => void;
  private openGate!: () => void;
  private readonly gate: Promise<void>;

  constructor(
    readonly spec: EpisodeSpec,
    readonly token: string,
    readonly endpoints: EpisodeEndpoints,
    private readonly detach: () => void,
  ) {
    this.done = new Promise((resolve) => (this.finish = resolve));
    this.gate = new Promise((resolve) => (this.openGate = resolve));
    if (!spec.gated) this.openGate();
  }

  get mode(): AgentMode {
    return this.spec.mode;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Lets requests through to a gated episode. */
  open(): void {
    this.openGate();
  }

  /** @internal Resolves when the episode is open; rejects after `timeoutMs`. */
  ready(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      this.gate,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the episode is not open yet")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** The agent said it is done. Later calls are refused. */
  markDone(body: DoneRequest): void {
    if (this.finished) return;
    this.finished = body;
    this.finish(body);
  }

  /** Ends the episode at the gateway: the token stops working at once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
  }

  /** A tool call from MCP or HTTP: logged with its surface, then run by the toolbox. */
  async callTool(name: string, args: unknown): Promise<ToolResult> {
    if (this.closed || this.finished) return { ok: false, error: "the episode is over" };
    if (this.mode === "chain" && isAgentToolName(name) && AGENT_TOOLS[name].writes)
      return { ok: false, error: CHAIN_MODE_WRITE };
    const result = await this.spec.toolbox.call(name, args);
    const surface = toolSurface(name);
    this.reads.push({ tool: name, ...(surface ? { surface } : {}), ok: result.ok, at: Date.now() });
    return result;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ArenaGateway {
  private readonly limits: GatewayLimits;
  private readonly episodes = new Map<string, GatewayEpisode>();
  private readonly runners = new Map<string, RunnerSession>();
  private readonly sockets = new Set<RunnerSession>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: RUNNER_MAX_MESSAGE_BYTES,
  });
  private server: Server | undefined;
  private base: string | undefined;
  private readonly log: (message: string) => void;

  constructor(private readonly options: GatewayOptions) {
    this.limits = { ...DEFAULT_GATEWAY_LIMITS, ...options.limits };
    this.log = options.log ?? (() => {});
    this.base = options.publicUrl?.replace(/\/+$/, "");
  }

  /** Starts listening. Returns the base URL (the public URL when one was given). */
  async listen(options: { port?: number; host?: string } = {}): Promise<string> {
    if (this.server) throw new Error("the gateway is already listening");
    const server = createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 60_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.on("upgrade", (req, socket, head) => void this.handleUpgrade(req, socket, head));
    const host = options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, host, () => resolve());
    });
    this.server = server;
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    this.base ??= `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    return this.base;
  }

  /** The configured web3_clientVersion for fresh (non-fork) sandboxes. */
  get clientVersion(): string | undefined {
    return this.options.clientVersion;
  }

  /** The base URL episode endpoints are built from. */
  get url(): string {
    if (!this.base) throw new Error("the gateway has no URL yet: listen() or set publicUrl");
    return this.base;
  }

  async close(): Promise<void> {
    for (const session of this.sockets) session.close(1001, "the gateway is shutting down");
    for (const episode of this.episodes.values()) episode.close();
    this.wss.close();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** The connected runner for a key, if there is one. */
  runner(key: string): RunnerSession | undefined {
    const session = this.runners.get(key);
    return session?.connected ? session : undefined;
  }

  /**
   * Waits until the runner for `key` is connected and idle, then reserves it for an episode.
   * Release it with `releaseRunner` once the episode's process is gone.
   */
  async acquireRunner(key: string, episodeId: string, timeoutMs: number): Promise<RunnerSession> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const session = this.runner(key);
      if (session && session.episodeId === null) {
        session.episodeId = episodeId;
        return session;
      }
      if (Date.now() >= deadline)
        throw new Error(
          session
            ? `the agent's runner is still busy with episode ${session.episodeId}`
            : "no runner is connected for this agent",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  releaseRunner(session: RunnerSession, episodeId: string): void {
    if (session.episodeId === episodeId) session.episodeId = null;
  }

  /** Serves an episode behind a fresh capability token. Close it when the episode ends. */
  openEpisode(spec: EpisodeSpec): GatewayEpisode {
    if (spec.mode === "chain" && !spec.chain) throw new Error("a chain-mode episode needs a chain");
    const token = newCapabilityToken();
    const key = hashToken(token);
    const base = `${this.url}/e/${token}`;
    const endpoints: EpisodeEndpoints = {
      mcp: `${base}/mcp`,
      tools: `${base}/tools`,
      openapi: `${base}/openapi.json`,
      ...(spec.mode === "chain" ? { rpc: `${base}/rpc` } : {}),
      done: `${base}/done`,
    };
    const episode = new GatewayEpisode(spec, token, endpoints, () => this.episodes.delete(key));
    this.episodes.set(key, episode);
    return episode;
  }

  /** The HTTP handler, for mounting the gateway in another server. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) this.log(`gateway error: ${(error as Error)?.message ?? error}`);
      if (!res.headersSent)
        reply(res, status, { error: status === 500 ? "internal error" : (error as Error).message });
      else res.end();
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    if (path === "/healthz" && req.method === "GET") return reply(res, 200, { ok: true });
    const match = /^\/e\/([A-Za-z0-9_-]{43})\/(.+)$/.exec(path);
    if (!match) throw new HttpError(404, "not found");
    const episode = this.episodes.get(hashToken(match[1]!));
    if (!episode) throw new HttpError(404, "no such episode, or it is over");
    if (episode.inFlight >= this.limits.concurrentPerEpisode)
      throw new HttpError(429, "too many requests in flight for this episode");
    episode.inFlight++;
    try {
      await episode.ready(this.limits.readyTimeoutMs).catch(() => {
        throw new HttpError(503, "the episode is not open yet");
      });
      await this.serveEpisode(episode, match[2]!, req, res);
    } finally {
      episode.inFlight--;
    }
  }

  private async serveEpisode(
    episode: GatewayEpisode,
    route: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const base = `${this.url}/e/${episode.token}`;
    if (route === "tools" && method === "GET")
      return reply(res, 200, { tools: toolList(episode.mode) });
    if (route === "openapi.json" && method === "GET")
      return reply(res, 200, openApiDocument(base, episode.mode));
    if (route === "mcp") {
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        throw new HttpError(405, "MCP here is stateless: POST only");
      }
      const body = await readJson(req, this.limits.bodyBytes);
      if (episode.isClosed) throw new HttpError(404, "no such episode, or it is over");
      return serveMcp(req, res, body, episode);
    }
    const tool = /^tools\/([a-z_]{1,64})$/.exec(route);
    if (tool && method === "POST") {
      const args = await readJson(req, this.limits.bodyBytes, {});
      return reply(res, 200, await episode.callTool(tool[1]!, args));
    }
    if (route === "rpc" && method === "POST" && episode.spec.chain) {
      const body = await readJson(req, this.limits.rpcBodyBytes);
      if (episode.finished || episode.isClosed)
        return reply(res, 200, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "the episode is over" },
        });
      const response = await handleRpc(
        body,
        { ...episode.spec.chain, toolbox: episode.spec.toolbox },
        {
          batch: this.limits.rpcBatch,
          timeoutMs: this.limits.upstreamTimeoutMs,
          responseBytes: this.limits.upstreamResponseBytes,
        },
      );
      return reply(res, 200, response);
    }
    if (route === "done" && method === "POST") {
      const parsed = DoneRequest.safeParse(await readJson(req, this.limits.bodyBytes, {}));
      if (!parsed.success) throw new HttpError(400, "body must be { finalMessage?, usage? }");
      episode.markDone(parsed.data);
      return reply(res, 200, { ok: true });
    }
    throw new HttpError(404, "not found");
  }

  /** The WebSocket upgrade handler, for mounting the gateway in another server (with `handle`). */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    if (path !== RUNNER_CONNECT_PATH) return refuse(socket, 404, "Not Found");
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!token) return refuse(socket, 401, "Unauthorized");
    let identity: RunnerIdentity | null;
    try {
      identity = await this.options.tokens.validate(token);
    } catch (error) {
      this.log(`runner token check failed: ${(error as Error)?.message ?? error}`);
      return refuse(socket, 503, "Service Unavailable");
    }
    if (!identity) return refuse(socket, 401, "Unauthorized");
    const found = identity;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, found, token));
  }

  private attach(ws: WebSocket, identity: RunnerIdentity, token: string): void {
    const session = new RunnerSession(identity, ws);
    this.sockets.add(session);
    const presence = (event: Omit<RunnerPresenceEvent, "key" | "at">) =>
      this.options.onRunnerPresence?.({ ...event, key: identity.key, at: Date.now() });

    const helloTimer = setTimeout(
      () => session.close(RUNNER_CLOSE.protocol, "no hello"),
      this.limits.helloTimeoutMs,
    );
    const heartbeat = setInterval(() => {
      if (Date.now() - session.lastSeen > 3 * RUNNER_HEARTBEAT_MS)
        session.close(RUNNER_CLOSE.heartbeat, "no heartbeat");
    }, RUNNER_HEARTBEAT_MS / 3);

    ws.on("message", (data, isBinary) => {
      const message = isBinary
        ? undefined
        : parseRunnerMessage(RunnerToServer, rawText(data as Buffer | Buffer[] | ArrayBuffer));
      if (!message) return session.close(RUNNER_CLOSE.protocol, "malformed message");
      session.lastSeen = Date.now();
      if (!session.hello) {
        if (message.type !== "hello") return session.close(RUNNER_CLOSE.protocol, "hello first");
        if (message.protocol !== RUNNER_PROTOCOL_VERSION)
          return session.close(RUNNER_CLOSE.protocol, "unsupported protocol version");
        clearTimeout(helloTimer);
        session.hello = message;
        const previous = this.runners.get(identity.key);
        if (previous && previous !== session)
          previous.close(RUNNER_CLOSE.replaced, "another runner connected with this token");
        this.runners.set(identity.key, session);
        this.log(`runner connected for ${identity.key} (${message.mode} mode)`);
        presence({ type: "connected", hello: message });
        return;
      }
      if (message.type === "hello") return;
      if (message.type === "ping") {
        session.send({ type: "pong", at: Date.now() });
        // Re-check the token on every heartbeat, so revoking it disconnects the runner.
        void this.options.tokens.validate(token).then(
          (still) => {
            if (!still) session.close(RUNNER_CLOSE.revoked, "the runner token was revoked");
            else presence({ type: "heartbeat" });
          },
          () => {},
        );
        return;
      }
      session.emit(message);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(heartbeat);
      this.sockets.delete(session);
      session.closedWith("disconnected");
      if (this.runners.get(identity.key) === session) {
        this.runners.delete(identity.key);
        presence({ type: "disconnected", reason: session.closed ?? "disconnected" });
      }
    });
    ws.on("error", () => ws.terminate());
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Reads a JSON body up to `limit` bytes. An empty body is `empty` when given, else an error. */
async function readJson(req: IncomingMessage, limit: number, empty?: unknown): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit)
    throw new HttpError(413, `request body over ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      req.destroy();
      throw new HttpError(413, `request body over ${limit} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    if (empty !== undefined) return empty;
    throw new HttpError(400, "empty body");
  }
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(type))
    throw new HttpError(415, "send the body as application/json");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body is not valid JSON");
  }
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function rawText(data: Buffer | Buffer[] | ArrayBuffer): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
