import { expect, it } from "vitest";
import { fontPreloadTags } from "./font-preload";

it("preloads only the three latin fonts the first screen uses", () => {
  const tags = fontPreloadTags([
    "assets/index-Abc123.js",
    "assets/manrope-latin-wght-normal-D1x2_y.woff2",
    "assets/manrope-cyrillic-wght-normal-Zz9.woff2",
    "assets/instrument-serif-latin-400-normal-Q7.woff2",
    "assets/instrument-serif-latin-400-italic-Q8.woff2",
    "assets/jetbrains-mono-latin-wght-normal-K2.woff2",
    "assets/manrope-latin-wght-normal-D1x2_y.woff",
  ]);
  expect(tags.map((t) => t.attrs.href)).toEqual([
    "/assets/manrope-latin-wght-normal-D1x2_y.woff2",
    "/assets/instrument-serif-latin-400-normal-Q7.woff2",
    "/assets/jetbrains-mono-latin-wght-normal-K2.woff2",
  ]);
  expect(tags[0]!.attrs).toMatchObject({ rel: "preload", as: "font", crossorigin: "" });
});
