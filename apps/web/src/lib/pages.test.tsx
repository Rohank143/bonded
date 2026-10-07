import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router";
import { pageNumbers, paginate, useListParams } from "./pages";

describe("pageNumbers", () => {
  it("shows every page when there are few", () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });
  it("keeps the ends and the neighbours, with gaps between", () => {
    expect(pageNumbers(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
    expect(pageNumbers(1, 20)).toEqual([1, 2, "gap", 20]);
    expect(pageNumbers(20, 20)).toEqual([1, "gap", 19, 20]);
  });
  it("fills a one-page gap instead of showing a gap", () => {
    expect(pageNumbers(4, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 23 }, (_, i) => i);
  it("slices one page and says how many there are", () => {
    expect(paginate(items, 3, 10)).toEqual({ items: [20, 21, 22], page: 3, pages: 3, total: 23 });
  });
  it("reads the last page when asked for one past the end, and one page when empty", () => {
    expect(paginate(items, 9, 10).page).toBe(3);
    expect(paginate([], 4, 10)).toEqual({ items: [], page: 1, pages: 1, total: 0 });
  });
});

describe("useListParams", () => {
  const setup = (url: string) => {
    let search = "";
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
    );
    const { result } = renderHook(
      () => {
        const list = useListParams({ outcome: "all", sort: "newest" });
        search = useSearchParams()[0].toString();
        return list;
      },
      { wrapper },
    );
    return { result, search: () => search };
  };

  it("reads the page, size and filters from the address, with defaults", () => {
    const { result } = setup("/x?page=3&size=50&outcome=breach&operator=1");
    expect(result.current).toMatchObject({
      page: 3,
      size: 50,
      values: { outcome: "breach", sort: "newest" },
    });
    expect(setup("/x?page=-2&size=7").result.current).toMatchObject({ page: 1, size: 25 });
  });

  it("leaves defaults out of the address and goes back to page 1 on a new filter", () => {
    const { result, search } = setup("/x?page=3&operator=1");
    act(() => result.current.set({ outcome: "held" }));
    expect(search()).toBe("operator=1&outcome=held");
    act(() => result.current.set({ page: 4 }));
    expect(search()).toBe("operator=1&outcome=held&page=4");
    act(() => result.current.set({ outcome: "all", size: 25 }));
    expect(search()).toBe("operator=1");
  });
});
