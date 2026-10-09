import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { errorCode, messageCode, messageText, troubleshootingUrl } from "./troubleshooting";

describe("troubleshooting links", () => {
  it("links a code to its anchor on the troubleshooting page", () => {
    expect(troubleshootingUrl("runner-offline")).toBe(
      "/docs/guides/troubleshooting/#runner-offline",
    );
  });

  it("uses the API's own code first, and reads one from a known sentence otherwise", () => {
    expect(messageCode({ code: "check-no-tools", message: "Your agent never called a tool" })).toBe(
      "check-no-tools",
    );
    expect(messageCode("Your agent never called a tool")).toBe("never-called-a-tool");
    expect(messageCode("It exited with code 1 before finishing")).toBe("agent-exited");
    expect(messageCode("Something nobody has seen before")).toBeUndefined();
    // A code that isn't a plain anchor is dropped rather than put in a link.
    expect(messageCode({ code: "<script>", message: "x" })).toBeUndefined();
    expect(messageText({ code: "a", message: "The sentence" })).toBe("The sentence");
  });

  it("reads a refusal's code from the API's error body", () => {
    expect(errorCode(new ApiError(409, "no passing check", { code: "no-passing-check" }))).toBe(
      "no-passing-check",
    );
    expect(errorCode(new ApiError(409, "no passing check"))).toBeUndefined();
    expect(errorCode(new Error("x"))).toBeUndefined();
  });
});
