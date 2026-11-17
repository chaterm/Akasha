import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

interface AutosaveOptions<K extends string, D> {
  delay: number;
  buildDraft: (dirty: Record<K, boolean>) => D | null;
  save: (draft: D) => Promise<unknown>;
}

export function useAutosave<K extends string, D>(
  kinds: readonly K[],
  options: AutosaveOptions<K, D>,
) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clean = () =>
    Object.fromEntries(kinds.map((k) => [k, false])) as Record<K, boolean>;
  const dirty = useRef<Record<K, boolean>>(clean());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const isDirty = () => Object.values<boolean>(dirty.current).some(Boolean);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!isDirty() || inFlight.current) return;

    const sent = { ...dirty.current };
    const draft = optionsRef.current.buildDraft(sent);
    if (draft === null) {
      setSaveState("pending");
      return;
    }

    dirty.current = clean();
    inFlight.current = true;
    setSaveState("saving");
    let failed = false;
    try {
      await optionsRef.current.save(draft);
      setSaveState(isDirty() ? "pending" : "saved");
    } catch {
      failed = true;
      for (const k of kinds) dirty.current[k] = dirty.current[k] || sent[k];
      setSaveState("error");
    } finally {
      inFlight.current = false;
    }
    if (!failed && isDirty()) schedule();
    // kinds 视为常量
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), optionsRef.current.delay);
  }, [flush]);

  const markDirty = useCallback(
    (kind: K) => {
      dirty.current[kind] = true;
      setSaveState("pending");
      schedule();
    },
    [schedule],
  );

  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    dirty.current = clean();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => void flush(), [flush]);

  const hasUnsaved = useCallback(() => isDirty() || inFlight.current, []);

  return { saveState, markDirty, flush, discard, hasUnsaved };
}
