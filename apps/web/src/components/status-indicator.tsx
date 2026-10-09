import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { byoaApi } from "../lib/byoa-api";
import { overallStatus, type Tone } from "../lib/health";

export const DOT: Record<Tone, string> = {
  safe: "bg-safe",
  warn: "bg-warn",
  breach: "bg-breach-solid",
  neutral: "bg-muted",
};

/** The public service status (GET /status), shared by the indicator and the status page. */
export function useServiceStatus() {
  return useQuery({
    queryKey: ["service-status"],
    queryFn: () => byoaApi.status(),
    refetchInterval: 60_000,
    retry: 1,
  });
}

/** A small dot and a word, linking to the status page. */
export function StatusIndicator() {
  const status = useServiceStatus();
  const view = overallStatus(status.data, status.isError);
  return (
    <Link
      to="/status"
      className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink"
      aria-label={`Service status: ${view.label}`}
    >
      <span className={`size-2 rounded-full ${DOT[view.tone]}`} aria-hidden />
      {view.label}
    </Link>
  );
}
