import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import { tierForScore } from "@bonded/shared";
import { addressUrl, short, txUrl } from "../lib/format";
import { explorerUrl } from "../config";
import { describeError } from "../lib/errors";
import { GLOSSARY, tierMeaning, type GlossaryTerm } from "../lib/glossary";

/** The class for an inline text link, so every link in the app looks the same. */
export const linkClass =
  "font-medium text-accent underline-offset-4 decoration-accent/40 hover:underline";

type Tone = "safe" | "breach" | "neutral" | "brand" | "warn";

/**
 * The Bonded logo: the lockup (mark and name) or the mark alone, in light and dark. The brand
 * rules ask for a lockup at least 160 px wide (h-9); use the symbol where there is less room.
 */
export function Logo({
  variant = "lockup",
  className = "h-8",
}: {
  variant?: "lockup" | "symbol";
  className?: string;
}) {
  if (variant === "symbol")
    return (
      <img src="/brand/bonded-symbol-blue.svg" alt="Bonded" className={`${className} w-auto`} />
    );
  return (
    <picture>
      <source srcSet="/brand/bonded-lockup-on-dark.svg" media="(prefers-color-scheme: dark)" />
      <img src="/brand/bonded-lockup-primary.svg" alt="Bonded" className={`${className} w-auto`} />
    </picture>
  );
}

export function Card({
  title,
  description,
  children,
  actions,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-(--radius-card) border border-line bg-surface p-5 shadow-(--shadow-card) sm:p-6 ${className}`}
    >
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
            {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  size = "md",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  size?: "md" | "lg";
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div
        className={`mt-1 truncate font-semibold tracking-tight tabular-nums ${size === "lg" ? "text-3xl sm:text-4xl" : "text-2xl"}`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">{children}</div>;
}

const BADGE: Record<Tone, string> = {
  safe: "bg-safe-soft text-safe",
  breach: "bg-breach-soft text-breach",
  neutral: "bg-sunken text-muted",
  brand: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn",
};

export function Badge({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE[tone]}`}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/** A tier's colour: green for A and above, amber for BBB and BB, red below. */
export function tierTone(score: number): Tone {
  return score >= 70 ? "safe" : score >= 45 ? "warn" : "breach";
}

/** The tier for a score, with what it means for cover on hover. */
export function TierBadge({ score }: { score: number }) {
  const { tier } = tierForScore(score);
  return (
    <Tooltip content={`Tier ${tier}. ${tierMeaning(tier)}`}>
      <Badge tone={tierTone(score)}>{tier}</Badge>
    </Tooltip>
  );
}

export function AddressLink({ address }: { address: string }) {
  if (!explorerUrl) return <span className="font-mono text-[0.92em]">{short(address)}</span>;
  return (
    <a
      className="font-mono text-[0.92em] text-accent hover:underline"
      href={addressUrl(address)}
      target="_blank"
      rel="noreferrer"
    >
      {short(address)}
    </a>
  );
}

export function TxLink({ hash }: { hash: string }) {
  if (!explorerUrl) return <span className="font-mono text-[0.92em]">{short(hash, 6)}</span>;
  return (
    <a
      className="font-mono text-[0.92em] text-accent hover:underline"
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
    >
      {short(hash, 6)}
    </a>
  );
}

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_KIND: Record<ButtonKind, string> = {
  primary: "bg-brand text-on-brand shadow-sm hover:bg-brand-strong",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-sunken",
  ghost: "text-ink hover:bg-sunken",
  danger: "border border-breach/40 bg-surface text-breach hover:bg-breach-soft",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

/** The classes for a button, for links that should look like one. */
export function buttonClass(kind: ButtonKind = "primary", size: ButtonSize = "md") {
  return `inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${BUTTON_KIND[kind]} ${BUTTON_SIZE[size]}`;
}

export function Button({
  children,
  onClick,
  disabled,
  kind = "primary",
  size = "md",
  type = "button",
  loading = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: ButtonKind;
  size?: ButtonSize;
  type?: "button" | "submit";
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(kind, size)}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/** A router link that looks like a button. */
export function LinkButton({
  to,
  children,
  kind = "primary",
  size = "md",
}: {
  to: string;
  children: ReactNode;
  kind?: ButtonKind;
  size?: ButtonSize;
}) {
  return (
    <Link to={to} className={buttonClass(kind, size)}>
      {children}
    </Link>
  );
}

export function Spinner() {
  return (
    <span
      className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
      aria-hidden
    />
  );
}

const FIELD =
  "h-10 w-full rounded-lg border bg-surface px-3 text-sm outline-none transition-colors placeholder:text-muted/70 focus:border-accent focus:ring-3 focus:ring-accent/15";

export function Input(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password";
  label: ReactNode;
  hint?: ReactNode;
  /** Shown under the field, and marks it invalid. */
  error?: string | null;
  /** Monospace for addresses, amounts and keys; off for prose. */
  mono?: boolean;
  inputMode?: "text" | "decimal" | "numeric";
  suffix?: ReactNode;
}) {
  const id = useId();
  const mono = props.mono ?? true;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm">
      <label htmlFor={id} className="font-medium">
        {props.label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={props.type ?? "text"}
          value={props.value}
          placeholder={props.placeholder}
          inputMode={props.inputMode}
          onChange={(e) => props.onChange(e.target.value)}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error || props.hint ? `${id}-note` : undefined}
          className={`${FIELD} ${mono ? "font-mono" : ""} ${props.suffix ? "pr-16" : ""} ${props.error ? "border-breach" : "border-line-strong"}`}
          autoComplete="off"
          spellCheck={false}
        />
        {props.suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-muted">
            {props.suffix}
          </span>
        )}
      </div>
      {(props.error || props.hint) && (
        <span id={`${id}-note`} className={`text-xs ${props.error ? "text-breach" : "text-muted"}`}>
          {props.error || props.hint}
        </span>
      )}
    </div>
  );
}

