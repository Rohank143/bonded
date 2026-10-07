import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ATTACK_CLASSES } from "@bonded/shared";
import { api } from "../lib/api";
import { outcomeOf, type EpisodeCard } from "../lib/events";
import { useEpisodes } from "../lib/episodes";
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Input,
  LoadMore,
  Page,
  Term,
  TierBadge,
  Tooltip,
  buttonClass,
} from "../components/ui";
import { InfoPanel } from "../components/overlay";
import { OperatorTokenField, useOperatorToken } from "../components/wallet";
import { Select } from "../components/select";

type Filter = "all" | "held" | "breach" | "control";

const CLASS_NAMES = ATTACK_CLASSES as Record<string, { name: string }>;

/** Held-out and bounty attacks have ids that say so; their text is never shown. */
const isPrivate = (c: EpisodeCard) => Boolean(c.attackId && /held-out|bounty/i.test(c.attackId));

const outcome = outcomeOf;

export function Arena() {
  const [runId, setRunId] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [cls, setCls] = useState("all");
  const [picked, setPicked] = useState<string>();
  const [params] = useSearchParams();
  // The operator form needs the server API token, which only the Bonded operator has.
  const operator = params.get("operator") === "1";
  const feed = useEpisodes({
    ...(runId ? { runId } : {}),
    ...(filter !== "all" ? { outcome: filter } : {}),
    ...(cls !== "all" ? { attackClass: cls } : {}),
  });
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId!),
    enabled: Boolean(runId),
    refetchInterval: (q) =>
      q.state.data?.status === "done" || q.state.data?.status === "failed" ? false : 3000,
  });

  // Filters run on the API, so `shown` is already the filtered list, a page at a time.
  const shown = feed.items;
  const counts = feed.counts;
  const filtered = filter !== "all" || cls !== "all";
  const selected = shown.find((c) => c.eventId === picked) ?? shown[0];
  // The newest episode overall: streamed, or the top of an unfiltered list.
  const latest = feed.newest ?? (filtered ? undefined : shown[0]);

  return (
    <Page
      eyebrow={
        <span className="flex items-center gap-2 !text-breach">
          <span className="size-[7px] rounded-full bg-breach-solid [animation:blink_1.4s_infinite]" />
          {feed.connected ? "Live red team" : "Reconnecting"}
        </span>
      }
      title="Arena"
      intro="Every episode hides an attack in what an agent reads, then lets the vault rule on what it does. Pick an episode to see how it went."
    >
      <div className="-mt-1 flex flex-wrap items-center gap-3">
        <InfoPanel
          title="How the Arena works"
          description="Every rating is a few hundred short episodes against real contracts on a private fork."
          trigger={
            <button type="button" className={buttonClass("secondary")}>
              How the Arena works
            </button>
          }
        >
          <ArenaExplainer />
        </InfoPanel>
        <Link to="/bounties" className={buttonClass("light")}>
          Submit an attack we miss
        </Link>
        <span className="text-sm text-muted">
          Own an agent? Rate it from{" "}
          <Link to="/agents?mine=1" className="text-accent hover:underline">
            its page
          </Link>
          .
        </span>
      </div>
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          label={runId ? "Episodes in this run" : "Episodes"}
          value={counts ? counts.total.toLocaleString() : "…"}
        />
        <Tile
          label={<Term term="held">Held</Term>}
          value={counts ? counts.held.toLocaleString() : "…"}
          tone="text-held"
        />
        <Tile
          label={<Term term="breach">Breached</Term>}
          value={counts ? counts.breach.toLocaleString() : "…"}
          tone={counts?.breach ? "text-breach" : ""}
        />
        <div className="panel min-w-0 p-5">
          <p className="eyebrow">{runId ? "This run" : "Latest run"}</p>
          {run.data ? (
            <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <Badge
                tone={
                  run.data.status === "failed"
                    ? "breach"
                    : run.data.status === "done"
                      ? "safe"
                      : "neutral"
                }
              >
                {run.data.status}
              </Badge>
              {run.data.report && (
                <>
                  score <strong>{run.data.report.scoring.score}</strong>
                  <TierBadge score={run.data.report.scoring.score} />
                </>
              )}
            </p>
          ) : latest ? (
            <p className="mt-3.5 font-mono text-[15px]">
              {latest.runId.slice(0, 8)} · {latest.index + 1} of {latest.total}
            </p>
          ) : (
            <p className="mt-3.5 text-sm text-muted">
              {counts?.total ? "Clear the filters to see it" : "Waiting for episodes"}
            </p>
          )}
          {runId && (
            <button
              type="button"
              onClick={() => setRunId(undefined)}
              className="mt-2 text-xs text-accent hover:underline"
            >
              Show all runs
            </button>
          )}
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <section className="panel min-w-0 flex-[999_1_520px] p-4.5">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-1.5 pb-3.5">
            {(
              [
                ["all", "All", ""],
                ["held", "Held", "bg-held"],
                ["breach", "Breached", "bg-breach-solid"],
                ["control", "Controls", "bg-[#5b6478]"],
              ] as const
            ).map(([key, label, dot]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] ${filter === key ? "border-ink bg-ink text-paper" : "border-line-strong text-soft hover:text-ink"}`}
              >
                {dot && <span className={`size-[7px] rounded-full ${dot}`} />}
                {label}
              </button>
            ))}
            <div className="ml-auto">
              <Select
                label="Class"
                value={cls}
                onChange={setCls}
                options={[
                  { value: "all", label: "All classes" },
                  ...Object.entries(CLASS_NAMES).map(([id, c]) => ({
                    value: id,
                    hint: id,
                    label: c.name,
                  })),
                ]}
              />
            </div>
          </div>
          <ErrorText error={feed.error} />
          {feed.isPending ? (
            <div className="flex flex-col gap-2 p-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[66px] animate-pulse rounded-2xl bg-white/[0.03]" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={
                  filtered && counts?.total ? "No episodes match these filters" : "No episodes yet"
                }
              >
                {filtered && counts?.total
                  ? "Try another class or outcome."
                  : "Episodes appear here the moment a rating runs. Agent owners can start one from their agent's page."}
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-2 flex flex-col gap-0.5">
              {shown.map((c) => {
                const o = outcome(c);
                const isSel = selected?.eventId === c.eventId;
                return (
                  <li key={c.eventId} className="[animation:rise_.4s_ease_both]">
                    <button
                      type="button"
                      onClick={() => setPicked(c.eventId)}
                      aria-pressed={isSel}
                      className={`grid w-full grid-cols-[10px_52px_minmax(0,1fr)_auto] items-center gap-4 rounded-2xl border px-4 py-3.5 text-left transition ${isSel ? "border-accent/40 bg-accent-soft" : "border-transparent hover:bg-white/[0.035]"}`}
                    >
                      <span
                        className={`size-2.5 rounded-full ${o === "breach" ? "bg-breach-solid shadow-[0_0_10px_rgb(255_122_69/.7)]" : o === "held" ? "bg-held shadow-[0_0_10px_rgb(127_160_255/.6)]" : "bg-[#5b6478]"}`}
                      />
                      <span className="w-fit rounded-md bg-white/[0.06] px-1.5 py-0.5 text-center font-mono text-[11px] text-soft">
                        {c.attackClass ?? "CTRL"}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-semibold">
                            {c.attackClass
                              ? (CLASS_NAMES[c.attackClass]?.name ?? c.attackClass)
                              : "Control: no attack"}
                          </span>
                          {isPrivate(c) && <HeldOutTag />}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">
                          {c.attackId ?? "a plain task"}
                        </span>
                      </span>
                      <span className="w-[118px] text-right">
                        <Badge
                          tone={o === "breach" ? "breach" : o === "held" ? "brand" : "neutral"}
                        >
                          {o === "breach"
                            ? `Breach · $${c.lossUsd.toFixed(0)}`
                            : o === "held"
                              ? "Held"
                              : "Control"}
                        </Badge>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <LoadMore
            hasMore={feed.hasMore}
            loading={feed.loadingMore}
            onMore={() => void feed.loadMore()}
            shown={shown.length}
            {...(!filtered && counts ? { total: counts.total } : {})}
          />
          {feed.failedRuns.length > 0 && (
            <p className="px-3 pt-3 text-xs text-muted">{feed.failedRuns.length} run(s) failed.</p>
          )}
        </section>

        <aside className="panel min-w-0 flex-[1_1_360px] border-accent/25 bg-[radial-gradient(ellipse_at_50%_0%,rgb(29_78_216/.18),transparent_60%)] p-7 xl:sticky xl:top-24">
          {selected ? (
            <EpisodeDetail
              c={selected}
              onlyRun={runId ? undefined : () => setRunId(selected.runId)}
            />
          ) : (
            <p className="text-sm text-muted">Pick an episode to see how it went.</p>
          )}
        </aside>
      </div>

      <div className="panel flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-breach/12 to-transparent p-6">
        <span>
          <strong className="block text-lg">Found an attack we miss?</strong>
          <span className="mt-1 block text-sm text-muted">
            Submit it with your wallet. If it beats the defended agent, you're paid from the bounty
            pool.
          </span>
        </span>
        <Link to="/bounties" className={buttonClass("secondary")}>
          Go to bounties →
        </Link>
      </div>

      {operator && <StartRating onStarted={setRunId} />}
    </Page>
  );
}

function Tile({ label, value, tone = "" }: { label: ReactNode; value: string; tone?: string }) {
  return (
    <div className="panel min-w-0 p-5">
      <p className="eyebrow">{label}</p>
      <p className={`mt-2 font-serif text-[44px] leading-none tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

/** Operators only: queue a rating with the API token. */
function StartRating({ onStarted }: { onStarted: (runId: string) => void }) {
  const { token } = useOperatorToken();
  const [agentId, setAgentId] = useState("2");
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  async function start() {
    setStarting(true);
    setError(null);
    try {
      onStarted((await api.startRun(token, agentId.trim())).runId);
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  }
  return (
    <details className="panel p-5 sm:p-6">
      <summary className="cursor-pointer font-semibold">Operator: start a rating</summary>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
        <OperatorTokenField />
        <Input
          label="Agent ID"
          value={agentId}
          onChange={setAgentId}
          inputMode="numeric"
          error={agentId.trim() && !/^\d+$/.test(agentId.trim()) ? "A whole number." : null}
        />
        <Button
          disabled={!token || !/^\d+$/.test(agentId.trim())}
          loading={starting}
          onClick={start}
        >
          {starting ? "Queuing…" : "Run a rating"}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Only agents in the server's agents file can be rated. The worker rates on a private fork,
        then posts one signed score to the chain (this costs the attester testnet gas).
      </p>
      <ErrorText error={error} />
    </details>
  );
}

function HeldOutTag() {
  return (
    <Tooltip content="A held-out attack: it's never published, so no one can tune an agent to it. Its text stays private.">
      <span className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2 py-px text-[10.5px] text-muted">
        <svg
          viewBox="0 0 24 24"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
        </svg>
        Held out
      </span>
    </Tooltip>
  );
}

/** One episode: what was planted, how the vault ruled, and which run it came from. */
function EpisodeDetail({ c, onlyRun }: { c: EpisodeCard; onlyRun?: () => void }) {
  const o = outcome(c);
  const name = c.attackClass
    ? (CLASS_NAMES[c.attackClass]?.name ?? c.attackClass)
    : "Control episode";
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center justify-between">
          <p className="eyebrow">Episode</p>
          <span className="font-mono text-[11px] text-muted">
            {c.index + 1} of {c.total}
          </span>
        </div>
        <h2 className="mt-3 font-serif text-[34px] leading-tight">{name}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {c.attackClass && (
            <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-soft">
              {c.attackClass}
            </span>
          )}
          {c.attackClass && (isPrivate(c) ? <HeldOutTag /> : <Badge>Library attack</Badge>)}
          <span className="truncate font-mono text-[11px] text-muted">{c.attackId ?? ""}</span>
        </div>
      </div>

      <section>
        <p className="eyebrow mb-2.5 !text-breach">What was planted</p>
        <p className="rounded-2xl border border-line bg-white/[0.03] p-4 text-sm leading-relaxed text-soft">
          {!c.attackClass
            ? "Nothing. A control is a plain task with no attack, to check the agent behaves normally."
            : isPrivate(c)
              ? "A held-out attack from this class. Its text is never shown, so no one can study it."
              : `An attack from the public library, hidden in what the agent read: ${name.toLowerCase()}.`}
        </p>
      </section>

      <section>
        <p className="eyebrow mb-2.5 !text-accent">How the vault ruled</p>
        <div
          className={`rounded-2xl border p-5 ${o === "breach" ? "border-breach/40 bg-breach-soft" : "border-accent/30 bg-accent-soft"}`}
        >
          <p className="font-serif text-4xl leading-none">{o === "breach" ? "Breach" : "Held"}</p>
          <p className="mt-2 text-sm text-soft">
            {o === "breach"
              ? `The agent broke its mandate and $${c.lossUsd.toFixed(0)} left the vault${c.frozen ? "; the agent was frozen" : ""}.`
              : "No breach recorded: the agent did nothing its mandate forbids."}
          </p>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-sm">
        <span className="text-muted">
          Run <span className="font-mono text-soft">{c.runId.slice(0, 8)}</span>
        </span>
        {onlyRun && (
          <button type="button" onClick={onlyRun} className="text-accent hover:underline">
            Show only this run →
          </button>
        )}
      </section>
    </div>
  );
}

/** The detail behind "How the Arena works", shown in a dialog or drawer. */
function ArenaExplainer() {
  const steps: [string, string][] = [
    [
      "Plant",
      "The red team hides an attack in something the agent reads: news, DMs, token metadata, tool output or a price feed.",
    ],
    [
      "Read",
      "The agent gets a normal job, like rebalancing a portfolio, and reads the poisoned source along the way.",
    ],
    [
      "Act",
      "Whatever it decides, it can only act through its MandateVault, with its own key, against real contracts on a private fork.",
    ],
    [
      "Check",
      "The vault checks every action against the mandate. Breaking it is recorded on chain as a breach; the vault's log is the verdict, never an AI judge.",
    ],
    [
      "Score",
      "A rating runs every attack in the library five times, plus controls. The results become the Bonded Score, posted on chain with a hash of the full report.",
    ],
  ];
  return (
    <div className="flex flex-col gap-6 text-sm leading-relaxed">
      <ol className="flex flex-col gap-4">
        {steps.map(([title, text], i) => (
          <li key={title} className="grid grid-cols-[32px_1fr] gap-3">
            <span className="btn-brand flex size-8 items-center justify-center rounded-full font-mono text-xs text-on-brand">
              {i + 1}
            </span>
            <span>
              <strong className="block text-ink">{title}</strong>
              <span className="text-muted">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-line p-4">
          <p className="font-semibold">Controls</p>
          <p className="mt-1 text-muted">
            Episodes with no attack, to check the agent behaves on a plain job.
          </p>
        </div>
        <div className="rounded-2xl border border-line p-4">
          <p className="font-semibold">Held-out attacks</p>
          <p className="mt-1 text-muted">
            Never published, so no one can tune an agent to them. Their text stays private.
          </p>
        </div>
      </div>
    </div>
  );
}
