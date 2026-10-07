import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { SENTINEL_GATES, SENTINEL_MODEL } from "../lib/sentinel-facts";
import { Badge, ErrorText, Page, buttonClass, linkClass } from "../components/ui";
import { StatLoading, StatStrip } from "../components/stat-strip";

/** What an agent sends and signs to ask Sentinel about one action. */
const CHECK_EXAMPLE = `import {
  sentinelCheckDigest, sentinelCheckMessage,
} from "@bonded/shared";

// Before each trade: what the agent read, and what it wants to do.
const body = {
  mandate: "You manage a vault holding tUSDG and tNVDA ...",
  proposedAction: { tool: "swap", args: { tokenIn: "tUSDG", amount: "100" } },
  untrustedInputs: [{ tool: "read_news", output: "..." }],
};
const timestamp = Math.floor(Date.now() / 1000);
// Signed with the agent's own key: the vault's agent() address.
const signature = await agentKey.signMessage({
  message: sentinelCheckMessage({
    chainId, agentId, vault, timestamp,
    digest: sentinelCheckDigest(body),
  }),
});
const res = await fetch(\`\${API}/sentinel/check\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ agentId, vault, timestamp, signature, ...body }),
});
// Trade only on a clear "not blocked": throttled, busy or unreachable
// (429 or 503) means Sentinel couldn't assess it, so don't go ahead.
const answer = res.ok ? await res.json() : undefined;
if (typeof answer?.blocked !== "boolean" || answer.blocked) {
  return; // skip this trade, or retry the check after a pause
}`;

const STEPS: [string, string][] = [
  [
    "The agent proposes a trade",
    "Before it sends anything, it asks Sentinel about the action it wants to take.",
  ],
  [
    "Sentinel reads only what matters",
    "The mandate, the proposed action and what the agent read from outside, in separate fields. Never the agent's whole conversation.",
  ],
  [
    "It answers two questions",
    "Is this action driven by what the agent read rather than its mandate? Do those inputs carry instructions aimed at the agent?",
  ],
  [
    "A manipulated action is stopped",
    "At 70% confidence or more, the check says block. The vault still enforces the mandate either way.",
  ],
];

/** Sentinel: what it is, whether it's running, how it was tested, and how to use it. */
export function Sentinel() {
  const status = useQuery({
    queryKey: ["sentinel"],
    queryFn: api.sentinel,
    refetchInterval: 30_000,
  });
  const s = status.data;

  return (
    <Page
      title="Sentinel"
      intro="A guard that checks each trade an agent proposes before it runs, and stops the ones driven by something the agent read instead of its mandate. It only advises: payouts are decided by the vault alone."
      actions={
        <a
          href={SENTINEL_MODEL.overview}
          target="_blank"
          rel="noreferrer"
          className={buttonClass("secondary")}
        >
          How it's built →
        </a>
      }
    >
      <StatStrip
        stats={[
          {
            label: "Status",
            value: s ? (
              <span
                className={s.available ? "text-safe" : s.configured ? "text-breach" : "text-muted"}
              >
                {s.available ? "Running" : s.configured ? "Not answering" : "Off"}
              </span>
            ) : (
              <StatLoading />
            ),
          },
          {
            label: "Model",
            value: <span className="text-[28px]">v5</span>,
            hint: SENTINEL_MODEL.name,
          },
          {
            label: "Blocks at",
            value: s?.blockThreshold ? `${Math.round(s.blockThreshold * 100)}%` : "70%",
            hint: "confidence it was manipulated",
          },
          {
            label: "Checks today",
            value: s ? s.last24h.checks.toLocaleString() : <StatLoading />,
            ...(s ? { hint: `${s.last24h.blocked.toLocaleString()} blocked, last 24 hours` } : {}),
          },
        ]}
      />
      <ErrorText error={status.error} />

      <section>
        <h2 className="font-serif text-3xl leading-tight">How a check works</h2>
        <ol className="panel mt-5 grid overflow-hidden p-0 md:grid-cols-2 xl:grid-cols-4">
          {STEPS.map(([title, text], i) => (
            <li
              key={title}
              className="border-b border-line p-5 last:border-b-0 md:[&:nth-child(odd)]:border-r xl:border-b-0 xl:[&:not(:last-child)]:border-r"
            >
              <span className="font-serif text-[32px] leading-none text-muted">{i + 1}</span>
              <p className="mt-3 font-semibold">{title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel p-0">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-6">
          <div>
            <h2 className="text-lg font-bold">How v5 was tested before it went live</h2>
            <p className="mt-1 max-w-[65ch] text-sm text-muted">
              Five gates against the previous model, v1. It passed four. It was promoted with the
              fifth's exception recorded; the fix is tracked for v6.
            </p>
          </div>
          <a
            href={SENTINEL_MODEL.source}
            target="_blank"
            rel="noreferrer"
            className={`text-sm ${linkClass}`}
          >
            Full results →
          </a>
        </div>
        <ul>
          {SENTINEL_GATES.map((g) => (
            <li
              key={g.name}
              className="grid gap-3 border-b border-line px-6 py-4 last:border-b-0 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center"
            >
              <span>
                <span className="block font-semibold">{g.name}</span>
                <span className="block text-xs text-muted">{g.what}</span>
              </span>
              <span className="text-sm text-muted">
                <span className="mr-1.5 text-[11px] text-muted/70">v1</span>
                {g.before}
              </span>
              <span className="text-sm text-soft">
                <span className="mr-1.5 text-[11px] text-muted/70">v5</span>
                {g.after}
              </span>
              <Badge tone={g.passed ? "safe" : "warn"}>{g.passed ? "Passed" : "Exception"}</Badge>
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-6 py-4 text-xs text-muted">
          Held out from training: attack classes {SENTINEL_MODEL.heldOutClasses.join(" and ")}.
          Speed: {SENTINEL_MODEL.speed.cpu}, {SENTINEL_MODEL.speed.gpu}. Where v5 still misses is in{" "}
          <a href={SENTINEL_MODEL.issue} target="_blank" rel="noreferrer" className={linkClass}>
            issue #55
          </a>
          .
        </p>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel flex flex-col p-6">
          <h2 className="text-lg font-bold">Rate your agent with Sentinel on</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Choose it when you onboard an agent. Every attack in the rating then runs with Sentinel
            in front of the agent. If it stops attacks, the agent breaches less, scores higher and
            its cover costs less: the discount is measured, not assumed.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            The report and the agent's page say the score was earned with Sentinel on, and the
            rating has its own code hash, so it's never passed off as the agent's score alone. Your
            agent should then ask Sentinel before each trade, as below.
          </p>
          <div className="mt-auto pt-5">
            <Link to="/agents/new" className={buttonClass("primary")}>
              Onboard an agent
            </Link>
          </div>
        </div>
        <div className="panel flex min-w-0 flex-col p-6">
          <h2 className="text-lg font-bold">Ask Sentinel before each trade</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            <code className="rounded bg-white/[0.06] px-1 font-mono text-[12px] text-soft">
              POST /sentinel/check
            </code>{" "}
            with the action and what the agent read, signed with the agent's own key (the vault's{" "}
            <code className="font-mono text-[12px]">agent()</code> address). Up to 30 checks a
            minute per agent. Nothing the agent sends is stored: only whether it blocked.
          </p>
          <pre className="mt-4 max-h-80 overflow-auto rounded-2xl border border-line bg-[#070a12] p-4 font-mono text-[12px] leading-relaxed text-soft">
            {CHECK_EXAMPLE}
          </pre>
        </div>
      </section>
    </Page>
  );
}
