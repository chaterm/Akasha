import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  showNotification: vi.fn(),
  createSnapshot: vi.fn(),
}));

vi.mock("@/main", () => ({
  queryClient: { invalidateQueries: mocks.invalidateQueries },
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.showNotification },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/page-history/services/page-history-service", () => ({
  createPageHistorySnapshot: mocks.createSnapshot,
}));

import {
  useHistorySnapshot,
  waitForProviderSync,
} from "./use-history-snapshot";

function createProvider(unsynced: boolean) {
  const listeners = new Set<() => void>();
  const provider = {
    hasUnsyncedChanges: unsynced,
    on: vi.fn((_event: string, fn: () => void) => listeners.add(fn)),
    off: vi.fn((_event: string, fn: () => void) => listeners.delete(fn)),
  };
  const emit = (stillUnsynced: boolean) => {
    provider.hasUnsyncedChanges = stillUnsynced;
    listeners.forEach((fn) => fn());
  };
  return { provider, emit, listeners };
}

describe("waitForProviderSync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when nothing is pending", async () => {
    const { provider } = createProvider(false);
    await expect(waitForProviderSync(provider as any)).resolves.toBeUndefined();
    expect(provider.on).not.toHaveBeenCalled();
  });

  it("waits until the server acknowledges pending changes", async () => {
    const { provider, emit, listeners } = createProvider(true);
    const promise = waitForProviderSync(provider as any);

    emit(true);
    emit(false);

    await expect(promise).resolves.toBeUndefined();
    expect(listeners.size).toBe(0);
  });

  it("rejects with sync_timeout when changes never sync", async () => {
    vi.useFakeTimers();
    const { provider, listeners } = createProvider(true);
    const promise = waitForProviderSync(provider as any, 1000);

    vi.advanceTimersByTime(1000);

    await expect(promise).rejects.toThrow("sync_timeout");
    expect(listeners.size).toBe(0);
  });
});

describe("useHistorySnapshot", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports no changes without refreshing the history list", async () => {
    mocks.createSnapshot.mockResolvedValue({ id: "h1", created: false });
    const { result } = renderHook(() => useHistorySnapshot("page-1"));

    await expect(result.current()).resolves.toBe(true);

    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith({
      message: "No changes since the last version",
    });
  });

  it("refreshes the history list when a version is created", async () => {
    mocks.createSnapshot.mockResolvedValue({ id: "h2", created: true });
    const { result } = renderHook(() => useHistorySnapshot("page-1"));

    await expect(result.current()).resolves.toBe(true);

    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["page-history-list", "page-1"],
    });
    expect(mocks.showNotification).toHaveBeenCalledWith({ message: "Saved" });
  });
});
