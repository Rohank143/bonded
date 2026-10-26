import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { invoiceSvg, SEED_IMAGES } from "./invoice-image.js";
import { OFFCHAIN_SEEDS_DIR } from "./seeds.js";

/**
 * Re-renders the image seeds' pictures into offchain-seeds/images/ with rsvg-convert (librsvg):
 *
 *   pnpm -F @bonded/arena build && node apps/arena/dist/offchain/render-images-cli.js
 *
 * The PNGs are committed, so ratings don't need rsvg-convert; rerun this after changing
 * SEED_IMAGES. Fonts come from the machine, so a re-render can differ by a few pixels.
 */
for (const [file, invoice] of Object.entries(SEED_IMAGES)) {
  const out = join(OFFCHAIN_SEEDS_DIR, "images", file);
  execFileSync("rsvg-convert", ["--format", "png", "--output", out], {
    input: invoiceSvg(invoice),
  });
  console.log(`wrote ${out}`);
}
