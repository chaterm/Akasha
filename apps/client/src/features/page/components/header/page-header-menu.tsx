import {
  ActionIcon,
  Badge,
  Box,
  Group,
  Menu,
  Popover,
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
  IconInfoCircle,
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
  IconTemplate,
  IconDeviceFloppy,
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
  useSetPageIndexModeMutation,
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
  titleEditorAtom,
  yjsConnectionStatusAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";
import { TemplateQuickPicker } from "@/features/template/components/template-quick-picker";
import { SaveAsTemplateModal } from "@/features/template/components/save-as-template-modal";
import { applyTemplateToEditor } from "@/features/template/lib/apply-template";
import { formattedDate } from "@/lib/time.ts";
import { PageEditModeControls } from "@/features/editor/components/page-edit-mode-toggle.tsx";
import MovePageModal from "@/features/page/components/move-page-modal.tsx";
import { useTimeAgo } from "@/hooks/use-time-ago.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { PageShareModal } from "@/ee/page-permission";
import {
  PageVerificationMenuItem,
  PageVerificationModal,
} from "@/features/page-verification";
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
import type { KnowledgePageIndexModeChoice } from "@/features/page/services/page-service";
import { notifyError } from "@/lib/errors";
import { formatBytes } from "@/lib/utils.tsx";
import { IPage } from "@/features/page/types/page.types.ts";
import { PageSplitWarning } from "@/features/page-split/components/page-split-warning.tsx";
import { usePageContentStats } from "@/features/page-split/hooks/use-page-content-stats.ts";
import {
  PAGE_IMAGE_LIMIT,
  PAGE_SIZE_LIMIT_BYTES,
  PAGE_WORD_LIMIT,
} from "@/features/page-split/page-split.utils.ts";

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

      {!readOnly && page && <PageSplitWarning page={page} />}

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
  const titleEditor = useAtomValue(titleEditorAtom);
  const hasTemplates = useHasFeature(Feature.TEMPLATES);
  const canSaveAsTemplate = hasTemplates;
  const [
    insertTemplateOpened,
    { open: openInsertTemplate, close: closeInsertTemplate },
  ] = useDisclosure(false);
  const [
    saveTemplateOpened,
    { open: openSaveTemplate, close: closeSaveTemplate },
  ] = useDisclosure(false);
  const pageUpdatedAt = useTimeAgo(page?.updatedAt);
  const favoriteIds = useFavoriteIds("page", page?.spaceId);
  const addFavoriteMutation = useAddFavoriteMutation();
  const removeFavoriteMutation = useRemoveFavoriteMutation();
  const isFavorited = page?.id ? favoriteIds.has(page.id) : false;
  const { data: watchStatus } = useWatchStatusQuery(page?.id);
  const watchPage = useWatchPageMutation();
  const unwatchPage = useUnwatchPageMutation();
  const { isOwner } = useUserRole();
  const publishPageKnowledge = usePublishPageKnowledgeMutation();
  const setPageIndexMode = useSetPageIndexModeMutation();
  const { data: serverCooldown, refetch: refetchCooldown } =
    usePagePublishCooldownQuery(page?.id);
  const { data: compileStatus, refetch: refetchCompileStatus } =
    usePageCompileStatusQuery(page?.id);
  const [publishCooldown, setPublishCooldown] = useState<{
    expiresAt: number;
    step: number;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [indexMode, setIndexMode] =
    useState<KnowledgePageIndexModeChoice>("inherit");
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
  const publishCoolingDown = !isOwner && publishCooldownRemaining > 0;
  const isPublishing = compileStatus?.status === "compiling";

  useEffect(() => {
    setIndexMode(compileStatus?.pageIndexMode ?? "inherit");
  }, [page?.id, compileStatus?.pageIndexMode]);
  // A space set to a specific mode locks every page; "default" lets the page
  // choose and falls back to smart compilation.
  const spaceIndexMode = compileStatus?.spaceIndexMode ?? "default";
  const spaceLocksIndexMode = spaceIndexMode !== "default";
  const effectiveIndexMode = spaceLocksIndexMode
    ? spaceIndexMode
    : indexMode === "inherit"
      ? "compiled"
      : indexMode;
  const effectiveIndexModeLabel =
    effectiveIndexMode === "original"
      ? t("Original text indexing")
      : t("Smart compilation");

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
      setPageIndexMode.isPending ||
      publishPageKnowledge.isPending ||
      publishCoolingDown ||
      isPublishing
    )
      return;
    publishPageKnowledge.mutate(
      { pageId: page.id, indexMode },
      {
        onSuccess: () => {
          if (!isOwner) {
            const step = (publishCooldown?.step ?? 0) + 1;
            const expiresAt =
              Date.now() +
              PUBLISH_COOLDOWNS[
                Math.min(step - 1, PUBLISH_COOLDOWNS.length - 1)
              ];
            setPublishCooldown({ expiresAt, step });
            localStorage.setItem(
              publishCooldownKey(page.id),
              JSON.stringify({ expiresAt, step }),
            );
          }
          notifications.show({ message: t("Page publish started") });
          void refetchCompileStatus();
        },
        onError: (error: any) => {
          if (error?.response?.status === 429) {
            void refetchCooldown();
          }
          notifyError(error, "Failed to publish page");
        },
      },
    );
  };

  // Saved immediately; independent of publishing and its cooldown.
  const handleIndexModeChange = (value: string) => {
    if (!page?.id || (value !== "compiled" && value !== "original")) return;
    const previous = indexMode;
    setIndexMode(value);
    setPageIndexMode.mutate(
      { pageId: page.id, indexMode: value },
      {
        onError: (error: any) => {
          setIndexMode(previous);
          notifyError(error, "Failed to save publish mode");
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
          status === "failed" ? t("Publish failed") : config.label
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
                  <Popover
                    width={300}
                    position="bottom-end"
                    withinPortal={false}
                    withArrow
                  >
                    <Popover.Target>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="gray"
                        aria-label={t("About publish modes")}
                        title={t("About publish modes")}
                      >
                        <IconInfoCircle size={16} aria-hidden />
                      </ActionIcon>
                    </Popover.Target>
                    <Popover.Dropdown
                      style={{ maxWidth: "calc(100vw - 24px)" }}
                    >
                      <Text size="sm" fw={600}>
                        {t("Smart compilation")}
                      </Text>
                      <Text size="xs" mt={4}>
                        {t(
                          "AI extracts key points and connects related knowledge. Choose this for product guides, training materials, and project experience that need summarizing or explaining.",
                        )}
                      </Text>
                      <Text size="sm" fw={600} mt="sm">
                        {t("Original text indexing")}
                      </Text>
                      <Text size="xs" mt={4}>
                        {t(
                          "Uses the document text directly. Choose this for contracts, policies, procedures, and parameter lists when the original wording matters. Information inside images is not recognized.",
                        )}
                      </Text>
                      <Text size="xs" c="dimmed" mt="sm">
                        {t(
                          "Both modes support AI Q&A and leave the original document unchanged.",
                        )}
                      </Text>
                    </Popover.Dropdown>
                  </Popover>
                </Group>
                <SegmentedControl
                  fullWidth
                  size="xs"
                  styles={{ label: { whiteSpace: "normal" } }}
                  value={effectiveIndexMode}
                  data={[
                    { value: "compiled", label: t("Smart compilation") },
                    { value: "original", label: t("Original text indexing") },
                  ]}
                  onChange={handleIndexModeChange}
                  onKeyDown={(event) => {
                    if (event.key.startsWith("Arrow")) event.stopPropagation();
                  }}
                  disabled={
                    !compileStatus ||
                    spaceLocksIndexMode ||
                    setPageIndexMode.isPending ||
                    publishPageKnowledge.isPending ||
                    isPublishing
                  }
                  aria-label={t("Publish mode")}
                />
                {compileStatus && (
                  <Text size="xs" c="dimmed" mt={4}>
                    {spaceLocksIndexMode
                      ? t("Current: {{mode}} (set by space)", {
                          mode: effectiveIndexModeLabel,
                        })
                      : indexMode === "inherit"
                        ? t("Current: {{mode}} (default)", {
                            mode: effectiveIndexModeLabel,
                          })
                        : t("Current: {{mode}} (page setting)", {
                            mode: effectiveIndexModeLabel,
                          })}
                  </Text>
                )}
              </Box>
            </>
          )}

          {!readOnly && (
            <Menu.Item
              leftSection={<IconRocket size={16} />}
              onClick={handlePublishPage}
              disabled={
                !compileStatus ||
                setPageIndexMode.isPending ||
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

          {hasTemplates && (!readOnly || canSaveAsTemplate) && (
            <>
              <Menu.Divider />
              {!readOnly && (
                <Menu.Item
                  leftSection={<IconTemplate size={16} />}
                  onClick={openInsertTemplate}
                >
                  {t("Insert template")}
                </Menu.Item>
              )}
              {canSaveAsTemplate && (
                <Menu.Item
                  leftSection={<IconDeviceFloppy size={16} />}
                  onClick={openSaveTemplate}
                >
                  {t("Save as template")}
                </Menu.Item>
              )}
            </>
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

          <PageMenuFooter page={page} pageUpdatedAt={pageUpdatedAt} />
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

      {hasTemplates && insertTemplateOpened && (
        <TemplateQuickPicker
          opened={insertTemplateOpened}
          onClose={closeInsertTemplate}
          title={t("Insert template")}
          confirmLabel={
            pageEditor?.isEmpty ? t("Apply to page") : t("Insert at cursor")
          }
          preferredSpaceId={page.spaceId}
          onConfirm={(template) => {
            closeInsertTemplate();
            if (!pageEditor || pageEditor.isDestroyed) return;
            applyTemplateToEditor(pageEditor, titleEditor, template);
          }}
        />
      )}

      {canSaveAsTemplate && (
        <SaveAsTemplateModal
          opened={saveTemplateOpened}
          onClose={closeSaveTemplate}
          page={page}
        />
      )}
    </>
  );
}

interface PageMenuFooterProps {
  page: IPage;
  pageUpdatedAt: string;
}
function PageMenuFooter({ page, pageUpdatedAt }: PageMenuFooterProps) {
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const stats = usePageContentStats(pageEditor);
  const overImages = stats.imageCount > PAGE_IMAGE_LIMIT;
  const overSize = stats.bytes > PAGE_SIZE_LIMIT_BYTES;
  const overWords = stats.words > PAGE_WORD_LIMIT;

  return (
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
            <Text size="xs" c={overWords ? "red" : "dimmed"} truncate="end">
              {t("Word count: {{wordCount}}", {
                wordCount: pageEditor?.storage?.characterCount?.words(),
              })}
            </Text>
            <Text size="xs" c={overImages ? "red" : "dimmed"} truncate="end">
              {t("Images: {{imageCount}}", { imageCount: stats.imageCount })}
            </Text>
            <Text size="xs" c={overSize ? "red" : "dimmed"} truncate="end">
              {t("Page size: {{size}}", { size: formatBytes(stats.bytes) })}
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
