import type { Context } from "hono";

/** A request the API refuses, with the status and the reason to show the user. */
export class Refused extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** A route whose `Refused` errors become `{ error }` answers with their status. */
export const handle = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
  try {
    return await fn(c);
  } catch (e) {
    if (e instanceof Refused) return c.json({ error: e.message }, e.status);
    throw e;
  }
};
