import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Anchor,
  Badge,
  Button,
  Group,
  Kbd,
  Loader,
  Modal,
  ScrollArea,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconFileText, IconSearch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useTemplate, useTemplateList } from "../api/template-hooks";
import { PageTemplate } from "../api/template.types";
import { useSpaceDirectory } from "../lib/use-space-names";
import { TemplateToneBanner } from "./template-card";
import { TemplatePreview } from "./template-preview";
import { TemplateCreator } from "./template-creator";
import classes from "./template-quick-picker.module.css";

export interface TemplateQuickPickerProps {
  opened: boolean;
  onClose: () => void;
  /** 选中模板（已含正文）后回调；返回 Promise 时按钮显示加载态。 */
  onConfirm: (template: PageTemplate) => void | Promise<void>;
  title: string;
  confirmLabel: string;
  /** 该空间的模板排在最前面。 */
  preferredSpaceId?: string;
  /** 只展示全工作区模板 + 该空间的模板（空间内建页场景）。 */
  restrictToSpaceId?: string;
}

interface TemplateGroup {
  key: string;
  label: string;
  items: PageTemplate[];
}

export function TemplateQuickPicker({
  opened,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  preferredSpaceId,
  restrictToSpaceId,
}: TemplateQuickPickerProps) {
  const { t } = useTranslation();
  const { availabilityLabel } = useSpaceDirectory();
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 200);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 空间内建页：直接按"在该空间可用"拉取，服务端负责过滤
  const { data: templates = [], isLoading } = useTemplateList(
    restrictToSpaceId
      ? {
          scope: "available",
          spaceId: restrictToSpaceId,
          query: debouncedQuery || undefined,
        }
      : { scope: "all", query: debouncedQuery || undefined },
  );

  // 分组：本空间专属 → 所有空间 → 其他（多空间等）→ 公共模板
  const groups = useMemo<TemplateGroup[]>(() => {
    const thisSpace: PageTemplate[] = [];
    const everywhere: PageTemplate[] = [];
    const others: PageTemplate[] = [];
    const builtin: PageTemplate[] = [];
    for (const tpl of templates) {
      if (tpl.builtin) builtin.push(tpl);
      else if (tpl.allSpaces) everywhere.push(tpl);
      else if (preferredSpaceId && tpl.spaceIds.includes(preferredSpaceId))
        thisSpace.push(tpl);
      else others.push(tpl);
    }
    return [
      { key: "this", label: t("This space"), items: thisSpace },
      { key: "all", label: t("All spaces"), items: everywhere },
      { key: "other", label: t("Other spaces"), items: others },
      { key: "builtin", label: t("Built-in templates"), items: builtin },
    ].filter((g) => g.items.length > 0);
  }, [templates, preferredSpaceId, t]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    if (!flat.some((tpl) => tpl.id === activeId)) {
      setActiveId(flat[0]?.id ?? null);
    }
  }, [flat, activeId]);

  useEffect(() => {
    if (!opened) {
      setQuery("");
      setActiveId(null);
      setSubmitting(false);
    }
  }, [opened]);

  const { data: active, isFetching: previewLoading } = useTemplate(activeId);

  const move = (delta: number) => {
    if (flat.length === 0) return;
    const idx = flat.findIndex((tpl) => tpl.id === activeId);
    const next = flat[(idx + delta + flat.length) % flat.length];
    setActiveId(next.id);
    listRef.current
      ?.querySelector(`[data-template-id="${next.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const confirm = async () => {
    if (!active || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(active);
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      confirm();
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size={880}
      padding={0}
      withCloseButton={false}
      yOffset="8vh"
      aria-label={title}
    >
      <div className={classes.header}>
        <TextInput
          data-autofocus
          variant="unstyled"
          size="md"
          leftSection={<IconSearch size={18} />}
          placeholder={t("Search templates")}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          aria-label={t("Search templates")}
          aria-controls="template-quick-picker-list"
          aria-activedescendant={activeId ? `tpl-opt-${activeId}` : undefined}
        />
      </div>

      <div className={classes.body}>
        <ScrollArea className={classes.list} type="auto">
          <div
            ref={listRef}
            id="template-quick-picker-list"
            role="listbox"
            aria-label={title}
          >
            {isLoading && (
              <Group justify="center" p="md">
                <Loader size="sm" />
              </Group>
            )}
            {!isLoading && flat.length === 0 && (
              <div className={classes.emptyList}>
                <Text size="sm" fw={500}>
                  {debouncedQuery
                    ? t("No matching templates")
                    : t("No templates yet")}
                </Text>
                {!debouncedQuery && (
                  <Anchor
                    component={Link}
                    to="/templates"
                    size="xs"
                    mt={4}
                    onClick={onClose}
                  >
                    {t("Go to template management")}
                  </Anchor>
                )}
              </div>
            )}
            {groups.map((group) => (
              <div key={group.key} role="group" aria-label={group.label}>
                <Text className={classes.groupLabel}>{group.label}</Text>
                {group.items.map((tpl) => (
                  <div
                    key={tpl.id}
                    id={`tpl-opt-${tpl.id}`}
                    data-template-id={tpl.id}
                    role="option"
                    aria-selected={tpl.id === activeId}
                    className={classes.option}
                    onMouseEnter={() => setActiveId(tpl.id)}
                    onClick={() => setActiveId(tpl.id)}
                    onDoubleClick={confirm}
                  >
                    <span className={classes.optionIcon} aria-hidden>
                      {tpl.icon || <IconFileText size={18} stroke={1.5} />}
                    </span>
                    <div className={classes.optionText}>
                      <Text size="sm" truncate>
                        {tpl.title || t("Untitled")}
                      </Text>
                      {tpl.description && (
                        <Text size="xs" c="dimmed" truncate>
                          {tpl.description}
                        </Text>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>

        <ScrollArea className={classes.preview} type="auto">
          {active ? (
            <div className={classes.previewInner}>
              <div className={classes.previewPaper}>
                <TemplateToneBanner
                  templateId={active.id}
                  className={classes.previewHead}
                >
                  <Group gap="xs" mb={10}>
                    <span className={classes.previewIcon} aria-hidden>
                      {active.icon || <IconFileText size={20} stroke={1.5} />}
                    </span>
                    <Badge
                      variant="white"
                      size="sm"
                      radius="sm"
                      tt="none"
                      fw={500}
                    >
                      {availabilityLabel(active)}
                    </Badge>
                    {previewLoading && <Loader size="xs" />}
                  </Group>
                  <Text fw={700} size="xl">
                    {active.title || t("Untitled")}
                  </Text>
                  {active.description && (
                    <Text size="sm" c="dimmed" mt={4}>
                      {active.description}
                    </Text>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <TemplateCreator template={active} withUpdated />
                  </div>
                </TemplateToneBanner>
                <div className={classes.previewBody}>
                  <TemplatePreview content={active.content} />
                </div>
              </div>
            </div>
          ) : (
            <Text size="sm" c="dimmed" p="xl" ta="center">
              {t("Select a template to preview")}
            </Text>
          )}
        </ScrollArea>
      </div>

      <Group className={classes.footer} justify="space-between">
        <Group gap={6}>
          <Kbd size="xs">↑</Kbd>
          <Kbd size="xs">↓</Kbd>
          <Text size="xs" c="dimmed">
            {t("to navigate")}
          </Text>
          <Kbd size="xs">Enter</Kbd>
          <Text size="xs" c="dimmed">
            {t("to confirm")}
          </Text>
        </Group>
        <Group gap="xs">
          <Button variant="default" size="xs" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            size="xs"
            onClick={confirm}
            disabled={!active}
            loading={submitting}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Group>
    </Modal>
  );
}
