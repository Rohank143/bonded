import { ApiError } from "./api";

/**
 * Every problem, warning or refusal the app shows links to its entry on the troubleshooting page,
 * by a stable code (an anchor there). The API gives the code next to its sentence; for an older
 * API that sends only the sentence, the code is read from the sentence's known wording.
 */
export const DOCS_TROUBLESHOOTING = "/docs/guides/troubleshooting/";

/** A sentence from the API, with its code when the API gives one. */
export type ApiMessage = string | { code?: string | null; message: string };

export const messageText = (m: ApiMessage): string => (typeof m === "string" ? m : m.message);

/** The troubleshooting page's anchor for a code. Codes are kebab-case; anything else is dropped. */
export function troubleshootingUrl(code: string): string {
  return `${DOCS_TROUBLESHOOTING}#${encodeURIComponent(code)}`;
}

const SAFE_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Known sentences and their codes, for messages that come without one. The same wording
 * `problemAdvice` (lib/connect.ts) recognises.
 */
const PATTERNS: [RegExp, string][] = [
  [/never called a tool/i, "never-called-a-tool"],
  [/exited with code|crashed/i, "agent-exited"],
  [/did(n't| not) make the trade/i, "no-trade"],
  [/surfaces?.*untested|untested.*surfaces?/i, "unread-surfaces"],
  [/runner (isn't|is not) connected|runner.*offline/i, "runner-offline"],
  [/nothing accepted a connection|couldn't reach your url/i, "url-unreachable"],
  [/closed the connection/i, "url-closed"],
  [/not with json|to the check; it must be 200/i, "verify-answer"],
  [/public internet|public address/i, "url-not-public"],
  [/answered 401|agent secret/i, "agent-secret"],
  [/did(n't| not) answer within/i, "url-slow"],
  [/certificate|tls/i, "url-certificate"],
  [/signature/i, "bad-signature"],
  [/timed out|deadline|ran out of time/i, "timed-out"],
  [/\bmode\b/i, "wrong-mode"],
  [/today's preview|preview.*(day|today)/i, "preview-limit"],
  [/low on gas|gas.*low|top up/i, "low-gas"],
  [/no trade through the vault|without (a )?vault trade/i, "cover-without-vault-trades"],
  [/score (has )?expired|expires in/i, "score-expiring"],
];

/** A message's code: the API's own when it gives one, else one read from its wording. */
export function messageCode(m: ApiMessage): string | undefined {
  if (typeof m !== "string" && m.code) return SAFE_CODE.test(m.code) ? m.code : undefined;
  const text = messageText(m);
  return PATTERNS.find(([p]) => p.test(text))?.[1];
}

/** The code of an API refusal, when its body carries one. */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const code = error.details.code;
  return typeof code === "string" && SAFE_CODE.test(code) ? code : undefined;
}
