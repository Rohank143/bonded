import { describe, expect, it } from "vitest";
import { describeProfile, rateSettings } from "../src/cli-profile.js";
import { HOSTED_REMOTE_PROFILE, REMOTE_CONTROLS } from "../src/rate.js";

const rate = { remote: true, command: "rate" };

describe("arena rate --profile", () => {
  it("keeps the CLI's own defaults locally, each one overridable", () => {
    expect(rateSettings(undefined, {}, rate)).toEqual({
      profile: "local",
      repeats: 1,
      controls: 2,
      episodeTimeoutMs: 240_000,
      heldOutPerClass: 1,
    });
    expect(
      rateSettings("local", { repeats: "5", controls: "0", "episode-timeout": "30" }, rate),
    ).toMatchObject({ repeats: 5, controls: 0, episodeTimeoutMs: 30_000 });
    expect(() => rateSettings(undefined, { repeats: "0" }, rate)).toThrow(/--repeats/);
  });

  it("runs what a hosted rating runs: 3 repeats, 90 s episodes, 6 controls, exposed trials, refusals", () => {
    const hosted = rateSettings("hosted", {}, rate);
    expect(hosted).toEqual({
      profile: "hosted",
      repeats: 3,
      controls: REMOTE_CONTROLS,
      episodeTimeoutMs: 90_000,
      heldOutPerClass: 1,
      exercise: "exposed",
      attackLiveness: "refuse",
    });
    expect(hosted.controls).toBe(6);
    expect(hosted.repeats).toBe(HOSTED_REMOTE_PROFILE.repeats);
    expect(describeProfile(hosted)).toMatch(
      /^Profile: hosted \(3 runs of each attack, 90 s episodes, 6 controls/,
    );
    expect(describeProfile(rateSettings(undefined, {}, rate))).toMatch(/^Profile: local/);
  });

  it("refuses flags that would change the hosted settings, and other agents or commands", () => {
    expect(() => rateSettings("hosted", { repeats: "5", controls: "2" }, rate)).toThrow(
      "--profile hosted fixes --repeats, --controls; leave them out",
    );
    expect(() => rateSettings("hosted", {}, { remote: false, command: "rate" })).toThrow(
      /rate --agent remote/,
    );
    expect(() => rateSettings("hosted", {}, { remote: true, command: "run" })).toThrow(
      /rate --agent remote/,
    );
    expect(() => rateSettings("cloud", {}, rate)).toThrow(/local or hosted/);
  });
});
