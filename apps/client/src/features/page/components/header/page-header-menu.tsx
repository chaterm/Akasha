import {
  ActionIcon,
  Badge,
  Box,
  Group,
  Menu,
  SegmentedControl,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowRight,
  IconArrowsHorizontal,
  IconDots,
  IconEye,
  IconEyeOff,
  IconFileExport,
  IconHistory,
  IconLink,
  IconList,
  IconMarkdown,
  IconMessage,
  IconPrinter,
  IconRocket,
  IconStar,
  IconStarFilled,
  IconSparkles,
  IconTrash,
  IconWifiOff,
  IconAlertCircle,
  IconCircleCheck,
  IconLoader2,
  IconCircle,
} from "@tabler/icons-react";
import React, { useEffect, useRef, useState } from "react";
import { useAsideTriggerProps } from "@/hooks/use-toggle-aside.tsx";
import { useAtom, useAtomValue } from "jotai";
import { historyAtoms } from "@/features/page-history/atoms/history-atoms.ts";
import { useDisclosure, useHotkeys } from "@mantine/hooks";
import { useClipboard } from "@/hooks/use-clipboard";
import { useParams } from "react-router-dom";
import {
  usePageQuery,
  usePublishPageKnowledgeMutation,
  usePagePublishCooldownQuery,
  usePageCompileStatusQuery,
} from "@/features/page/queries/page-query.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { notifications } from "@mantine/notifications";
import { getAppUrl } from "@/lib/config.ts";
import { extractPageSlugId } from "@/lib";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation.ts";
import { useDeletePageModal } from "@/features/page/hooks/use-delete-page-modal.tsx";
import { PageWidthToggle } from "@/features/user/components/page-width-pref.tsx";
import { Trans, useTranslation } from "react-i18next";
import ExportModal from "@/components/common/export-modal";
import { htmlToMarkdown } from "@docmost/editor-ext";
import {
  pageEditorAtom,
  yjsConnectionStatusAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import { formattedDate } from "@/lib/time.ts";
import { PageEditModeControls } from "@/features/editor/components/page-edit-mode-toggle.tsx";
import MovePageModal from "@/features/page/components/move-page-modal.tsx";
import { useTimeAgo } from "@/hooks/use-time-ago.tsx";
import { PageShareModal } from "@/ee/page-permission";
import {
  PageVerificationMenuItem,
  PageVerificationModal,
} from "@/ee/page-verification";
import {
  useFavoriteIds,
  useAddFavoriteMutation,
  useRemoveFavoriteMutation,
} from "@/features/favorite/queries/favorite-query";
import {
  useWatchStatusQuery,
  useWatchPageMutation,
  useUnwatchPageMutation,
} from "@/features/page/queries/watcher-query";
import type { KnowledgeIndexMode } from "@/features/page/services/page-service";

const PUBLISH_COOLDOWNS = [10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const publishCooldownKey = (pageId: string) =>
  `page-publish-cooldown:${pageId}`;

function formatCooldown(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  }
  return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
}

interface PageHeaderMenuProps {
  readOnly?: boolean;
}
export default function PageHeaderMenu({ readOnly }: PageHeaderMenuProps) {
  const { t } = useTranslation();
  const commentsTriggerProps = useAsideTriggerProps("comments");
  const tocTriggerProps = useAsideTriggerProps("toc");
  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({
    pageId: extractPageSlugId(pageSlug),
  });
  const isDeleted = !!page?.deletedAt;

  useHotkeys(
    [
      [
        "mod+F",
        () => {
          const event = new CustomEvent("openFindDialogFromEditor", {});
          document.dispatchEvent(event);
        },
      ],
      [
        "Escape",
        () => {
          const event = new CustomEvent("closeFindDialogFromEditor", {});
          document.dispatchEvent(event);
        },
        { preventDefault: false },
      ],
    ],
    [],
  );

  if (isDeleted) {
    return null;
  }

  return (
    <>
      <ConnectionWarning />

      {!readOnly && <PageEditModeControls size="xs" />}

      <PageShareModal readOnly={readOnly} />

      <Tooltip label={t("Comments")} openDelay={250} withArrow>
        <ActionIcon
          variant="subtle"
          color="dark"
          aria-label={t("Comments")}
          {...commentsTriggerProps}
        >
          <IconMessage size={20} stroke={2} />
        </ActionIcon>
      </Tooltip>

      <Tooltip label={t("Table of contents")} openDelay={250} withArrow>
        <ActionIcon
          variant="subtle"
          color="dark"
          aria-label={t("Table of contents")}
          {...tocTriggerProps}
        >
          <IconList size={20} stroke={2} />
        </ActionIcon>
      </Tooltip>

      <PageActionMenu readOnly={readOnly} />
    </>
  );
}

interface PageActionMenuProps {
  readOnly?: boolean;
}
function PageActionMenu({ readOnly }: PageActionMenuProps) {
  const { t } = useTranslation();
  const [, setHistoryModalOpen] = useAtom(historyAtoms);
  const clipboard = useClipboard({ timeout: 500 });
  const { pageSlug, spaceSlug } = useParams();
  const { data: page, isLoading } = usePageQuery({
    pageId: extractPageSlugId(pageSlug),
  });
  const { openDeleteModal } = useDeletePageModal();
  const { handleDelete } = useTreeMutation(page?.spaceId ?? "");
  const [exportOpened, { open: openExportModal, close: closeExportModal }] =
    useDisclosure(false);
  const [
    movePageModalOpened,
    { open: openMovePageModal, close: closeMoveSpaceModal },
  ] = useDisclosure(false);
  const [
    verificationOpened,
    { open: openVerificationModal, close: closeVerificationModal },
  ] = useDisclosure(false);
  const [pageEditor] = useAtom(pageEditorAtom);
  const pageUpdatedAt = useTimeAgo(page?.updatedAt);
  const favoriteIds = useFavoriteIds("page", page?.spaceId);
  const addFavoriteMutation = useAddFavoriteMutation();
  const removeFavoriteMutation = useRemoveFavoriteMutation();
  const isFavorited = page?.id ? favoriteIds.has(page.id) : false;
  const { data: watchStatus } = useWatchStatusQuery(page?.id);
  const watchPage = useWatchPageMutation();
  const unwatchPage = useUnwatchPageMutation();
  const publishPageKnowledge = usePublishPageKnowledgeMutation();
  const { data: serverCooldown, refetch: refetchCooldown } =
    usePagePublishCooldownQuery(page?.id);
  const { data: compileStatus, refetch: refetchCompileStatus } =
    usePageCompileStatusQuery(page?.id);
  const [publishCooldown, setPublishCooldown] = useState<{
    expiresAt: number;
    step: number;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [indexMode, setIndexMode] = useState<KnowledgeIndexMode>("compiled");
  const publishCooldownRemaining = publishCooldown
    ? publishCooldown.expiresAt - now
    : 0;
  useEffect(() => {
    if (serverCooldown?.expiresAt) {
      setPublishCooldown({
        expiresAt: serverCooldown.expiresAt,
        step: serverCooldown.step,
      });
    }
  }, [serverCooldown]);
  const publishCoolingDown = publishCooldownRemaining > 0;
  const isPublishing = compileStatus?.status === "compiling";

  useEffect(() => {
    setIndexMode(compileStatus?.configuredIndexMode ?? "compiled");
  }, [page?.id, compileStatus?.configuredIndexMode]);

  useEffect(() => {
    setPublishCooldown(null);
    if (!page?.id) return;
    try {
      const stored = localStorage.getItem(publishCooldownKey(page.id));
      if (!stored) return;
      const value = JSON.parse(stored) as { expiresAt?: number; step?: number };
      if (value.expiresAt && value.step && value.expiresAt > Date.now()) {
        setPublishCooldown({ expiresAt: value.expiresAt, step: value.step });
      } else {
        localStorage.removeItem(publishCooldownKey(page.id));
      }
    } catch {
      // Ignore unavailable or malformed local storage.
    }
  }, [page?.id]);

  useEffect(() => {
    if (!publishCoolingDown) {
      if (publishCooldown?.step === PUBLISH_COOLDOWNS.length) {
        localStorage.removeItem(publishCooldownKey(page?.id ?? ""));
        setPublishCooldown(null);
      }
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [publishCoolingDown, publishCooldown, page?.id]);

  const handleCopyLink = () => {
    const pageUrl =
      getAppUrl() + buildPageUrl(spaceSlug, page.slugId, page.title);

    clipboard.copy(pageUrl);
    notifications.show({ message: t("Link copied") });
  };

  const handleCopyAsMarkdown = () => {
    if (!pageEditor) return;
    const html = pageEditor.getHTML();
    const markdown = htmlToMarkdown(html);
    const title = page?.title ? `# ${page.title}\n\n` : "";
    clipboard.copy(`${title}${markdown}`);
    notifications.show({ message: t("Copied") });
  };

  const handlePrint = () => {
    setTimeout(() => {
      window.print();
    }, 250);
  };

  const openHistoryModal = () => {
    setHistoryModalOpen(true);
  };

  const handleDeletePage = () => {
    openDeleteModal({ onConfirm: () => handleDelete(page.id) });
  };

  const handleToggleFavorite = () => {
    if (!page?.id) return;
    const params = { type: "page" as const, pageId: page.id };
    if (isFavorited) {
      removeFavoriteMutation.mutate(params);
    } else {
      addFavoriteMutation.mutate(params);
    }
  };

  const handlePublishPage = () => {
    if (
      !page?.id ||
      !compileStatus ||
      publishPageKnowledge.isPending ||
      publishCoolingDown ||
      isPublishing
    )
      return;
    publishPageKnowledge.mutate(
      { pageId: page.id, indexMode },
      {
        onSuccess: () => {
          const step = (publishCooldown?.step ?? 0) + 1;
          const expiresAt =
            Date.now() +
            PUBLISH_COOLDOWNS[Math.min(step - 1, PUBLISH_COOLDOWNS.length - 1)];
          setPublishCooldown({ expiresAt, step });
          localStorage.setItem(
            publishCooldownKey(page.id),
            JSON.stringify({ expiresAt, step }),
          );
          notifications.show({ message: t("Page publish started") });
          void refetchCompileStatus();
        },
        onError: (error: any) => {
          if (error?.response?.status === 429) {
            void refetchCooldown();
          }
          notifications.show({
            message:
              error?.response?.data?.message || t("Failed to publish page"),
            color: "red",
          });
        },
      },
    );
  };

  const publishBadge = (() => {
    if (!compileStatus) return null;
    const status = compileStatus.status;
    const config = {
      completed: {
        color: "green",
        label: t("Published"),
        icon: <IconCircleCheck size={13} />,
      },
      compiling: {
        color: "blue",
        label: t("Publishing"),
        icon: <IconLoader2 size={13} className="animate-spin" />,
      },
      failed: {
        color: "red",
        label: t("Publish failed"),
        icon: <IconAlertCircle size={13} />,
      },
      not_compiled: {
        color: "gray",
        label: t("Not published"),
        icon: <IconCircle size={13} />,
      },
      outdated: {
        color: "gray",
        label: t("Needs republishing"),
        icon: <IconCircle size={13} />,
      },
    }[status] ?? {
      color: "gray",
      label: t("Not published"),
      icon: <IconCircle size={13} />,
    };
    return (
      <Tooltip
        label={
          status === "failed"
            ? compileStatus.errorMessage || t("Publish failed")
            : config.label
        }
        withArrow
      >
        <Badge
          size="sm"
          variant="light"
          color={config.color}
          leftSection={config.icon}
        >
          {config.label}
        </Badge>
      </Tooltip>
    );
  })();

  return (
    <>
      <Menu
        shadow="xl"
        position="bottom-end"
        offset={20}
        width={230}
        withArrow
        arrowPosition="center"
      >
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="dark"
            aria-label={t("Page actions")}
          >
            <IconDots size={20} />
          </ActionIcon>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconLink size={16} />}
            onClick={handleCopyLink}
          >
            {t("Copy link")}
          </Menu.Item>

          <Menu.Item
            leftSection={<IconMarkdown size={16} />}
            onClick={handleCopyAsMarkdown}
          >
            {t("Copy as Markdown")}
          </Menu.Item>

          <Menu.Item
            leftSection={
              isFavorited ? (
                <IconStarFilled
                  size={16}
                  color="var(--mantine-color-yellow-5)"
                />
              ) : (
                <IconStar size={16} />
              )
            }
            onClick={handleToggleFavorite}
          >
            {isFavorited ? t("Remove from favorites") : t("Add to favorites")}
          </Menu.Item>

          {watchStatus?.watching ? (
            <Menu.Item
              leftSection={<IconEyeOff size={16} />}
              onClick={() => unwatchPage.mutate(page.id)}
            >
              {t("Stop watching")}
            </Menu.Item>
          ) : (
            <Menu.Item
              leftSection={<IconEye size={16} />}
              onClick={() => watchPage.mutate(page.id)}
            >
              {t("Watch page")}
            </Menu.Item>
          )}

          {!readOnly && (
            <>
              <Menu.Divider />
              <Box px="sm" py="xs">
                <Group gap="xs" mb="xs">
                  <IconSparkles size={16} aria-hidden />
                  <Text size="sm">{t("Publish mode")}</Text>
                </Group>
                <SegmentedControl
                  fullWidth
                  size="xs"
                  styles={{ label: { whiteSpace: "normal" } }}
                  value={indexMode}
                  data={[
                    { value: "compiled", label: t("Smart compilation") },
                    { value: "original", label: t("Original text indexing") },
                  ]}
                  onChange={(value) => {
                    if (value === "compiled" || value === "original") {
                      setIndexMode(value);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key.startsWith("Arrow")) event.stopPropagation();
                  }}
                  disabled={
                    !compileStatus ||
                    publishPageKnowledge.isPending ||
                    publishCoolingDown ||
                    isPublishing
                  }
                  aria-label={t("Publish mode")}
                />
              </Box>
            </>
          )}

          {!readOnly && (
            <Menu.Item
              leftSection={<IconRocket size={16} />}
              onClick={handlePublishPage}
              disabled={
                !compileStatus ||
                publishPageKnowledge.isPending ||
                publishCoolingDown ||
                isPublishing
              }
              rightSection={publishBadge}
            >
              {publishCoolingDown
                ? t("Publish available in {{time}}", {
                    time: formatCooldown(publishCooldownRemaining),
                  })
                : t("Publish now")}
            </Menu.Item>
          )}

          <Menu.Divider />

          <Menu.Item leftSection={<IconArrowsHorizontal size={16} />}>
            <Group wrap="nowrap">
              <PageWidthToggle label={t("Full width")} />
            </Group>
          </Menu.Item>

          <Menu.Item
            leftSection={<IconHistory size={16} />}
            onClick={openHistoryModal}
          >
            {t("Page history")}
          </Menu.Item>

          {!readOnly && (
            <PageVerificationMenuItem
              pageId={page?.id}
              onClick={openVerificationModal}
            />
          )}

          <Menu.Divider />

          {!readOnly && (
            <Menu.Item
              leftSection={<IconArrowRight size={16} />}
              onClick={openMovePageModal}
            >
              {t("Move")}
            </Menu.Item>
          )}

          <Menu.Item
            leftSection={<IconFileExport size={16} />}
            onClick={openExportModal}
          >
            {t("Export")}
          </Menu.Item>

          <Menu.Item
            leftSection={<IconPrinter size={16} />}
            onClick={handlePrint}
          >
            {t("Print PDF")}
          </Menu.Item>

          {!readOnly && (
            <>
              <Menu.Divider />
              <Menu.Item
                color={"red"}
                leftSection={<IconTrash size={16} />}
                onClick={handleDeletePage}
              >
                {t("Move to trash")}
              </Menu.Item>
            </>
          )}

          <Menu.Divider />

          <>
            <Group px="sm" wrap="nowrap" style={{ cursor: "pointer" }}>
              <Tooltip
                label={t("Edited by {{name}} {{time}}", {
                  name: page.lastUpdatedBy.name,
                  time: pageUpdatedAt,
                })}
                position="left-start"
              >
                <div style={{ width: 210 }}>
                  <Text size="xs" c="dimmed" truncate="end">
                    {t("Word count: {{wordCount}}", {
                      wordCount: pageEditor?.storage?.characterCount?.words(),
                    })}
                  </Text>

                  <Text size="xs" c="dimmed" lineClamp={1}>
                    <Trans
                      defaults="Created by: <b>{{creatorName}}</b>"
                      values={{ creatorName: page?.creator?.name }}
                      components={{ b: <Text span fw={500} /> }}
                    />
                  </Text>
                  <Text size="xs" c="dimmed" truncate="end">
                    {t("Created at: {{time}}", {
                      time: formattedDate(page.createdAt),
                    })}
                  </Text>
                </div>
              </Tooltip>
            </Group>
          </>
        </Menu.Dropdown>
      </Menu>

      <ExportModal
        type="page"
        id={page.id}
        open={exportOpened}
        onClose={closeExportModal}
      />

      <MovePageModal
        pageId={page.id}
        slugId={page.slugId}
        currentSpaceSlug={spaceSlug}
        onClose={closeMoveSpaceModal}
        open={movePageModalOpened}
      />

      <PageVerificationModal
        pageId={page.id}
        opened={verificationOpened}
        onClose={closeVerificationModal}
      />
    </>
  );
}

function ConnectionWarning() {
  const { t } = useTranslation();
  const yjsConnectionStatus = useAtomValue(yjsConnectionStatusAtom);
  const [showWarning, setShowWarning] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const isDisconnected = ["disconnected", "connecting"].includes(
      yjsConnectionStatus,
    );

    if (isDisconnected) {
      if (!timeoutRef.current) {
        timeoutRef.current = setTimeout(() => setShowWarning(true), 5000);
      }
    } else {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setShowWarning(false);
    }
  }, [yjsConnectionStatus]);

  // Cleanup only on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  if (!showWarning) return null;

  return (
    <Tooltip
      label={t("Real-time editor connection lost. Retrying...")}
      openDelay={250}
      withArrow
    >
      <ThemeIcon
        variant="default"
        c="red"
        role="status"
        aria-label={t("Real-time editor connection lost. Retrying...")}
        style={{ border: "none" }}
      >
        <IconWifiOff size={20} stroke={2} />
      </ThemeIcon>
    </Tooltip>
  );
}
