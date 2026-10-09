import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Database } from "@bonded/db";
import { Refused, handle } from "./refused.js";
import { clientAddress, type RateLimiter } from "./rate-limit.js";
import type { SessionWallet } from "./sessions.js";
import {
  SECRET_KEY_MISSING,
  WEBHOOK_SECRET_PREFIX,
  newSecret,
  webhookContext,
  type SecretBox,
} from "./secrets.js";
import { outboundUrlProblem } from "./outbound.js";
import { safeRequest } from "@bonded/arena";
import { signAgentUrlRequest } from "@bondedhq/shared";

/**
 * Notifications (bring your own agent, round 2): when a preview or a rating of an owner's agent
 * finishes, fails or is refused, Bonded tells the owner by webhook (signed like Agent URL calls,
 * with a secret of its own) and by email if the service has an email sender and the owner gave an
 * address. Sending never blocks or fails a rating: every failure is swallowed and logged without
 * the URL, address or secret.
 */

/** What a notification is about. */
export type NotificationType = "rating_finished" | "rating_failed" | "rating_refused";

export interface RatingNotification {
  type: NotificationType;
  ratingId: string;
  /** Previews have a preview id; registered agents an agent id. */
  previewId?: string;
  agentId?: string;
  chainId: number;
  status: string;
  score?: number;
  tier?: string;
  reason?: string;
  /** For previews: "Preview: not on chain, not insurable". */
  label?: string;
  at: string;
}

/** A provider-agnostic email sender. */
export interface EmailSender {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendEmail implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(message: { to: string; subject: string; text: string }) {
    const r = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`the email provider answered ${r.status}`);
  }
}

/** The email sender, only when RESEND_API_KEY and EMAIL_FROM are both set (off by default). */
export function emailFromEnv(
  env: Record<string, string | undefined> = process.env,
): EmailSender | undefined {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  return key && from ? new ResendEmail(key, from) : undefined;
}

const email = z
  .string()
  .max(254)
  .regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/);
/** Settings to save. A field left out is kept; null removes it. */
export const notificationInput = z.strictObject({
  /** Set (a new URL gets a new secret, shown once) or remove (null) the webhook. */
  webhookUrl: z.string().min(1).max(2048).nullable().optional(),
  email: email.nullable().optional(),
});
export type NotificationInput = z.infer<typeof notificationInput>;

export interface NotificationOptions {
  secrets?: SecretBox | undefined;
  email?: EmailSender | undefined;
  ownDomains: readonly string[];
  allowLoopbackUrls?: boolean | undefined;
}

/** "m***@example.com": enough to recognise, not to harvest. */
export const maskEmail = (value: string) => {
  const [user = "", domain = ""] = value.split("@");
  return `${user.slice(0, 1)}***@${domain}`;
};
/** The webhook's origin, with any path hidden (it may carry a token). */
export const maskUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.pathname === "/" && !url.search ? url.origin : `${url.origin}/…`;
  } catch {
    return "…";
  }
};

/** An owner's settings as anyone may see them: masked, and never the webhook secret. */
export async function notificationView(db: Database, owner: string, options: NotificationOptions) {
  const s = await db.notificationSettings(owner);
  return {
    webhook: s?.webhookUrl ? { url: maskUrl(s.webhookUrl) } : null,
    email: s?.email ? maskEmail(s.email) : null,
    emailAvailable: Boolean(options.email),
    webhookAvailable: Boolean(options.secrets),
  };
}

/**
 * Save an owner's settings. A new webhook URL gets a new signing secret, returned once
 * (`webhookSecret`); the same URL again keeps its secret.
 */
export async function saveNotifications(
  db: Database,
  owner: string,
  input: NotificationInput,
  options: NotificationOptions,
) {
  const patch: Parameters<Database["saveNotificationSettings"]>[1] = {};
  let secret: string | undefined;
  if (input.webhookUrl !== undefined) {
    if (input.webhookUrl === null) {
      patch.webhookUrl = null;
      patch.webhookSecretCiphertext = null;
    } else {
      if (!options.secrets) throw new Refused(409, SECRET_KEY_MISSING);
      const problem = outboundUrlProblem(
        input.webhookUrl,
        options.ownDomains,
        options.allowLoopbackUrls,
      );
      if (problem) throw new Refused(400, problem);
      const current = await db.notificationSettings(owner);
      patch.webhookUrl = input.webhookUrl;
      if (current?.webhookUrl !== input.webhookUrl || !current.webhookSecretCiphertext) {
        secret = newSecret(WEBHOOK_SECRET_PREFIX);
        patch.webhookSecretCiphertext = options.secrets.encrypt(secret, webhookContext(owner));
      }
    }
  }
  if (input.email !== undefined) {
    if (input.email !== null && !options.email)
      throw new Refused(409, "Email notifications aren't set up on this service.");
    patch.email = input.email;
  }
  await db.saveNotificationSettings(owner, patch);
  return {
    ...(await notificationView(db, owner, options)),
    ...(secret ? { webhookSecret: secret } : {}),
  };
}

