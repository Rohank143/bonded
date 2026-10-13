import { defineConfig } from "astro/config";

// Served at /blog on the same domain as the web app (see apps/web/build/include-blog.mjs).
export default defineConfig({
  site: "https://www.bondedhq.xyz",
  base: "/blog",
  trailingSlash: "always",
});
