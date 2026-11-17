import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutosave } from "./use-autosave";

const KINDS = ["meta", "body"] as const;

const setup = (opts?: {
  save?: () => Promise<unknown>;
  draftOk?: () => boolean;
}) => {
  const impl = opts?.save ?? (() => Promise.resolve());
  const save = vi.fn((_draft: unknown) => impl());
  const draftOk = opts?.draftOk ?? (() => true);
  const hook = renderHook(
    ({ tick }) =>
      useAutosave(KINDS, {
        delay: 1000,
        buildDraft: (dirty) => (draftOk() ? { ...dirty, tick } : null),
        save: (draft) => save(draft),
      }),
    { initialProps: { tick: 0 } },
  );
  return { save, ...hook };
};

describe("useAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("连续修改并重新渲染时只在防抖结束后保存一次", async () => {
    const { save, result, rerender } = setup();
    for (let i = 1; i <= 5; i++) {
      act(() => result.current.markDirty("meta"));
      rerender({ tick: i });
      await act(() => vi.advanceTimersByTimeAsync(300));
    }
    expect(save).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ meta: true, body: false, tick: 5 });
    expect(result.current.saveState).toBe("saved");
  });

  it("保存失败后不自动重试，下一次修改才重试", async () => {
    const { save, result, rerender } = setup({
      save: () => Promise.reject(new Error("403")),
    });
    act(() => result.current.markDirty("body"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.saveState).toBe("error");

    rerender({ tick: 1 });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(save).toHaveBeenCalledTimes(1);

    act(() => result.current.markDirty("meta"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ meta: true, body: true, tick: 1 });
  });

  it("不满足保存条件时不提交", async () => {
    const { save, result } = setup({ draftOk: () => false });
    act(() => result.current.markDirty("meta"));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(save).not.toHaveBeenCalled();
    expect(result.current.saveState).toBe("pending");
  });

  it("卸载时立即保存未提交的改动", async () => {
    const { save, result, unmount } = setup();
    act(() => result.current.markDirty("body"));
    unmount();
    await act(() => Promise.resolve());
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("discard 后卸载不再保存", async () => {
    const { save, result, unmount } = setup();
    act(() => result.current.markDirty("body"));
    act(() => result.current.discard());
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(save).not.toHaveBeenCalled();
  });
});
