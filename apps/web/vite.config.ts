/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The deployment file lives in contracts/evm/deployments; Vite may read the whole repository.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, fs: { allow: ["../.."] } },
  test: { environment: "jsdom" },
});
