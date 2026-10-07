import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests start anvil and deploy the protocol.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
