import { Schema } from "@tiptap/pm/model";
import {
  createHistoryDiff,
  HistoryDiffChange,
} from "@docmost/editor-ext/src/lib/history-diff/history-diff";

export type DiffChange = HistoryDiffChange;

export interface DiffWorkerResult {
  type: "result";
  changes: DiffChange[];
  addedCount: number;
  deletedCount: number;
}

export interface DiffWorkerError {
  type: "error";
  message: string;
}

self.onmessage = (e: MessageEvent) => {
  const { schemaSpec, previousContent, content } = e.data;

  try {
    const schema = new Schema(schemaSpec);
    const { changes, addedCount, deletedCount } = createHistoryDiff(
      schema,
      previousContent,
      content,
    );

    const msg: DiffWorkerResult = {
      type: "result",
      changes,
      addedCount,
      deletedCount,
    };
    (self as any).postMessage(msg);
  } catch (err: any) {
    const msg: DiffWorkerError = {
      type: "error",
      message: err?.message ?? "Unknown error",
    };
    (self as any).postMessage(msg);
  }
};
