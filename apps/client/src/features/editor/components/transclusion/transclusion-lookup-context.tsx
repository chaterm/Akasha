import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  lookupTransclusion,
  lookupTransclusionForShare,
} from "@/features/transclusion/services/transclusion-api";
import type { TransclusionLookup } from "@/features/transclusion/types/transclusion.types";

type LookupKey = string;

type Subscriber = {
  key: LookupKey;
  sourcePageId: string;
  transclusionId: string;
  setResult: (r: TransclusionLookup) => void;
};

type ContextValue = {
  subscribe: (s: Subscriber) => () => void;
  refresh: (key: LookupKey) => Promise<void>;
};

const TransclusionLookupContext = createContext<ContextValue | null>(null);

export function TransclusionLookupProvider({
  children,
  shareId,
}: {
  children: React.ReactNode;
  shareId?: string;
}) {
  const subscribersRef = useRef(new Map<LookupKey, Subscriber[]>());
  const queueRef = useRef(new Set<LookupKey>());
  const tickRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shareIdRef = useRef<string | undefined>(shareId);
  shareIdRef.current = shareId;
  const resultCacheRef = useRef(new Map<LookupKey, TransclusionLookup>());
  const inFlightRef = useRef(new Set<LookupKey>());
  const pendingRef = useRef(new Map<LookupKey, Array<() => void>>());

  const flush = useCallback(async () => {
    tickRef.current = null;
    const keys = Array.from(queueRef.current);
    queueRef.current.clear();
    if (keys.length === 0) return;

    for (const k of keys) inFlightRef.current.add(k);

    const references = keys.map((k) => {
      const [sourcePageId, transclusionId] = k.split("::");
      return { sourcePageId, transclusionId };
    });

    const resolveWaiters = (key: LookupKey) => {
      const waiters = pendingRef.current.get(key);
      if (!waiters) return;
      pendingRef.current.delete(key);
      for (const w of waiters) w();
    };

    try {
      const activeShareId = shareIdRef.current;
      const { items } = activeShareId
        ? await lookupTransclusionForShare({
            shareId: activeShareId,
            references,
          })
        : await lookupTransclusion({ references });
      for (const r of items) {
        const key = `${r.sourcePageId}::${r.transclusionId}`;
        resultCacheRef.current.set(key, r);
        inFlightRef.current.delete(key);
        const subs = subscribersRef.current.get(key);
        if (subs) {
          for (const s of subs) s.setResult(r);
        }
        resolveWaiters(key);
      }
    } catch {
      for (const k of keys) {
        inFlightRef.current.delete(k);
        resolveWaiters(k);
      }
    }
  }, []);

  const enqueue = useCallback(
    (key: LookupKey) => {
      queueRef.current.add(key);
      if (tickRef.current === null) {
        tickRef.current = setTimeout(flush, 10);
      }
    },
    [flush],
  );

  const subscribe = useCallback<ContextValue["subscribe"]>(
    (s) => {
      const list = subscribersRef.current.get(s.key) ?? [];
      list.push(s);
      subscribersRef.current.set(s.key, list);

      const cached = resultCacheRef.current.get(s.key);
      if (cached) {
        s.setResult(cached);
      } else if (!inFlightRef.current.has(s.key)) {
        enqueue(s.key);
      }

      return () => {
        const cur = subscribersRef.current.get(s.key) ?? [];
        const next = cur.filter((x) => x !== s);
        if (next.length === 0) subscribersRef.current.delete(s.key);
        else subscribersRef.current.set(s.key, next);
      };
    },
    [enqueue],
  );

  const refresh = useCallback<ContextValue["refresh"]>(
    (key) =>
      new Promise<void>((resolve) => {
        resultCacheRef.current.delete(key);
        inFlightRef.current.delete(key);
        const waiters = pendingRef.current.get(key) ?? [];
        waiters.push(resolve);
        pendingRef.current.set(key, waiters);
        enqueue(key);
      }),
    [enqueue],
  );

  useEffect(
    () => () => {
      if (tickRef.current) clearTimeout(tickRef.current);
    },
    [],
  );

  const value = useMemo<ContextValue>(
    () => ({ subscribe, refresh }),
    [subscribe, refresh],
  );

  return (
    <TransclusionLookupContext.Provider value={value}>
      {children}
    </TransclusionLookupContext.Provider>
  );
}

export function useTransclusionLookup(
  sourcePageId: string | null | undefined,
  transclusionId: string | null | undefined,
): {
  result: TransclusionLookup | null;
  refresh: () => Promise<void>;
} {
  const ctx = useContext(TransclusionLookupContext);
  const [result, setResult] = useState<TransclusionLookup | null>(null);

  useEffect(() => {
    if (!ctx || !sourcePageId || !transclusionId) return;
    const key = `${sourcePageId}::${transclusionId}`;
    const unsubscribe = ctx.subscribe({
      key,
      sourcePageId,
      transclusionId,
      setResult,
    });
    return unsubscribe;
  }, [ctx, sourcePageId, transclusionId]);

  const refresh = useCallback(async () => {
    if (!ctx || !sourcePageId || !transclusionId) return;
    await ctx.refresh(`${sourcePageId}::${transclusionId}`);
  }, [ctx, sourcePageId, transclusionId]);

  return { result, refresh };
}