/** A choice card for radio groups: a label, an optional line under it, and the selected ring. */
export function Choice({
  checked,
  onChange,
  title,
  children,
  name,
  type = "radio",
}: {
  checked: boolean;
  onChange: () => void;
  title: ReactNode;
  children?: ReactNode;
  name?: string;
  type?: "radio" | "checkbox";
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${checked ? "border-accent bg-accent-soft/50" : "border-line-strong hover:bg-sunken"}`}
    >
      <input type={type} name={name} checked={checked} onChange={onChange} className="mt-0.5" />
      <span>
        <span className="font-medium">{title}</span>
        {children && <span className="mt-0.5 block text-muted">{children}</span>}
      </span>
    </label>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <span className={`block animate-pulse rounded-md bg-sunken ${className}`} aria-hidden />;
}

/** A loading placeholder: a few shimmering lines, with the words for screen readers. */
export function Loading({ what, lines = 3 }: { what: string; lines?: number }) {
  return (
    <div className="flex flex-col gap-2.5 py-1" role="status">
      <span className="sr-only">Loading {what}…</span>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-4 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}

/** Nothing to show yet: one line on why, and the next thing to do. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
      <img src="/brand/bonded-symbol-blue.svg" alt="" className="mb-1 h-7 opacity-30 grayscale" />
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

const CALLOUT: Record<Exclude<Tone, "neutral">, string> = {
  brand: "border-accent/25 bg-accent-soft/60",
  warn: "border-warn/30 bg-warn-soft",
  breach: "border-breach/30 bg-breach-soft",
  safe: "border-safe/30 bg-safe-soft",
};

export function Callout({
  tone = "brand",
  title,
  children,
}: {
  tone?: Exclude<Tone, "neutral">;
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-lg border p-4 text-sm ${CALLOUT[tone]}`}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div className="text-ink/85">{children}</div>
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-breach">
      {describeError(error)}
    </p>
  );
}

/** A section whose data couldn't be loaded: what went wrong, and a way to try again. */
export function Unavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-breach/30 bg-breach-soft p-4">
      <ErrorText error={error} />
      <Button kind="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** A hover and focus tooltip. The trigger is focusable so keyboard users can read it too. */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <span className="group/tip relative inline-flex">
      <span tabIndex={0} aria-describedby={id} className="inline-flex rounded outline-offset-2">
        {children}
      </span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-2 w-max max-w-64 -translate-x-1/2 rounded-lg bg-ink px-3 py-2 text-left text-xs leading-relaxed font-normal tracking-normal text-paper normal-case opacity-0 shadow-(--shadow-raised) transition-opacity group-focus-within/tip:visible group-focus-within/tip:opacity-100 group-hover/tip:visible group-hover/tip:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}

/** A word from the glossary, underlined with dots, explained on hover or focus. */
export function Term({ term, children }: { term: GlossaryTerm; children: ReactNode }) {
  return (
    <Tooltip content={GLOSSARY[term]}>
      <span className="cursor-help underline decoration-muted/60 decoration-dotted underline-offset-4">
        {children}
      </span>
    </Tooltip>
  );
}

/** Wraps a plain <table> with the app's table styles, and scrolls sideways on small screens. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto sm:-mx-6">
      <table className="w-full text-sm [&_tbody_tr]:border-t [&_tbody_tr]:border-line [&_tbody_tr:hover]:bg-sunken/60 [&_td]:py-3 [&_td:first-child]:pl-5 sm:[&_td:first-child]:pl-6 [&_td:last-child]:pr-5 sm:[&_td:last-child]:pr-6 [&_th]:pb-2.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted [&_th:first-child]:pl-5 sm:[&_th:first-child]:pl-6 [&_th:last-child]:pr-5 sm:[&_th:last-child]:pr-6">
        {children}
      </table>
    </div>
  );
}

/** A label and value list, e.g. hashes and addresses under a card's stats. */
export function Details({ children }: { children: ReactNode }) {
  return (
    <dl className="mt-5 grid gap-x-6 gap-y-2.5 border-t border-line pt-5 text-sm sm:grid-cols-[11rem_1fr] [&_dt]:text-muted [&_dd]:min-w-0">
      {children}
    </dl>
  );
}

export function Page({
  title,
  eyebrow,
  intro,
  actions,
  back,
  children,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  intro?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-2">
        <div className="min-w-0">
          {back && (
            <Link
              to={back.to}
              className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
            >
              <span aria-hidden>←</span> {back.label}
            </Link>
          )}
          {eyebrow && (
            <p className="mb-2 text-xs font-semibold tracking-[0.12em] text-accent uppercase">
              {eyebrow}
            </p>
          )}
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          {intro && <p className="mt-2 max-w-2xl text-base text-muted">{intro}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
