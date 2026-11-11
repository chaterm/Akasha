import { useCallback } from "react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { pageCollabProviderAtom } from "@/features/editor/atoms/editor-atoms";
import { createPageHistorySnapshot } from "@/features/page-history/services/page-history-service";
import { queryClient } from "@/main";

const SYNC_TIMEOUT_MS = 5000;

export function waitForProviderSync(
  provider: Pick<HocuspocusProvider, "hasUnsyncedChanges" | "on" | "off">,
  timeoutMs = SYNC_TIMEOUT_MS,
): Promise<void> {
  if (!provider.hasUnsyncedChanges) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onUnsyncedChanges = () => {
      if (provider.hasUnsyncedChanges) return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("sync_timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      provider.off("unsyncedChanges", onUnsyncedChanges);
    };
    provider.on("unsyncedChanges", onUnsyncedChanges);
  });
}

export function useHistorySnapshot(pageId: string) {
  const { t } = useTranslation();
  const provider = useAtomValue(pageCollabProviderAtom);

  return useCallback(
    async (beforeSave?: () => Promise<void>): Promise<boolean> => {
      let created: boolean;
      try {
        await beforeSave?.();
        if (provider) {
          await waitForProviderSync(provider);
        }
        ({ created } = await createPageHistorySnapshot(pageId));
      } catch (err) {
        notifications.show({
          message:
            err instanceof Error && err.message === "sync_timeout"
              ? t("Changes are still syncing. Please try again.")
              : t("Failed to save version"),
          color: "red",
        });
        return false;
      }

      if (!created) {
        notifications.show({ message: t("No changes since the last version") });
        return true;
      }

      void queryClient.invalidateQueries({
        queryKey: ["page-history-list", pageId],
      });
      notifications.show({ message: t("Saved") });
      return true;
    },
    [pageId, provider, t],
  );
}
