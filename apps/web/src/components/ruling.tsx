import type { RulingTone, RulingView } from "../lib/ruling";
import { Badge } from "./ui";

/** A ruling's colours: orange for a breach, blue for a defence, grey for "nothing to learn". */
const DOT: Record<RulingTone, string> = {
  breach: "bg-breach-solid shadow-[0_0_10px_rgb(255_122_69/.7)]",
  held: "bg-held shadow-[0_0_10px_rgb(127_160_255/.6)]",
  muted: "bg-[#5b6478]",
};
const BADGE: Record<RulingTone, "breach" | "brand" | "neutral"> = {
  breach: "breach",
  held: "brand",
  muted: "neutral",
};
const CARD: Record<RulingTone, string> = {
  breach: "border-breach/40 bg-breach-soft",
  held: "border-accent/30 bg-accent-soft",
  muted: "border-line bg-white/[0.03]",
};

export const RulingDot = ({ r }: { r: RulingView }) => (
  <span className={`size-2.5 rounded-full ${DOT[r.tone]}`} />
);

export const RulingBadge = ({ r }: { r: RulingView }) => (
  <Badge tone={BADGE[r.tone]}>{r.pill}</Badge>
);

/** The big verdict card: the ruling and one sentence saying why. */
export function VerdictCard({ r }: { r: RulingView }) {
  return (
    <div className={`rounded-2xl border p-5 ${CARD[r.tone]}`}>
      <p className="font-serif text-4xl leading-none">{r.title}</p>
      <p className="mt-2 text-sm text-soft">{r.why}</p>
    </div>
  );
}
