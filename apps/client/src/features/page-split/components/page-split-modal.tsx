import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowBarDown,
  IconArrowBarUp,
  IconBulb,
  IconChevronDown,
  IconChevronRight,
  IconRestore,
} from "@tabler/icons-react";
import type { JSONContent } from "@tiptap/core";
import { WebSocketStatus } from "@hocuspocus/provider";
import { useAtomValue, useStore } from "jotai";
import { type ReactNode, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import {
  pageEditorAtom,
  yjsConnectionStatusAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import { useQueryClient } from "@tanstack/react-query";
import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import {
  createPage,
  deletePage,
  getAllSidebarPages,
  movePage,
} from "@/features/page/services/page-service.ts";
import {
  invalidateOnCreatePage,
  invalidateOnDeletePage,
} from "@/features/page/queries/page-query.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { treeModel } from "@/features/page/tree/model/tree-model";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation.ts";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { IPage } from "@/features/page/types/page.types.ts";
import { useQueryEmit } from "@/features/websocket/use-query-emit.ts";
import classes from "./page-split-modal.module.css";
import {
  PlannedPage,
  balancedStarts,
  buildPages,
  exceedsLimits,
  moveStart,
  recommendLevel,
  recommendStarts,
  displayLevels,
  splitUnits,
} from "../page-split.utils";

/** nested：放到新建的父页面下；flat：与原页面同级。 */
type SplitMode = "nested" | "flat";

interface PageSplitModalProps {
  page: IPage;
  opened: boolean;
  onClose: () => void;
}
export function PageSplitModal({ page, opened, onClose }: PageSplitModalProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      opened={opened}
      onClose={() => !busy && onClose()}
      title={t("Smart split")}
      size="lg"
      closeOnClickOutside={false}
    >
      <PageSplitPanel page={page} onClose={onClose} onBusyChange={setBusy} />
    </Modal>
  );
}

// 各列固定宽度，使输入框上下对齐。
const TOGGLE_WIDTH = 22;
const LABEL_WIDTH = 64;

function PreviewRow({
  label,
  value,
  placeholder,
  onChange,
  status,
  statusColor = "gray",
  expanded,
  onToggle,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  status?: string;
  statusColor?: string;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Group wrap="nowrap" gap="xs">
      <div style={{ width: TOGGLE_WIDTH, flexShrink: 0 }}>
        {onToggle && (
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? t("Collapse") : t("Expand")}
          >
            {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          </ActionIcon>
        )}
      </div>
      <Text size="xs" c="dimmed" w={LABEL_WIDTH} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <TextInput
        size="xs"
        style={{ flex: 1 }}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label={t("Page title")}
      />
      <div style={{ width: 64, flexShrink: 0 }}>
        {status && (
          <Badge size="sm" variant="light" color={statusColor}>
            {status}
          </Badge>
        )}
      </div>
    </Group>
  );
}

function UnitAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} openDelay={300} withArrow>
      <ActionIcon size="sm" variant="subtle" color="gray" onClick={onClick} aria-label={label}>
        {icon}
      </ActionIcon>
    </Tooltip>
  );
}

function readBlocks(content: JSONContent | undefined): JSONContent[] {
  return content?.content ?? [];
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group wrap="nowrap" gap="sm">
      <Text size="sm" fw={500} w={72} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <div style={{ flex: 1 }}>{children}</div>
    </Group>
  );
}

