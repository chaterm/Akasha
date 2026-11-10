import { useMemo, useState } from "react";
import { Anchor, Group, SimpleGrid, Text, UnstyledButton } from "@mantine/core";
import { IconChevronRight, IconLoader2 } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation";
import { useTemplateList } from "../api/template-hooks";
import { PageTemplate } from "../api/template.types";
import { TemplateCard } from "./template-card";
import { TemplateQuickPicker } from "./template-quick-picker";
import classes from "./space-templates-section.module.css";

const VISIBLE = 4;

interface SpaceTemplatesSectionProps {
  spaceId: string;
  canCreatePages: boolean;
}

/** 空间概览中的"可用模板"：所有空间模板 + 指定到本空间的模板，点击即用它新建页面。 */
export function SpaceTemplatesSection({
  spaceId,
  canCreatePages,
}: SpaceTemplatesSectionProps) {
  const { t } = useTranslation();
  const { handleCreate } = useTreeMutation(spaceId);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { data = [], isLoading } = useTemplateList({
    scope: "available",
    spaceId,
  });

  // 本空间专属 → 团队的"所有空间"模板 → 公共模板
  const templates = useMemo(() => {
    const rank = (tpl: PageTemplate) =>
      tpl.builtin ? 2 : tpl.allSpaces ? 1 : 0;
    return [...data].sort((a, b) => rank(a) - rank(b));
  }, [data]);

  if (!canCreatePages || isLoading) return null;

  // 还没有可用模板：只留一行轻量引导，帮助冷启动
  if (templates.length === 0) {
    return (
      <Text size="xs" c="dimmed" className={classes.root}>
        {t("No templates available in this space yet.")}{" "}
        <Anchor component={Link} to="/templates" size="xs">
          {t("Browse templates")}
        </Anchor>
      </Text>
    );
  }

  /** 返回是否创建成功；错误提示已在 handleCreate 内处理。 */
  const create = async (tpl: PageTemplate): Promise<boolean> => {
    if (pendingId) return false;
    setPendingId(tpl.id);
    try {
      await handleCreate(null, { templateId: tpl.id });
      return true;
    } catch {
      return false;
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section className={classes.root} aria-labelledby="space-templates-heading">
      <Group justify="space-between" mb="sm">
        <Text id="space-templates-heading" size="sm" fw={600}>
          {t("Start from a template")}
        </Text>
        <Group gap="md">
          {templates.length > VISIBLE && (
            <UnstyledButton
              className={classes.more}
              onClick={() => setPickerOpen(true)}
            >
              {t("All templates")}
              <IconChevronRight size={14} />
            </UnstyledButton>
          )}
          <Anchor component={Link} to="/templates" size="xs" c="dimmed">
            {t("Manage templates")}
          </Anchor>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        {templates.slice(0, VISIBLE).map((tpl) => (
          <TemplateCard
            key={tpl.id}
            compact
            template={tpl}
            scopeLabel={tpl.allSpaces ? t("All spaces") : t("This space")}
            ariaLabel={t("New page from template {{title}}", {
              title: tpl.title,
            })}
            onClick={() => create(tpl)}
            actions={
              pendingId === tpl.id && (
                <IconLoader2 size={16} className={classes.spin} aria-hidden />
              )
            }
          />
        ))}
      </SimpleGrid>

      {pickerOpen && (
        <TemplateQuickPicker
          opened={pickerOpen}
          onClose={() => setPickerOpen(false)}
          title={t("New page from template")}
          confirmLabel={t("Create page")}
          preferredSpaceId={spaceId}
          restrictToSpaceId={spaceId}
          onConfirm={async (tpl) => {
            // 失败时保持打开以便重试，与侧边栏入口一致
            if (await create(tpl)) setPickerOpen(false);
          }}
        />
      )}
    </section>
  );
}
