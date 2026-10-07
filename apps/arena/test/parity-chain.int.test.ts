import { defineParitySuite } from "./fixtures/parity.js";

// Through the gateway in chain mode (own signed transactions), the scripted brains get the in-process verdicts (fixtures/parity.ts).
defineParitySuite("chain");
