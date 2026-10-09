import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { teeMeasurement, teeReportData } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import {
  APPROVED_OS_IMAGES,
  attestTeeAgent,
  DEV_OS_IMAGE_0_5_9,
  type QuoteFacts,
  type QuoteVerifier,
  TeeUnavailableError,
  TeeVerificationError,
  verifyTeeEvidence,
} from "../src/tee.js";

// A test-side copy of dstack's rules, written from the spec rather than imported, so a mistake in
// the Arena's implementation can't hide behind the same mistake here.
const sha384 = (...parts: (Buffer | string)[]) => {
  const h = createHash("sha384");
  parts.forEach((p) => h.update(p));
  return h.digest();
};
const extend = (digests: Buffer[]) =>
  digests.reduce(
    (mr, d) => sha384(mr, Buffer.concat([d, Buffer.alloc(48 - d.length)])),
    Buffer.alloc(48),
  );

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const COMPOSE = "ab".repeat(32);
const CODE = hash(7);
const NONCE = hash(9);
const EVM = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const SOL = "11111111111111111111111111111112";
const MR = { mrTd: "01".repeat(48), rtMr0: "", rtMr1: "", rtMr2: "" };

const PROD_OS = Object.values(APPROVED_OS_IMAGES)[0]!;

function runtimeEvent(event: string, payloadHex: string) {
  const payload = Buffer.from(payloadHex, "hex");
  const type = Buffer.alloc(4);
  type.writeUInt32LE(0x08000001);
  return {
    imr: 3,
    event_type: 0x08000001,
    digest: sha384(type, ":", event, ":", payload).toString("hex"),
    event,
    event_payload: payloadHex,
  };
}
const composeEvent = () => runtimeEvent("compose-hash", COMPOSE);

function build(os: string = PROD_OS) {
  const boot = [
    { imr: 0, event_type: 1, digest: "02".repeat(48), event: "", event_payload: "" },
    { imr: 1, event_type: 1, digest: "03".repeat(48), event: "", event_payload: "" },
    { imr: 2, event_type: 1, digest: "04".repeat(48), event: "", event_payload: "" },
  ];
  const instance = {
    imr: 3,
    event_type: 0x08000001,
    digest: "05".repeat(48),
    event: "instance-id",
    event_payload: "00",
  };
  const log = [...boot, instance, composeEvent(), runtimeEvent("os-image-hash", os)];
  const rtmr = (imr: number) =>
    extend(log.filter((e) => e.imr === imr).map((e) => Buffer.from(e.digest, "hex"))).toString(
      "hex",
    );
  const facts: QuoteFacts = {
    status: "UpToDate",
    mrTd: MR.mrTd,
    rtMr0: rtmr(0),
    rtMr1: rtmr(1),
    rtMr2: rtmr(2),
    rtMr3: rtmr(3),
    reportData: `${teeReportData({ codeHash: CODE, evmAddress: EVM, solanaPublicKey: SOL, nonce: NONCE }).slice(2)}${"0".repeat(64)}`,
  };
  const evidence = {
    quote: "0xabcd",
    eventLog: JSON.stringify(log),
    composeHash: COMPOSE,
    codeHash: CODE,
    evmAddress: EVM,
    solanaPublicKey: SOL,
    nonce: NONCE,
  };
  return { facts, evidence, log };
}

const verifier =
  (facts: QuoteFacts): QuoteVerifier =>
  async () =>
    facts;
const expectation = (facts: QuoteFacts) => ({
  nonce: NONCE,
  codeHash: CODE,
  composeHash: COMPOSE,
  verifyQuote: verifier(facts),
});
const rejects = (promise: Promise<unknown>, reason: RegExp) =>
  expect(promise).rejects.toThrow(reason);

