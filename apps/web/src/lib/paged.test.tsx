import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePaged } from "./paged";

describe("usePaged", () => {
  const items = Array.from({ length: 60 }, (_, i) => i);

  it("shows one page, then one more each time", () => {
    const { result } = renderHook(() => usePaged(items, 25));
    expect(result.current.shown).toHaveLength(25);
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.more());
    expect(result.current.shown).toHaveLength(50);
    act(() => result.current.more());
    expect(result.current.shown).toHaveLength(60);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.total).toBe(60);
  });

  it("starts over when the filter changes", () => {
    const { result, rerender } = renderHook(({ key }) => usePaged(items, 25, key), {
      initialProps: { key: "all" },
    });
    act(() => result.current.more());
    expect(result.current.shown).toHaveLength(50);
    rerender({ key: "mine" });
    expect(result.current.shown).toHaveLength(25);
  });
});
