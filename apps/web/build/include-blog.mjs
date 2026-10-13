// Puts the built blog (apps/blog) into this app's output, so it is served at /blog on the same
// domain. Runs after `vite build`, which empties dist first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const blogDist = path.resolve(here, "../../blog/dist");
const target = path.resolve(here, "../dist/blog");

if (!fs.existsSync(path.join(blogDist, "index.html"))) {
  throw new Error(
    `The blog is not built (${blogDist}); run \`pnpm --filter @bonded/blog build\` first.`,
  );
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(blogDist, target, { recursive: true });
console.log(`blog: copied into ${path.relative(process.cwd(), target)}`);
