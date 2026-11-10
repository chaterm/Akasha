import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

interface AutosaveOptions<K extends string, D> {
  delay: number;
  /** 根据脏字段生成要提交的内容；返回 null 表示当前不满足保存条件（如缺标题） */
  buildDraft: (dirty: Record<K, boolean>) => D | null;
  save: (draft: D) => Promise<unknown>;
}

/**
 * 防抖自动保存：
 * - markDirty 后 delay 毫秒内无新改动才保存；保存中又有改动，成功后继续排队；
 * - 失败时保留脏标记但不自动重试，等下一次修改或手动 flush；
 * - 卸载时把未保存的改动发出去。
 * 所有回调都通过 ref 读取最新值，返回的 flush/markDirty 身份稳定。
 */
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
      // 把这次没保存成功的字段标回去，与保存期间的新改动合并
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

  /** 清空脏标记并取消排队中的保存（例如删除模板前） */
  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    dirty.current = clean();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 仅在卸载时执行：flush 身份稳定
  useEffect(() => () => void flush(), [flush]);

  const hasUnsaved = useCallback(() => isDirty() || inFlight.current, []);

  return { saveState, markDirty, flush, discard, hasUnsaved };
}
