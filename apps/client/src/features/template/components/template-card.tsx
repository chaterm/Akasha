import { ReactNode } from "react";
import { Text } from "@mantine/core";
import { IconFileText } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { PageTemplate, TemplateOutlineItem } from "../api/template.types";
import classes from "./template-card.module.css";

/** 缩略图底色；按模板 id 固定取一个，同一模板每次颜色一致。 */
const TONES = ["blue", "violet", "teal", "orange", "pink", "indigo"] as const;

export function toneOf(id: string | undefined) {
  if (!id) return TONES[0];
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TONES[Math.abs(hash) % TONES.length];
}

// 骨架条宽度按文本长度估算，空文本给默认宽度，最长到 88%
const barWidth = (text: string, base: number) =>
  `${Math.min(88, Math.max(28, text ? text.length * 5 + 20 : base))}%`;

function Bar({ width }: { width: string }) {
  return <span className={classes.bar} style={{ width }} />;
}

/** 纸面上的一行骨架：只画结构，不显示文字。 */
function OutlineLine({ item }: { item: TemplateOutlineItem }) {
  switch (item.kind) {
    case "heading":
      return (
        <span
          className={classes.headingBar}
          data-level={Math.min(item.level, 3)}
          style={{ width: barWidth(item.text, 40) }}
        />
      );
    case "bullet":
    case "task":
      return (
        <div className={classes.lineItem}>
          <span
            className={item.kind === "task" ? classes.checkbox : classes.dot}
          />
          <Bar width={barWidth(item.text, 50)} />
        </div>
      );
    case "callout":
      return (
        <div className={classes.callout} data-tone={item.tone}>
          <Bar width={barWidth(item.text, 60)} />
        </div>
      );
    case "block":
      switch (item.label) {
        case "table":
          return (
            <div className={classes.table}>
              <span />
              <span />
              <span />
              <span />
            </div>
          );
        case "columns":
          return (
            <div className={classes.columns}>
              <span />
              <span />
              <span />
            </div>
          );
        case "code":
          return <div className={classes.code} />;
        default:
          // toc / details 等：一行缩进的细条
          return (
            <div className={classes.lineItem}>
              <span className={classes.caret} />
              <Bar width="46%" />
            </div>
          );
      }
    default:
      return <Bar width={barWidth(item.text, 64)} />;
  }
}

/**
 * 缩略图：浅色渐变底，左上角是图标和标题，右下角斜放一张"纸"，
 * 纸上用正文结构概要画出页面骨架（表格、高亮块、分栏各有样子）。
 */
export function TemplateThumbnail({
  template,
  compact = false,
}: {
  template: Pick<PageTemplate, "id" | "icon" | "title" | "outline">;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const outline = template.outline ?? [];
  return (
    <div
      className={classes.thumb}
      data-tone={toneOf(template.id)}
      data-compact={compact || undefined}
      aria-hidden
    >
      <div className={classes.thumbHead}>
        <span className={classes.thumbIcon}>
          {template.icon || (
            <IconFileText size={compact ? 14 : 18} stroke={1.6} />
          )}
        </span>
        <span className={classes.thumbTitle}>
          {template.title || t("Untitled")}
        </span>
      </div>
      <div className={classes.paper}>
        {outline.length ? (
          outline.map((item, i) => <OutlineLine key={i} item={item} />)
        ) : (
          <>
            <Bar width="66%" />
            <Bar width="82%" />
            <Bar width="38%" />
          </>
        )}
      </div>
    </div>
  );
}

/** 和卡片缩略图同色的横幅底，用在预览头部。 */
export function TemplateToneBanner({
  templateId,
  className,
  children,
}: {
  templateId: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`${classes.thumb} ${classes.banner} ${className ?? ""}`}
      data-tone={toneOf(templateId)}
    >
      {children}
    </div>
  );
}

interface TemplateCardProps {
  template: PageTemplate;
  scopeLabel: string;
  onClick: () => void;
  /** 鼠标悬停时右上角显示的操作 */
  actions?: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
  ariaLabel?: string;
}

export function TemplateCard({
  template,
  scopeLabel,
  onClick,
  actions,
  footer,
  compact,
  ariaLabel,
}: TemplateCardProps) {
  const { t } = useTranslation();
  return (
    <div className={classes.card} data-compact={compact || undefined}>
      <button
        type="button"
        className={classes.hit}
        onClick={onClick}
        aria-label={ariaLabel ?? template.title}
      >
        <TemplateThumbnail template={template} compact={compact} />
        <div className={classes.meta}>
          <Text size="sm" fw={600} truncate>
            {template.title || t("Untitled")}
          </Text>
          <Text
            size="xs"
            c="dimmed"
            lineClamp={compact ? 1 : 2}
            className={classes.desc}
          >
            {template.description ||
              (compact ? scopeLabel : t("No description"))}
          </Text>
          {footer ??
            (!compact && template.description && (
              <Text size="xs" c="dimmed" mt={6} className={classes.scope}>
                {scopeLabel}
              </Text>
            ))}
        </div>
      </button>
      {actions && <div className={classes.actions}>{actions}</div>}
    </div>
  );
}
