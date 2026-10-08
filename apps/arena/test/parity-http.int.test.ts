import { defineParitySuite } from "./fixtures/parity.js";

// Through the gateway over plain HTTP, the scripted brains get the in-process verdicts (fixtures/parity.ts).
defineParitySuite("http");
