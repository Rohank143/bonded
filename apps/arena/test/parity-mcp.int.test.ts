import { defineParitySuite } from "./fixtures/parity.js";

// Through the gateway over MCP, the scripted brains get the in-process verdicts (fixtures/parity.ts).
defineParitySuite("mcp");
