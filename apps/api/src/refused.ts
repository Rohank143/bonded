import type { Context } from "hono";

/**
 * A request the API refuses, with the status and the reason to show the user. `details` go in
 * the answer next to `error`: for example `retryAt` (ISO time) when it can be tried again, or a
 * queue `position`.
 */
export class Refused extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A route whose `Refused` errors become `{ error, ...details }` answers with their status. */
export const handle = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
  try {
    return await fn(c);
  } catch (e) {
    if (e instanceof Refused) return c.json({ ...e.details, error: e.message }, e.status);
    throw e;
  }
};