function PageSplitPanel({
  page,
  onClose,
  onBusyChange,
}: {
  page: IPage;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const connectionStatus = useAtomValue(yjsConnectionStatusAtom);
  const store = useStore();
  const emit = useQueryEmit();
  const { handleMove } = useTreeMutation(page.spaceId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { spaceSlug } = useParams();

  // 打开面板时的快照，拆分前校验期间是否被编辑过。
  const [blocks, setBlocks] = useState(() => readBlocks(pageEditor?.getJSON()));
  const levels = useMemo(() => displayLevels(blocks), [blocks]);
  const recommended = useMemo(() => recommendLevel(blocks), [blocks]);
  const [level, setLevel] = useState(recommended);
  const [mode, setMode] = useState<SplitMode>("nested");
  const units = useMemo(
    () => (level === null ? [] : splitUnits(blocks, level)),
    [blocks, level],
  );
  const recommendedStarts = useMemo(() => recommendStarts(units), [units]);
  // 用户手动调整后的方案，null 表示用推荐方案。
  const [customStarts, setCustomStarts] = useState<number[] | null>(null);
  const starts = customStarts ?? recommendedStarts;
  const pages = useMemo(() => buildPages(units, starts), [units, starts]);
  // 按页首单元记录，调整其他页的分界时不受影响。
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [parentTitle, setParentTitle] = useState(page.title ?? "");
  const [submitting, setSubmittingState] = useState(false);
  const setSubmitting = (value: boolean) => {
    setSubmittingState(value);
    onBusyChange(value);
  };

  const resetPlan = () => {
    setCustomStarts(null);
    setTitles({});
    setExpanded(new Set());
  };
  // 只含第一个标题前内容的页面沿用原页面标题。
  const defaultTitle = (planned: PlannedPage) => planned.title || page.title || "";
  const unitLabel = (unitIndex: number) =>
    units[unitIndex].title || t("Content before the first heading");
  const titleOf = (planned: PlannedPage) =>
    titles[planned.start]?.trim() || defaultTitle(planned);
  const connected = connectionStatus === WebSocketStatus.Connected;
  const hasOverLimit = pages.some((planned) => exceedsLimits(planned.stats));

  // 该页的标题和展开状态跟随新的页首单元。
  const moveBoundary = (pageIndex: number, to: number) => {
    const from = starts[pageIndex];
    // 该页被合并掉时不再保留它的状态。
    const merged = starts.includes(to) || to >= units.length;
    setCustomStarts(moveStart(starts, pageIndex, to, units.length));
    setExpanded((prev) => {
      if (!prev.has(from)) return prev;
      const next = new Set(prev);
      next.delete(from);
      return merged ? next : next.add(to);
    });
    setTitles((prev) => {
      if (prev[from] === undefined) return prev;
      const { [from]: title, ...rest } = prev;
      return merged ? rest : { ...rest, [to]: title };
    });
  };
  const changeCount = (value: string | number) => {
    const count = Number(value);
    if (!Number.isInteger(count) || count < 1) return;
    setCustomStarts(
      count === recommendedStarts.length ? null : balancedStarts(units, count),
    );
  };
  const toggleExpanded = (start: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(start)) next.delete(start);
      else next.add(start);
      return next;
    });
  };
  const insertIntoTree = (created: IPage) => {
    const parentId = created.parentPageId ?? null;
    const node: SpaceTreeNode = {
      id: created.id,
      slugId: created.slugId,
      name: created.title ?? "",
      icon: created.icon ?? undefined,
      position: created.position,
      spaceId: created.spaceId,
      parentPageId: created.parentPageId,
      hasChildren: false,
      children: [],
    };
    const current = store.get(treeDataAtom);
    const parent = parentId ? treeModel.find(current, parentId) : null;
    const index = parentId ? (parent?.children?.length ?? 0) : current.length;
    if (parentId === null) {
      store.set(treeDataAtom, treeModel.insert(current, null, node, index));
    } else if (parent) {
      // 子节点未加载时只标记 hasChildren，避免懒加载误以为子节点已就绪。
      const unloaded =
        (parent as SpaceTreeNode).hasChildren && !parent.children?.length;
      const next = unloaded ? current : treeModel.insert(current, parentId, node, index);
      store.set(
        treeDataAtom,
        treeModel.update(next, parentId, { hasChildren: true } as Partial<SpaceTreeNode>),
      );
    }
    setTimeout(() => {
      emit({
        operation: "addTreeNode",
        spaceId: created.spaceId,
        payload: { parentId, index, data: node },
      });
    }, 50);
  };

  const invalidateTree = () => {
    void queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey[0] === "root-sidebar-pages" ||
        query.queryKey[0] === "sidebar-pages" ||
        query.queryKey[0] === "breadcrumbs",
    });
  };

  const createPlannedPage = async (
    title: string,
    parentPageId: string | undefined,
    content?: JSONContent,
  ) => {
    const created = await createPage({
      spaceId: page.spaceId,
      parentPageId,
      title,
      ...(content ? { content, format: "json" as const } : {}),
    });
    invalidateOnCreatePage(created);
    insertIntoTree(created);
    return created;
  };

  // 删除会连带子页面，先把原页面的子页面移到 targetId 下，按原顺序排在末尾。
  const moveChildrenTo = async (targetId: string) => {
    const result = await getAllSidebarPages({ spaceId: page.spaceId, pageId: page.id });
    const children = result.pages.flatMap((item) => item.items);
    let lastPosition: string | null = null;
    for (const child of children) {
      const tree = store.get(treeDataAtom);
      if (treeModel.find(tree, child.id) && treeModel.find(tree, targetId)) {
        await handleMove(child.id, { kind: "make-child", targetId });
        const moved = treeModel.find(store.get(treeDataAtom), child.id) as SpaceTreeNode | null;
        // handleMove 失败时不抛错，需自行确认。
        if (moved?.parentPageId !== targetId) throw new Error("move failed");
      } else {
        lastPosition = generateJitteredKeyBetween(lastPosition, null);
        await movePage({ pageId: child.id, parentPageId: targetId, position: lastPosition });
        invalidateTree();
      }
    }
  };

  const moveOriginalToTrash = async () => {
    await deletePage(page.id);
    const stamped = { ...page, deletedAt: new Date() };
    queryClient.setQueryData(["pages", page.id], stamped);
    queryClient.setQueryData(["pages", page.slugId], stamped);
    invalidateOnDeletePage(page.id);
    void queryClient.invalidateQueries({ queryKey: ["trash-list"] });
    const node = treeModel.find(store.get(treeDataAtom), page.id);
    store.set(treeDataAtom, treeModel.remove(store.get(treeDataAtom), page.id));
    if (node) {
      setTimeout(() => {
        emit({ operation: "deleteTreeNode", spaceId: page.spaceId, payload: { node } });
      }, 50);
    }
  };

  const handleSplit = async () => {
    if (!pageEditor || pageEditor.isDestroyed || pages.length < 2 || hasOverLimit) return;
    const latest = readBlocks(pageEditor.getJSON());
    if (JSON.stringify(latest) !== JSON.stringify(blocks)) {
      setBlocks(latest);
      setLevel(recommendLevel(latest));
      resetPlan();
      notifications.show({
        message: t("The page changed while the panel was open. Split options were refreshed."),
        color: "yellow",
      });
      return;
    }

    setSubmitting(true);
    const total = pages.length + (mode === "nested" ? 1 : 0);
    let created = 0;
    let step: "create" | "children" | "trash" = "create";
    let destination: IPage | null = null;
    try {
      // 新页面依次排在原页面之后，原页面删除后正好占据它的位置。
      let anchorId = page.id;
      let parentPageId = page.parentPageId || undefined;
      if (mode === "nested") {
        const parentPage = await createPlannedPage(
          parentTitle.trim() || page.title || "",
          parentPageId,
        );
        created += 1;
        await handleMove(parentPage.id, { kind: "reorder-after", targetId: page.id });
        destination = parentPage;
        parentPageId = parentPage.id;
        anchorId = "";
      }
      for (const planned of pages) {
        const newPage = await createPlannedPage(titleOf(planned), parentPageId, planned.content);
        created += 1;
        if (anchorId) {
          await handleMove(newPage.id, { kind: "reorder-after", targetId: anchorId });
        }
        anchorId = newPage.id;
        destination ??= newPage;
      }

      step = "children";
      await moveChildrenTo(destination!.id);

      step = "trash";
      await moveOriginalToTrash();
    } catch {
      setSubmitting(false);
      const message =
        step === "trash"
          ? t("The new pages were created, but the original page couldn't be moved to the trash. Please move it manually.")
          : step === "children"
            ? t("The new pages were created, but moving the original page's subpages failed. The original page was kept.")
            : t("Split stopped after creating {{created}} of {{total}} pages. The original page was kept.", {
                created,
                total,
              });
      notifications.show({ message, color: "red" });
      return;
    }

    notifications.show({
      message: t("Split into {{pageCount}} pages. The original page was moved to the trash.", {
        pageCount: pages.length,
      }),
    });
    setSubmitting(false);
    onClose();
    navigate(buildPageUrl(spaceSlug, destination!.slugId, destination!.title));
  };

  if (level === null) {
    return (
      <Stack>
        <Alert color="gray" icon={<IconAlertTriangle size={16} />}>
          {t("No headings to split by, so this page can't be split automatically. Please split it manually, or add headings and try again.")}
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t("Cancel")}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
        <Text size="sm">
          {mode === "nested"
            ? t("The content will be split into subpages under a new parent page.")
            : t("The content will be split into several pages at the same level.")}
        </Text>
        <Text size="sm" mt={4}>
          <Trans
            defaults="The original page will be moved to the trash. You can restore it from Space menu > <link>Trash</link>."
            components={{
              link: <Anchor component={Link} to={`/s/${spaceSlug}/trash`} size="sm" />,
            }}
          />
        </Text>
      </Alert>
      <Field label={t("Split method")}>
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(value) => setMode(value as SplitMode)}
          data={[
            { value: "nested", label: t("Subpages") },
            { value: "flat", label: t("Flat") },
          ]}
        />
      </Field>
      <Field label={t("Split at")}>
        <SegmentedControl
          fullWidth
          value={String(level)}
          onChange={(value) => {
            setLevel(Number(value));
            resetPlan();
          }}
          data={levels.map((item) => ({
            value: String(item),
            label:
              item === recommended
                ? t("H{{level}} · Recommended", { level: item })
                : `H${item}`,
          }))}
        />
      </Field>
      <Field label={t("Page count")}>
        <Group gap="xs" wrap="nowrap">
          <NumberInput
            size="xs"
            w={90}
            min={1}
            max={Math.max(1, units.length)}
            allowDecimal={false}
            clampBehavior="strict"
            value={pages.length}
            onChange={changeCount}
            aria-label={t("Page count")}
          />
          <Text size="xs" c="dimmed">
            {t("Recommended: {{pageCount}}", { pageCount: recommendedStarts.length })}
          </Text>
          {customStarts && (
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={<IconRestore size={14} />}
              onClick={resetPlan}
            >
              {t("Reset")}
            </Button>
          )}
        </Group>
      </Field>

      <Text size="sm" fw={500} mt="xs">
        {t("Preview")}
      </Text>
      <ScrollArea.Autosize mah={320} type="auto" offsetScrollbars>
        <Stack gap={6}>
          {mode === "nested" && (
            <PreviewRow
              label={t("Parent page")}
              value={parentTitle}
              placeholder={t("Untitled")}
              onChange={setParentTitle}
              status={t("Empty")}
            />
          )}
          {pages.map((planned, pageIndex) => {
            const isExpanded = expanded.has(planned.start);
            const isLastPage = pageIndex === pages.length - 1;
            return (
              <div key={planned.start}>
                <PreviewRow
                  label={
                    mode === "nested"
                      ? t("Subpage {{number}}", { number: pageIndex + 1 })
                      : t("Page {{number}}", { number: pageIndex + 1 })
                  }
                  value={titles[planned.start] ?? defaultTitle(planned)}
                  placeholder={defaultTitle(planned) || t("Untitled")}
                  onChange={(value) =>
                    setTitles((prev) => ({ ...prev, [planned.start]: value }))
                  }
                  status={exceedsLimits(planned.stats) ? t("Over limit") : undefined}
                  statusColor="red"
                  expanded={isExpanded}
                  onToggle={() => toggleExpanded(planned.start)}
                />
                {isExpanded && (
                  <Stack gap={2} mt={4} mb={4} pl={TOGGLE_WIDTH + LABEL_WIDTH + 20}>
                    {planned.unitIndexes.map((unitIndex, offset) => {
                      return (
                        <Group
                          key={unitIndex}
                          wrap="nowrap"
                          gap={4}
                          className={classes.unitRow}
                        >
                          <Text size="xs" style={{ flex: 1 }} truncate="end">
                            {unitLabel(unitIndex)}
                          </Text>
                          <div className={classes.unitActions}>
                            {pageIndex > 0 && (
                              <UnitAction
                                label={t("Move this and above to previous page")}
                                icon={<IconArrowBarUp size={14} />}
                                onClick={() => moveBoundary(pageIndex, unitIndex + 1)}
                              />
                            )}
                            {!isLastPage && (
                              <UnitAction
                                label={t("Move this and below to next page")}
                                icon={<IconArrowBarDown size={14} />}
                                onClick={() => moveBoundary(pageIndex + 1, unitIndex)}
                              />
                            )}
                          </div>
                        </Group>
                      );
                    })}
                  </Stack>
                )}
              </div>
            );
          })}
        </Stack>
      </ScrollArea.Autosize>

      {pages.length < 2 && (
        <Text size="xs" c="dimmed">
          {t("The content fits on one page. Increase the page count to split it.")}
        </Text>
      )}
      <Group gap={6} wrap="nowrap" align="flex-start">
        <IconBulb size={14} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0, marginTop: 2 }} />
        <Text size="xs" c="dimmed">
          {t("Tip: Rule-based splitting is approximate. Expand a page to adjust its sections, and edit page titles as needed.")}
        </Text>
      </Group>
      {hasOverLimit && (
        <Text size="xs" c="red">
          {t("Some pages are over the limit. Adjust the split before continuing.")}
        </Text>
      )}
      {!connected && (
        <Text size="xs" c="red">
          {t("Real-time editor connection lost. Retrying...")}
        </Text>
      )}

      <Group justify="flex-end">
        <Button variant="default" onClick={onClose} disabled={submitting}>
          {t("Cancel")}
        </Button>
        <Button
          onClick={handleSplit}
          loading={submitting}
          disabled={!connected || pages.length < 2 || hasOverLimit}
        >
          {t("Split")}
        </Button>
      </Group>
    </Stack>
  );
}
