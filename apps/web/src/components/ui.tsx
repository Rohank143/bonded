import type { ReactNode } from "react";
import { addressUrl, short, txUrl } from "../lib/format";
import { describeError } from "../lib/errors";

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line p-4 sm:p-5">
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && (
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
          )}
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
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="truncate text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{children}</div>;
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "safe" | "breach" | "neutral";
  children: ReactNode;
}) {
  const colour =
    tone === "safe"
      ? "border-safe text-safe"
      : tone === "breach"
        ? "border-breach text-breach"
        : "border-line text-muted";
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${colour}`}>
      {children}
    </span>
  );
}

export function AddressLink({ address }: { address: string }) {
  return (
    <a
      className="font-mono text-accent hover:underline"
      href={addressUrl(address)}
      target="_blank"
      rel="noreferrer"
    >
      {short(address)}
    </a>
  );
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <a
      className="font-mono text-accent hover:underline"
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
    >
      {short(hash, 6)}
    </a>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  kind = "primary",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary";
  type?: "button" | "submit";
}) {
  const style =
    kind === "primary"
      ? "bg-ink text-paper hover:opacity-90"
      : "border border-line hover:bg-line/40";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${style}`}
    >
      {children}
    </button>
  );
}

export function Input(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password";
  label: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className="rounded-md border border-line bg-transparent px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="text-sm text-muted">Loading {what}…</p>;
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
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-breach/40 p-3">
      <ErrorText error={error} />
      <Button kind="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function Page({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {intro && <p className="mt-1 max-w-2xl text-sm text-muted">{intro}</p>}
      </header>
      {children}
    </div>
  );
}
