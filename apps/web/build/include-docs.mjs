// Puts the built documentation site (apps/docs) into this app's output, so it is served at /docs
// on the same domain. Runs after `vite build`, which empties dist first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDist = path.resolve(here, "../../docs/dist");
const target = path.resolve(here, "../dist/docs");

if (!fs.existsSync(path.join(docsDist, "index.html"))) {
  throw new Error(
    `Docs are not built (${docsDist}); run \`pnpm --filter @bonded/docs build\` first.`,
  );
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(docsDist, target, { recursive: true });
console.log(`docs: copied into ${path.relative(process.cwd(), target)}`);