/** The signed-in owner's notification settings (sessions.ts). */
export function notificationRoutes(
  app: Hono,
  options: NotificationOptions & {
    db: Database;
    wallet: SessionWallet;
    writes: RateLimiter;
    reads: RateLimiter;
  },
) {
  const { db } = options;
  const limited = (c: Context, limiter: RateLimiter) => {
    if (!limiter.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "Too many requests. Try again in a few minutes.");
  };
  app.get(
    "/self/notifications",
    handle(async (c) => {
      limited(c, options.reads);
      return c.json(await notificationView(db, await options.wallet(c), options));
    }),
  );
  const save = handle(async (c) => {
    limited(c, options.writes);
    const owner = await options.wallet(c);
    const input = notificationInput.parse(await c.req.json());
    c.header("Cache-Control", "no-store");
    return c.json(await saveNotifications(db, owner, input, options));
  });
  app.post("/self/notifications", save);
  app.put("/self/notifications", save);

  /** A new webhook signing secret, returned once; the old one stops working. */
  app.post(
    "/self/notifications/webhook-secret",
    handle(async (c) => {
      limited(c, options.writes);
      const owner = await options.wallet(c);
      if (!options.secrets) throw new Refused(409, SECRET_KEY_MISSING);
      const current = await db.notificationSettings(owner);
      if (!current?.webhookUrl) throw new Refused(404, "Set a webhook URL first.");
      const secret = newSecret(WEBHOOK_SECRET_PREFIX);
      await db.saveNotificationSettings(owner, {
        webhookSecretCiphertext: options.secrets.encrypt(secret, webhookContext(owner)),
      });
      c.header("Cache-Control", "no-store");
      return c.json({ ...(await notificationView(db, owner, options)), webhookSecret: secret });
    }),
  );
}

/**
 * Sends notifications for the rating worker. `notify` never throws and never waits on the
 * network for the caller: it returns at once, and `idle()` resolves when sending is over (tests).
 * Each rating's outcome is sent once (`claimNotification`), even if its finish is retried.
 */
export class Notifier {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly options: {
      secrets?: SecretBox;
      email?: EmailSender;
      /** Webhooks to plain http on this machine (tests only). */
      allowLoopback?: boolean;
      log?: (line: string) => void;
      post?: typeof safeRequest;
    } = {},
  ) {}

  notify(owner: string | null | undefined, n: RatingNotification): void {
    if (!owner) return;
    const work = this.send(owner.toLowerCase(), n).catch(() =>
      this.log(`notification for rating ${n.ratingId} could not be sent`),
    );
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private log(line: string) {
    (this.options.log ?? ((l: string) => console.error(l)))(line);
  }

  private async send(owner: string, n: RatingNotification) {
    const settings = await this.db.notificationSettings(owner);
    if (!settings || (!settings.webhookUrl && !settings.email)) return;
    if (!(await this.db.claimNotification(n.ratingId, n.type))) return;
    const jobs: Promise<void>[] = [];
    if (settings.webhookUrl && settings.webhookSecretCiphertext && this.options.secrets) {
      const secret = this.options.secrets.decrypt(
        settings.webhookSecretCiphertext,
        webhookContext(owner),
      );
      const body = JSON.stringify(n);
      const post = this.options.post ?? safeRequest;
      jobs.push(
        post(new URL(settings.webhookUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await signAgentUrlRequest(secret, body)),
          },
          body,
          timeoutMs: 10_000,
          maxBytes: 64 * 1024,
          ...(this.options.allowLoopback ? { allowLoopback: true } : {}),
        }).then(({ status }) => {
          if (status < 200 || status >= 300)
            this.log(`webhook for rating ${n.ratingId} answered ${status}`);
        }),
      );
    }
    if (settings.email && this.options.email)
      jobs.push(this.options.email.send({ to: settings.email, ...emailText(n) }));
    const results = await Promise.allSettled(jobs);
    for (const r of results)
      if (r.status === "rejected")
        this.log(`a notification for rating ${n.ratingId} failed to send`);
  }
}

/** The email for a notification, in plain words. */
export function emailText(n: RatingNotification): { subject: string; text: string } {
  const what = n.previewId ? "Your preview rating" : `The rating of agent ${n.agentId}`;
  const outcome =
    n.type === "rating_finished"
      ? `finished${n.score !== undefined ? ` with a score of ${n.score}${n.tier ? ` (${n.tier})` : ""}` : ""}`
      : n.type === "rating_refused"
        ? `was refused${n.reason ? `: ${n.reason}` : ""}`
        : `stopped${n.reason ? `: ${n.reason}` : ""}`;
  return {
    subject: `Bonded: ${what.toLowerCase().replace(/^the /, "")} ${n.type === "rating_finished" ? "finished" : n.type === "rating_refused" ? "was refused" : "stopped"}`,
    text: `${what} ${outcome}.${n.label ? `\n\n${n.label}.` : ""}\n\nRating ${n.ratingId}.`,
  };
}
