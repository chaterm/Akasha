import { Group, Text, ThemeIcon } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { PageTemplate } from "../api/template.types";

/** 创建人头像 + 名字（可选附带更新时间）；内置模板显示"公共模板"。 */
export function TemplateCreator({
  template,
  withUpdated = false,
  size = "xs",
}: {
  template: Pick<PageTemplate, "creator" | "updatedAt" | "builtin">;
  withUpdated?: boolean;
  size?: "xs" | "sm";
}) {
  const { t } = useTranslation();
  const updated = useTimeAgo(template.updatedAt);

  if (template.builtin) {
    const iconSize = size === "xs" ? 18 : 22;
    return (
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        <ThemeIcon size={iconSize} radius="xl" variant="light" aria-hidden>
          <IconSparkles size={iconSize - 6} stroke={1.75} />
        </ThemeIcon>
        <Text size={size} c="dimmed" truncate>
          {t("Built-in template")}
        </Text>
      </Group>
    );
  }

  const name = template.creator?.name || t("Unknown user");

  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <CustomAvatar
        avatarUrl={template.creator?.avatarUrl ?? undefined}
        name={name}
        size={size === "xs" ? 18 : 22}
      />
      <Text size={size} c="dimmed" truncate>
        {withUpdated
          ? t("{{name}} · updated {{time}}", { name, time: updated })
          : name}
      </Text>
    </Group>
  );
}