describe("verifyTeeEvidence", () => {
  it("accepts good evidence and measures the platform and compose hash", async () => {
    const { facts, evidence } = build();
    const tee = await verifyTeeEvidence(evidence, expectation(facts));
    expect(tee.measurement).toBe(teeMeasurement({ ...facts, composeHash: COMPOSE }));
    expect(tee).toMatchObject({ evmAddress: EVM, solanaPublicKey: SOL, tcbStatus: "UpToDate" });
  });

  it("gives two instances of the same app the same measurement", async () => {
    const a = build();
    const b = build();
    b.log[3]!.digest = "09".repeat(48);
    b.evidence.eventLog = JSON.stringify(b.log);
    b.facts.rtMr3 = extend(
      b.log.filter((e) => e.imr === 3).map((e) => Buffer.from(e.digest, "hex")),
    ).toString("hex");
    const first = await verifyTeeEvidence(a.evidence, expectation(a.facts));
    const second = await verifyTeeEvidence(b.evidence, expectation(b.facts));
    expect(second.measurement).toBe(first.measurement);
  });

  it("accepts SWHardeningNeeded but refuses an out-of-date platform", async () => {
    const { facts, evidence } = build();
    await expect(
      verifyTeeEvidence(evidence, expectation({ ...facts, status: "SWHardeningNeeded" })),
    ).resolves.toBeDefined();
    await rejects(
      verifyTeeEvidence(evidence, expectation({ ...facts, status: "OutOfDate" })),
      /TCB status is OutOfDate/,
    );
    await rejects(
      verifyTeeEvidence(evidence, expectation({ ...facts, status: "Revoked" })),
      /Revoked/,
    );
  });

  it("refuses when the quote does not verify", async () => {
    const { evidence } = build();
    await rejects(
      verifyTeeEvidence(evidence, {
        ...expectation(build().facts),
        verifyQuote: async () => {
          throw new Error("bad signature");
        },
      }),
      /did not verify: bad signature/,
    );
  });

  it("refuses a quote that is not a real TDX quote, using the real verifier", async () => {
    const { evidence } = build();
    await rejects(
      verifyTeeEvidence(evidence, { nonce: NONCE, codeHash: CODE, composeHash: COMPOSE }),
      /malformed/,
    );
  });

  it("refuses a quote that does not commit to these keys, this code and this nonce", async () => {
    const { facts, evidence } = build();
    for (const changed of [
      { evmAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      { solanaPublicKey: "11111111111111111111111111111113" },
    ])
      await rejects(
        verifyTeeEvidence({ ...evidence, ...changed }, expectation(facts)),
        /does not commit/,
      );
    await rejects(
      verifyTeeEvidence(evidence, expectation({ ...facts, reportData: "00".repeat(64) })),
      /does not commit/,
    );
  });

  it("refuses an answer to a different challenge or about different code", async () => {
    const { facts, evidence } = build();
    await rejects(
      verifyTeeEvidence({ ...evidence, nonce: hash(10) }, expectation(facts)),
      /different challenge/,
    );
    await rejects(
      verifyTeeEvidence(evidence, { ...expectation(facts), codeHash: hash(8) }),
      /different code/,
    );
    await rejects(
      verifyTeeEvidence(evidence, { ...expectation(facts), composeHash: "cd".repeat(32) }),
      /different deployment/,
    );
  });

  it("refuses an event log that does not replay to the quote's registers", async () => {
    const { facts, evidence, log } = build();
    const tampered = log.map((e) => (e.imr === 1 ? { ...e, digest: "ff".repeat(48) } : e));
    await rejects(
      verifyTeeEvidence({ ...evidence, eventLog: JSON.stringify(tampered) }, expectation(facts)),
      /does not replay to RTMR1/,
    );
  });

  it("refuses a compose-hash event whose payload was swapped", async () => {
    const { facts, evidence, log } = build();
    // Same digest (so the replay still matches the quote), different payload.
    const forged = log.map((e) =>
      e.event === "compose-hash" ? { ...e, event_payload: "cd".repeat(32) } : e,
    );
    await rejects(
      verifyTeeEvidence({ ...evidence, eventLog: JSON.stringify(forged) }, expectation(facts)),
      /does not match its digest/,
    );
  });

  it("refuses a missing or duplicated compose-hash event", async () => {
    const { evidence, log, facts } = build();
    const without = log.filter((e) => e.event !== "compose-hash");
    const noCompose = {
      ...facts,
      rtMr3: extend(
        without.filter((e) => e.imr === 3).map((e) => Buffer.from(e.digest, "hex")),
      ).toString("hex"),
    };
    await rejects(
      verifyTeeEvidence({ ...evidence, eventLog: JSON.stringify(without) }, expectation(noCompose)),
      /exactly one compose-hash event/,
    );
  });

  it("refuses malformed evidence and event logs", async () => {
    const { facts, evidence } = build();
    await rejects(verifyTeeEvidence({ nope: true }, expectation(facts)), /malformed/);
    await rejects(
      verifyTeeEvidence({ ...evidence, eventLog: "not json" }, expectation(facts)),
      /not JSON/,
    );
    await rejects(
      verifyTeeEvidence({ ...evidence, eventLog: '[{"imr":0}]' }, expectation(facts)),
      /malformed entry/,
    );
  });

  it("accepts only an approved production OS image", async () => {
    const approved = build();
    const tee = await verifyTeeEvidence(approved.evidence, expectation(approved.facts));
    expect(tee.osImageHash).toBe(PROD_OS);
    // A development image: genuine hardware, SSH into the VM, so the keys are not safe.
    const dev = build(DEV_OS_IMAGE_0_5_9);
    await rejects(
      verifyTeeEvidence(dev.evidence, expectation(dev.facts)),
      /not an approved production image/,
    );
    // Some other image nobody approved.
    const other = build("ee".repeat(32));
    await rejects(
      verifyTeeEvidence(other.evidence, expectation(other.facts)),
      /not an approved production image/,
    );
  });

  it("never lists the development image as approved", () => {
    expect(Object.values(APPROVED_OS_IMAGES)).not.toContain(DEV_OS_IMAGE_0_5_9);
  });

  it("can be told a different set of approved images", async () => {
    const other = build("ee".repeat(32));
    await expect(
      verifyTeeEvidence(other.evidence, {
        ...expectation(other.facts),
        approvedOsImages: ["ee".repeat(32)],
      }),
    ).resolves.toBeDefined();
  });

  it("refuses a log with no OS image event, or with the event twice", async () => {
    const { evidence, log, facts } = build();
    const rtmr3 = (entries: typeof log) =>
      extend(entries.filter((e) => e.imr === 3).map((e) => Buffer.from(e.digest, "hex"))).toString(
        "hex",
      );
    const without = log.filter((e) => e.event !== "os-image-hash");
    await rejects(
      verifyTeeEvidence(
        { ...evidence, eventLog: JSON.stringify(without) },
        expectation({ ...facts, rtMr3: rtmr3(without) }),
      ),
      /exactly one os-image-hash/,
    );
    const twice = [...log, log.at(-1)!];
    await rejects(
      verifyTeeEvidence(
        { ...evidence, eventLog: JSON.stringify(twice) },
        expectation({ ...facts, rtMr3: rtmr3(twice) }),
      ),
      /exactly one os-image-hash/,
    );
  });

  it("treats a malformed event log as a verification failure, never as another kind of error", async () => {
    const { evidence, facts } = build();
    const good = JSON.parse(evidence.eventLog) as Record<string, unknown>[];
    const bad = [
      "[null]",
      "[1]",
      '["x"]',
      "[[]]",
      JSON.stringify([{ ...good[0], event_type: -1 }]),
      JSON.stringify([{ ...good[0], event_type: 2 ** 32 }]),
      JSON.stringify([{ ...good[0], event_type: 1.5 }]),
      JSON.stringify([{ ...good[0], imr: 7 }]),
      JSON.stringify([{ ...good[0], imr: -1 }]),
      JSON.stringify([{ ...good[0], digest: "zz" }]),
      JSON.stringify([{ ...good[0], digest: "abc" }]),
      JSON.stringify([{ ...good[0], digest: "00".repeat(49) }]),
      JSON.stringify([{ ...good[0], event_payload: "xyz" }]),
      JSON.stringify([{ ...good[0], event: 5 }]),
      "{}",
    ];
    for (const eventLog of bad)
      await expect(
        verifyTeeEvidence({ ...evidence, eventLog }, expectation(facts)),
      ).rejects.toBeInstanceOf(TeeVerificationError);
  });

  it("throws TeeVerificationError", async () => {
    const { facts, evidence } = build();
    await expect(
      verifyTeeEvidence(evidence, expectation({ ...facts, status: "Revoked" })),
    ).rejects.toBeInstanceOf(TeeVerificationError);
  });
});

describe("attestTeeAgent", () => {
  it("sends a fresh nonce and verifies the answer", async () => {
    const { facts, evidence } = build();
    let nonce = "";
    const tee = await attestTeeAgent({
      url: "https://agent.example",
      codeHash: CODE,
      composeHash: COMPOSE,
      // Echo the nonce the Arena sent; report data is bound to NONCE in this fixture, so rebuild it.
      verifyQuote: async () => ({
        ...facts,
        reportData: `${teeReportData({ codeHash: CODE, evmAddress: EVM, solanaPublicKey: SOL, nonce }).slice(2)}${"0".repeat(64)}`,
      }),
      fetch: (async (input: URL) => {
        nonce = input.searchParams.get("nonce")!;
        return Response.json({ ...evidence, nonce });
      }) as unknown as typeof fetch,
    });
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(tee.measurement).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("uses a different nonce every time", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++)
      await attestTeeAgent({
        url: "https://agent.example",
        codeHash: CODE,
        composeHash: COMPOSE,
        fetch: (async (input: URL) => {
          seen.add(input.searchParams.get("nonce")!);
          return new Response("no", { status: 500 });
        }) as unknown as typeof fetch,
      }).catch(() => undefined);
    expect(seen.size).toBe(3);
  });

  it("separates an agent that can't be reached from one that fails verification", async () => {
    const base = { codeHash: CODE, composeHash: COMPOSE, url: "https://agent.example" };
    const fetchWith = (impl: () => Promise<Response>) => impl as unknown as typeof fetch;
    for (const down of [
      fetchWith(async () => {
        throw new TypeError("fetch failed");
      }),
      fetchWith(async () => new Response("bad gateway", { status: 502 })),
    ])
      await expect(attestTeeAgent({ ...base, fetch: down })).rejects.toBeInstanceOf(
        TeeUnavailableError,
      );
    const notJson = fetchWith(async () => new Response("<html>", { status: 200 }));
    await expect(attestTeeAgent({ ...base, fetch: notJson })).rejects.toBeInstanceOf(
      TeeVerificationError,
    );
    const garbage = fetchWith(async () => Response.json({ nope: true }));
    await expect(attestTeeAgent({ ...base, fetch: garbage })).rejects.toBeInstanceOf(
      TeeVerificationError,
    );
  });

  it("lets a quote verifier's unavailability through as unavailable", async () => {
    const { facts, evidence } = build();
    await expect(
      verifyTeeEvidence(evidence, {
        ...expectation(facts),
        verifyQuote: async () => {
          throw new TeeUnavailableError("PCCS is down");
        },
      }),
    ).rejects.toBeInstanceOf(TeeUnavailableError);
  });

  it("refuses plain http except on localhost, and refuses an error response", async () => {
    const base = { codeHash: CODE, composeHash: COMPOSE };
    await rejects(attestTeeAgent({ ...base, url: "http://agent.example" }), /must use https/);
    await rejects(
      attestTeeAgent({
        ...base,
        url: "http://localhost:8080",
        fetch: (async () => new Response("no", { status: 502 })) as unknown as typeof fetch,
      }),
      /answered 502/,
    );
  });
});

// Evidence captured from a real Phala Cloud TDX VM (dstack 0.5.9, production OS). Intel's check of
// the quote is replaced by the facts it returned at capture time, since collateral needs the
// network. Everything else is verified for real, including the way dstack leaves the digest empty
// for runtime events.
describe("evidence from a real dstack TDX VM", () => {
  const live = JSON.parse(
    readFileSync(new URL("./fixtures/tee-live.json", import.meta.url), "utf8"),
  ) as { evidence: Record<string, string>; facts: QuoteFacts };
  const expected = {
    nonce: live.evidence.nonce!,
    codeHash: live.evidence.codeHash as `0x${string}`,
    composeHash: live.evidence.composeHash!,
    verifyQuote: verifier(live.facts),
  };
  const log = JSON.parse(live.evidence.eventLog!) as {
    imr: number;
    event: string;
    digest: string;
    event_payload: string;
  }[];

  it("passes the production OS policy, and fails it if only another image is approved", async () => {
    const tee = await verifyTeeEvidence(live.evidence, expected);
    expect(tee.osImageHash).toBe(PROD_OS);
    expect(tee.osImageHash).not.toBe(DEV_OS_IMAGE_0_5_9);
    await rejects(
      verifyTeeEvidence(live.evidence, { ...expected, approvedOsImages: [DEV_OS_IMAGE_0_5_9] }),
      /not an approved production image/,
    );
  });

  it("has runtime events with no digest, as the real guest agent sends them", () => {
    expect(log.some((e) => e.imr === 3 && e.digest === "")).toBe(true);
  });

  it("verifies and measures the platform and compose hash", async () => {
    const tee = await verifyTeeEvidence(live.evidence, expected);
    expect(tee.measurement).toBe(
      teeMeasurement({ ...live.facts, composeHash: live.evidence.composeHash! }),
    );
    expect(tee.tcbStatus).toBe("UpToDate");
  });

  it("refuses when any runtime event's payload is altered", async () => {
    for (const event of ["compose-hash", "app-id", "os-image-hash"]) {
      const forged = log.map((e) =>
        e.event === event ? { ...e, event_payload: "cd".repeat(e.event_payload.length / 2) } : e,
      );
      await rejects(
        verifyTeeEvidence({ ...live.evidence, eventLog: JSON.stringify(forged) }, expected),
        /does not replay to RTMR3/,
      );
    }
  });

  it("refuses a different published compose hash", async () => {
    await rejects(
      verifyTeeEvidence(live.evidence, { ...expected, composeHash: "cd".repeat(32) }),
      /different deployment/,
    );
  });
});
