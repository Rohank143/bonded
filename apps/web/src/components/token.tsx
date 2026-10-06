import { TOKEN_MARKS } from "../lib/tokens";

/** A token's logo on a disc, falling back to its first letter. */
export function TokenLogo({ symbol, size = 20 }: { symbol: string; size?: number }) {
  const mark = TOKEN_MARKS[symbol];
  if (mark?.img)
    return (
      <img src={mark.img} alt="" className="rounded-full" style={{ width: size, height: size }} />
    );
  return (
    <span
      className="flex items-center justify-center rounded-full"
      style={{ width: size, height: size, background: mark?.bg ?? "#2a3348" }}
      aria-hidden
    >
      {mark?.path ? (
        <svg viewBox="0 0 24 24" style={{ width: size * 0.6, height: size * 0.6 }}>
          <path d={mark.path} fill={mark.fg} />
        </svg>
      ) : (
        <span className="text-[10px] font-bold">{symbol.replace(/^t/, "").slice(0, 1)}</span>
      )}
    </span>
  );
}

/** A token as a pill: logo and symbol. */
export function TokenChip({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white/[0.05] py-1 pr-3 pl-1 font-mono text-xs">
      <TokenLogo symbol={symbol} />
      {symbol}
    </span>
  );
}
