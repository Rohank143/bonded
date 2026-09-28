import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Database } from "@bonded/db";
/** Start an isolated real Postgres cluster and return its database and cleanup function. */
export async function postgres() {
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (!a || typeof a === "string") throw new Error("no port");
      s.close(() => resolve(a.port));
    });
  });
  const directory = await mkdtemp(join(tmpdir(), "bonded-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir: join(directory, "data"),
    user: "postgres",
    password: "test",
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  try {
    await pg.initialise();
    await pg.start();
  } catch (e) {
    await rm(directory, { recursive: true, force: true });
    throw e;
  }
  const url = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  const db = new Database(url);
  await db.migrate();
  return {
    db,
    url,
    stop: async () => {
      await db.close();
      await pg.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
