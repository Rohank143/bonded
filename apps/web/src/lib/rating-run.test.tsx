import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { api, type RunRecord } from "./api";
import { useRatingRun } from "./rating-run";

const record = (status: RunRecord["status"]) =>
  ({ id: "r", status, error: null, created_at: "", report: null }) as RunRecord;

describe("useRatingRun", () => {
  it("stops polling when the run finishes and refreshes the profile exactly once", async () => {
    const statuses: RunRecord["status"][] = ["queued", "running", "done"];
    const run = vi
      .spyOn(api, "run")
      .mockImplementation(async () => record(statuses.shift() ?? "done"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A profile read that the refresh should hit, and must not loop on.
    const profile = vi.fn(async () => 1);
    await client.prefetchQuery({ queryKey: ["readContracts", "profile"], queryFn: profile });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRatingRun("r", 10), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe("done"));
    const callsAtDone = run.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    // No more fetches of the finished run, and one profile refresh.
    expect(run.mock.calls.length).toBe(callsAtDone);
    expect(invalidate).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });

  it("also stops and refreshes once when the run fails", async () => {
    const run = vi.spyOn(api, "run").mockResolvedValue(record("failed"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRatingRun("f", 10), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe("failed"));
    await new Promise((r) => setTimeout(r, 100));
    expect(run).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });
});
