import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { SENTINEL_GATES, SENTINEL_MODEL } from "../lib/sentinel-facts";
import { Badge, ErrorText, Page, buttonClass, linkClass } from "../components/ui";
import { StatLoading, StatStrip } from "../components/stat-strip";

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

const RATED_WITH: [string, string][] = [
  [
    "Every attack meets Sentinel first",
    "The whole rating runs with Sentinel in front of your agent, exactly as it will trade.",
  ],
  [
    "A discount that's measured",
    "If Sentinel stops attacks, your agent breaches less, scores higher and its cover costs less.",
  ],
  [
    "Labelled, never passed off",
    "The report and the agent's page say Sentinel was on, and the rating has its own code hash.",
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
      intro="A guard built on Laya, Convai Innovations' open-source decision model. It checks each trade before it runs and stops the ones driven by what the agent read, not its mandate. It only advises: the vault decides payouts."
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

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-serif text-3xl leading-tight">How v5 was tested</h2>
            <p className="mt-2 max-w-[60ch] text-sm text-muted">
              Five gates against the previous model, v1, before it went live. It passed four and was
              promoted with the fifth's exception recorded.
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
        {/* Each card spans five shared rows, so names, numbers and notes line up across cards. */}
        <ul className="panel mt-5 grid overflow-hidden p-0 md:grid-cols-2 xl:grid-cols-5">
          {SENTINEL_GATES.map((g) => (
            <li
              key={g.name}
              className="row-span-5 grid grid-rows-subgrid border-b border-line p-5 last:border-b-0 md:[&:nth-child(odd)]:border-r md:last:col-span-2 md:last:border-r-0 xl:border-b-0 xl:last:col-span-1 xl:[&:not(:last-child)]:border-r"
            >
              <span>
                <Badge tone={g.passed ? "safe" : "warn"} dot>
                  {g.passed ? "Passed" : "Exception"}
                </Badge>
              </span>
              <p className="mt-3 font-semibold">{g.name}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">{g.what}</p>
              <div className="mt-6">
                <p className="flex items-baseline gap-2 tabular-nums">
                  <span className="font-serif text-[36px] leading-none">{g.after}</span>
                  <span className="text-sm text-muted">
                    from <span className="text-soft">{g.before}</span>
                  </span>
                </p>
                <p className="mt-1.5 text-xs text-muted">{g.measure}</p>
              </div>
              <p
                className={`text-xs leading-relaxed ${g.note ? "mt-3 border-t border-line pt-3" : ""} ${g.passed ? "text-muted" : "text-warn"}`}
              >
                {g.note}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Big number: v5. Smaller: v1 on the same cases. Where v5 still misses is tracked in{" "}
          <a href={SENTINEL_MODEL.issue} target="_blank" rel="noreferrer" className={linkClass}>
            issue #55
          </a>
          .
        </p>
      </section>

      <section className="grid gap-8 border-t border-line pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div>
          <h2 className="font-serif text-3xl leading-tight">Rate your agent with Sentinel on</h2>
          <p className="mt-3 max-w-[48ch] text-sm leading-relaxed text-muted">
            Choose it when you onboard an agent. Your agent then asks Sentinel before each trade.
          </p>
          <Link to="/agents/new" className={`mt-6 ${buttonClass("primary")}`}>
            Onboard an agent
          </Link>
        </div>
        <ul className="grid content-start gap-6">
          {RATED_WITH.map(([title, text]) => (
            <li key={title} className="flex gap-4">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
              <span>
                <span className="block font-semibold">{title}</span>
                <span className="mt-1 block text-sm leading-relaxed text-muted">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
