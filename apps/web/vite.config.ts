/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The deployment file lives in contracts/evm/deployments; Vite may read the whole repository.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, fs: { allow: ["../.."] } },
  // RainbowKit's modal is slow to render the first time under jsdom; when every package's tests
  // run at once (pnpm test), the default 5 s timeout can run out.
  test: { environment: "jsdom", testTimeout: 15_000 },
});
