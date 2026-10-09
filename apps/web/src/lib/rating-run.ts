import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RunRecord } from "./api";

/** Query keys of the profile's reads: the chain reads (wagmi) and the API's agent records. */
const PROFILE_KEYS = new Set(["readContract", "readContracts", "self-agent", "score", "tee"]);
const finished = (status?: RunRecord["status"]) => status === "done" || status === "failed";

/**
 * Follows a rating until it finishes, then refreshes the profile once. Polling stops when the run
 * is done or failed; the refresh never touches the run's own query, so it can't restart polling.
 */
export function useRatingRun(runId: string | undefined, intervalMs = 5000) {
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId!),
    enabled: Boolean(runId),
    refetchInterval: (q) => (finished(q.state.data?.status) ? false : intervalMs),
    // Keep following in a background tab, so the browser notification can say it finished.
    refetchIntervalInBackground: true,
  });
  const refreshedFor = useRef<string | undefined>(undefined);
  const status = run.data?.status;
  useEffect(() => {
    if (!runId || !finished(status) || refreshedFor.current === runId) return;
    refreshedFor.current = runId;
    void queryClient.invalidateQueries({
      predicate: (q) => PROFILE_KEYS.has(String(q.queryKey[0])),
    });
  }, [runId, status, queryClient]);
  return run;
}
