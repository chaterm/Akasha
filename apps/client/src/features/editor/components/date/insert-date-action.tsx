import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Button, Group, Stack } from "@mantine/core";
import { DatePicker, DatesProvider } from "@mantine/dates";
import { modals } from "@mantine/modals";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n.ts";
import { getDayjsLocale } from "@/lib/dayjs-locale.ts";

function formatDate(date: Date): string {
  return date.toLocaleDateString(i18n.language, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

interface InsertDateModalProps {
  onConfirm: (date: Date) => void;
}

function InsertDateModal({ onConfirm }: InsertDateModalProps) {
  const { t, i18n: instance } = useTranslation();
  const [value, setValue] = useState<Date | null>(new Date());

  return (
    <DatesProvider settings={{ locale: getDayjsLocale(instance.language) }}>
      <Stack gap="xs" align="center">
        <DatePicker
          value={value}
          onChange={(val) => setValue(val ? new Date(val) : null)}
          size="xs"
        />
        <Group justify="flex-end" gap="xs" w="100%">
          <Button size="xs" variant="default" onClick={() => modals.closeAll()}>
            {t("Cancel")}
          </Button>
          <Button
            size="xs"
            disabled={!value}
            onClick={() => {
              if (value) {
                onConfirm(value);
              }
              modals.closeAll();
            }}
          >
            {t("Insert")}
          </Button>
        </Group>
      </Stack>
    </DatesProvider>
  );
}

/**
 * Opens a compact modal with a localized date picker and inserts the selected
 * date (formatted as plain text) into the editor at the current selection.
 */
export function insertDateAction(editor: Editor) {
  modals.open({
    title: i18n.t("Pick a date"),
    size: "auto",
    padding: "md",
    children: (
      <InsertDateModal
        onConfirm={(date) => {
          editor.chain().focus().insertContent(formatDate(date)).run();
        }}
      />
    ),
  });
}
