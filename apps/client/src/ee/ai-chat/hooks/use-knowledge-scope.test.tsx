import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKnowledgeScope } from "./use-knowledge-scope";

vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpacesQuery: () => ({
    data: {
      items: [
        { id: "space-1", name: "AIM" },
        { id: "space-2", name: "General" },
      ],
    },
    isLoading: false,
  }),
}));

describe("useKnowledgeScope", () => {
  it("maps all spaces to an omitted filter and one selection to one id", () => {
    const { result } = renderHook(() => useKnowledgeScope());

    expect(result.current.selectedSpaceId).toBeNull();
    expect(result.current.spaceIds).toBeUndefined();

    act(() => result.current.setSelectedSpaceId("space-1"));

    expect(result.current.selectedSpaceId).toBe("space-1");
    expect(result.current.spaceIds).toEqual(["space-1"]);
  });
});
