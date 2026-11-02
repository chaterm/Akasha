import type { Editor, Range } from "@tiptap/core";
import { buildDefaultDatabaseJSON } from "@docmost/editor-ext";
import { getDefaultStore } from "jotai";
import i18n from "@/i18n.ts";
import { userAtom } from "@/features/user/atoms/current-user-atom";

/** Inserts the starter database (sample tasks assigned to the viewer), replacing `range` when given. */
export function insertDefaultDatabase(editor: Editor, range?: Range) {
  const t = i18n.t.bind(i18n);
  const user = getDefaultStore().get(userAtom);
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  chain
    .insertDatabase(
      buildDefaultDatabaseJSON({
        title: "",
        task: t("Task"),
        taskItem: (n) => t("Task {{n}}", { n }),
        member: t("Member"),
        me: user
          ? { id: user.id, name: user.name, avatarUrl: user.avatarUrl }
          : undefined,
        status: t("Status"),
        date: t("Date"),
        todo: t("To do"),
        doing: t("In progress"),
        done: t("Done"),
        table: t("Table"),
        kanban: t("Kanban"),
        calendar: t("Calendar"),
        timeline: t("Timeline"),
        mine: t("Mine"),
      }),
    )
    .run();
}
