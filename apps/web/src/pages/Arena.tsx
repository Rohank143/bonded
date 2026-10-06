import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ATTACK_CLASSES } from "@bonded/shared";
import { api } from "../lib/api";
import { useEpisodeFeed, type EpisodeCard } from "../lib/events";
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Input,
  Page,
  Term,
  TierBadge,
  buttonClass,
} from "../components/ui";
import { OperatorTokenField, useOperatorToken } from "../components/wallet";

type Filter = "all" | "held" | "breach" | "control";

const CLASS_NAMES = ATTACK_CLASSES as Record<string, { name: string }>;

/** Held-out and bounty attacks have ids that say so; their text is never shown. */
const isPrivate = (c: EpisodeCard) => Boolean(c.attackId && /held-out|bounty/i.test(c.attackId));

const outcome = (c: EpisodeCard): Exclude<Filter, "all"> =>
  !c.attackClass ? "control" : c.breached ? "breach" : "held";

export function Arena() {
  const [runId, setRunId] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [cls, setCls] = useState("");
  const [picked, setPicked] = useState<string>();
  const feed = useEpisodeFeed(runId);
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId!),
    enabled: Boolean(runId),
    refetchInterval: (q) =>
      q.state.data?.status === "done" || q.state.data?.status === "failed" ? false : 3000,
  });

  const cards = feed.cards;
  const held = cards.filter((c) => outcome(c) === "held").length;
  const breached = cards.filter((c) => c.breached).length;
  const shown = cards.filter(
    (c) => (filter === "all" || outcome(c) === filter) && (!cls || c.attackClass === cls),
  );
  const selected = cards.find((c) => c.eventId === picked) ?? shown[0];
  const latest = cards[0];

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
      actions={
        <>
          <a href="/#how" className={buttonClass("secondary")}>
            How the Arena works
          </a>
          <Link to="/bounties" className={buttonClass("light")}>
            Submit an attack we miss
          </Link>
        </>
      }
    >
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Episodes shown" value={String(cards.length)} />
        <Tile label={<Term term="held">Held</Term>} value={String(held)} tone="text-held" />
        <Tile
          label={<Term term="breach">Breached</Term>}
          value={String(breached)}
          tone={breached ? "text-breach" : ""}
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
            <p className="mt-3.5 text-sm text-muted">Waiting for episodes</p>
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
            <label className="ml-auto inline-flex h-8 items-center gap-2 rounded-full border border-line-strong px-3.5 text-[13px]">
              <span className="text-muted">Class</span>
              <select
                value={cls}
                onChange={(e) => setCls(e.target.value)}
                className="bg-transparent text-ink outline-none"
              >
                <option value="">All classes</option>
                {Object.entries(CLASS_NAMES).map(([id, c]) => (
                  <option key={id} value={id}>
                    {id} {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {shown.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={cards.length ? "No episodes match these filters" : "No episodes yet"}
              >
                {cards.length
                  ? "Try another class or outcome."
                  : "Episodes appear here the moment a rating runs. Agent owners can start one from their agent's page."}
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-2 flex flex-col gap-0.5">
              {shown.slice(0, 60).map((c) => {
                const o = outcome(c);
                const isSel = selected?.eventId === c.eventId;
                return (
                  <li key={c.eventId} className="[animation:rise_.4s_ease_both]">
                    <button
                      type="button"
                      onClick={() => setPicked(c.eventId)}
                      aria-pressed={isSel}
                      className={`grid w-full grid-cols-[10px_44px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-2xl border px-3.5 py-3 text-left ${isSel ? "border-accent/35 bg-accent-soft" : "border-transparent hover:bg-white/[0.035]"}`}
                    >
                      <span
                        className={`size-2.5 rounded-full ${o === "breach" ? "bg-breach-solid shadow-[0_0_10px_rgb(255_122_69/.7)]" : o === "held" ? "bg-held shadow-[0_0_10px_rgb(127_160_255/.6)]" : "bg-[#5b6478]"}`}
                      />
                      <span className="font-mono text-xs text-muted">{c.attackClass ?? "—"}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">
                          {c.attackClass
                            ? (CLASS_NAMES[c.attackClass]?.name ?? c.attackClass)
                            : "Control: no attack"}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted">
                          {c.attackId ?? "plain task"}
                          {isPrivate(c) ? " · payload private" : ""}
                        </span>
                      </span>
                      <Badge tone={o === "breach" ? "breach" : o === "held" ? "brand" : "neutral"}>
                        {o === "breach"
                          ? `Breach · $${c.lossUsd.toFixed(0)}`
                          : o === "held"
                            ? "Held"
                            : "Control"}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {feed.failedRuns.length > 0 && (
            <p className="px-3 pt-3 text-xs text-muted">{feed.failedRuns.length} run(s) failed.</p>
          )}
        </section>

        <aside className="panel min-w-0 flex-[1_1_340px] border-accent/25 bg-[radial-gradient(ellipse_at_50%_0%,rgb(29_78_216/.18),transparent_60%)] p-6 xl:sticky xl:top-24">
          <div className="flex items-center justify-between">
            <p className="eyebrow">Episode</p>
            {selected && (
              <span className="font-mono text-[11px] text-muted">
                {selected.index + 1} of {selected.total}
              </span>
            )}
          </div>
          {selected ? (
            <>
              <h2 className="mt-2.5 text-[22px] font-bold">
                {selected.attackClass
                  ? `${selected.attackClass} · ${CLASS_NAMES[selected.attackClass]?.name ?? ""}`
                  : "Control episode"}
              </h2>
              <p className="mt-1 font-mono text-[11px] text-muted">
                {selected.attackId ?? "no attack planted"}
              </p>
              <ol className="mt-5 flex flex-col gap-5 border-l border-line-strong pl-4.5">
                <li className="relative">
                  <span className="absolute top-1 -left-[24px] size-[11px] rounded-full border-2 border-breach bg-paper" />
                  <p className="eyebrow !text-breach">What the agent saw</p>
                  <p className="mt-2 text-sm text-soft">
                    {!selected.attackClass
                      ? "A normal task with no attack in it, to check the agent behaves on a plain job."
                      : isPrivate(selected)
                        ? "A held-out attack. Its text stays private so no one can study it in advance."
                        : `An attack from the public library, planted in what it read (${CLASS_NAMES[selected.attackClass]?.name.toLowerCase() ?? "attack"}).`}
                  </p>
                </li>
                <li className="relative">
                  <span className="absolute top-1 -left-[24px] size-[11px] rounded-full border-2 border-[#9db5ff] bg-paper" />
                  <p className="eyebrow !text-accent">How the vault ruled</p>
                  <div
                    className={`mt-2 flex items-center justify-between rounded-2xl border p-3.5 text-sm ${selected.breached ? "border-breach/40 bg-breach-soft" : "border-accent/30 bg-accent-soft"}`}
                  >
                    <span>
                      {selected.breached
                        ? `Breach recorded, $${selected.lossUsd.toFixed(0)} lost${selected.frozen ? ", agent frozen" : ""}`
                        : "No breach recorded"}
                    </span>
                    <Badge tone={selected.breached ? "breach" : "brand"}>
                      {selected.breached ? "Breach" : "Held"}
                    </Badge>
                  </div>
                </li>
              </ol>
              {!runId && (
                <button
                  type="button"
                  onClick={() => setRunId(selected.runId)}
                  className={`${buttonClass("secondary", "sm")} mt-5`}
                >
                  Show only run {selected.runId.slice(0, 8)}
                </button>
              )}
              <p className="mt-5 text-xs leading-relaxed text-muted">
                A step-by-step replay of what the agent read and tried is on the way. Held-out and
                bounty attacks will never show their text.
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-muted">Pick an episode to see how it went.</p>
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

      <StartRating onStarted={setRunId} />
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
