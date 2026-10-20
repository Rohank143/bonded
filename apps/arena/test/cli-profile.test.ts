import { describe, expect, it } from "vitest";
import { describeProfile, ownAgentTimeout, rateSettings } from "../src/cli-profile.js";
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
      // A remote agent skips S1 by default, as a hosted rating does.
      s1Pairs: 0,
    });
    expect(
      rateSettings("local", { repeats: "5", controls: "0", "episode-timeout": "30" }, rate),
    ).toMatchObject({ repeats: 5, controls: 0, episodeTimeoutMs: 30_000 });
    expect(() => rateSettings(undefined, { repeats: "0" }, rate)).toThrow(/--repeats/);
  });

  it("runs the S1 battery by default for Bonded's own agents, overridable", () => {
    const own = { remote: false, command: "rate" };
    expect(rateSettings(undefined, {}, own).s1Pairs).toBe(2);
    expect(rateSettings(undefined, { "s1-pairs": "0" }, own).s1Pairs).toBe(0);
    expect(rateSettings(undefined, { "s1-pairs": "4" }, own).s1Pairs).toBe(4);
    expect(rateSettings(undefined, { "s1-pairs": "2" }, rate).s1Pairs).toBe(2);
    expect(() => rateSettings(undefined, { "s1-pairs": "-1" }, own)).toThrow(/--s1-pairs/);
    expect(describeProfile(rateSettings(undefined, {}, own))).toMatch(
      /S1 market-data battery at 2 pairs/,
    );
    expect(describeProfile(rateSettings(undefined, {}, rate))).toMatch(/no S1 battery/);
  });

  it("runs what a hosted rating runs: 3 repeats, 90 s episodes, 6 controls, exposed trials, refusals", () => {
    const hosted = rateSettings("hosted", {}, rate);
    expect(hosted).toEqual({
      profile: "hosted",
      repeats: 3,
      controls: REMOTE_CONTROLS,
      episodeTimeoutMs: 90_000,
      heldOutPerClass: 1,
      s1Pairs: 0,
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
    expect(() => rateSettings("hosted", { "s1-pairs": "2" }, rate)).toThrow(/--s1-pairs/);
    expect(() => rateSettings("hosted", {}, { remote: false, command: "rate" })).toThrow(
      /rate --agent remote/,
    );
    expect(() => rateSettings("hosted", {}, { remote: true, command: "run" })).toThrow(
      /rate --agent remote/,
    );
    expect(() => rateSettings("cloud", {}, rate)).toThrow(/local or hosted/);
  });
});

describe("ownAgentTimeout", () => {
  const own = { remote: false, command: "rate" };
  it("passes --episode-timeout through for Bonded's own agents", () => {
    const flags = { "episode-timeout": "900" };
    expect(ownAgentTimeout(flags, rateSettings(undefined, flags, own), false)).toEqual({
      episodeTimeoutMs: 900_000,
    });
  });
  it("leaves the episode default alone without the flag, and for a remote agent", () => {
    expect(ownAgentTimeout({}, rateSettings(undefined, {}, own), false)).toEqual({});
    const flags = { "episode-timeout": "900" };
    expect(ownAgentTimeout(flags, rateSettings(undefined, flags, rate), true)).toEqual({});
  });
});
