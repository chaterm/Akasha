import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActionIcon, Badge, Group, Text, UnstyledButton } from "@mantine/core";
import {
  IconCalendar,
  IconCheckbox,
  IconChevronLeft,
  IconChevronRight,
  IconHash,
  IconLink,
  IconSelector,
  IconTag,
  IconAlignLeft,
  IconAlignCenter,
  IconAlignRight,
  IconFileDescription,
  IconLock,
  IconProgress,
  IconUser,
  type Icon,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  DATABASE_ALIGNS,
  type DatabaseAlign,
  type DatabaseColumnType,
  type DatabaseSelectOption,
} from "@docmost/editor-ext";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { buildPageUrl } from "@/features/page/page.utils";
import { DATABASE_COLOR_MAP } from "./database-utils";
import classes from "./database.module.css";

export const COLUMN_TYPE_ICONS: Record<DatabaseColumnType, Icon> = {
  text: IconAlignLeft,
  number: IconHash,
  select: IconSelector,
  multiSelect: IconTag,
  person: IconUser,
  page: IconFileDescription,
  date: IconCalendar,
  checkbox: IconCheckbox,
  url: IconLink,
  progress: IconProgress,
};

/** i18n keys. */
export const COLUMN_TYPE_LABELS: Record<DatabaseColumnType, string> = {
  text: "Text",
  number: "Number",
  select: "Select",
  multiSelect: "Multi-select",
  person: "Member",
  page: "Document",
  date: "Date",
  checkbox: "Checkbox",
  url: "URL",
  progress: "Progress",
};

/** Types offered when creating or converting a column. */
export const ADDABLE_COLUMN_TYPES: DatabaseColumnType[] = [
  "text",
  "number",
  "select",
  "multiSelect",
  "person",
  "page",
  "date",
  "checkbox",
  "url",
  "progress",
];

/** `text` with case-insensitive matches of `search` marked. */
export function Highlighted({
  text,
  search,
}: {
  text: string;
  search?: string;
}) {
  const needle = search?.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: ReactNode[] = [];
  const haystack = text.toLowerCase();
  let last = 0;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, last)
  ) {
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <mark key={at} className={classes.searchMatch}>
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    last = at + needle.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Display width in CJK characters: a Latin letter or digit counts as half. */
function charWidth(char: string) {
  return /[\x00-\xff]/.test(char) ? 0.5 : 1;
}

/** `text` cut to `limit` CJK-character widths, with "…" when anything was cut. */
export function clampText(text: string, limit: number): string {
  let used = 0;
  let out = "";
  for (const char of text) {
    used += charWidth(char);
    if (used > limit) return `${out}…`;
    out += char;
  }
  return out;
}

/** Member names show at most this many CJK characters, document titles this many. */
export const PERSON_NAME_LIMIT = 3;
export const PAGE_TITLE_LIMIT = 4;

/** A member: avatar plus name (in menus the full name, elsewhere at most three characters). */
export function PersonChip({
  person,
  search,
  menu,
}: {
  person: DatabaseSelectOption;
  search?: string;
  menu?: boolean;
}) {
  const name = menu ? person.name : clampText(person.name, PERSON_NAME_LIMIT);
  return (
    <span
      className={classes.personChip}
      data-kind="person"
      data-user-id={person.id}
      title={menu ? undefined : person.name}
    >
      <CustomAvatar avatarUrl={person.avatarUrl} name={person.name} size={18} />
      <span className={classes.chipName}>
        <Highlighted text={name} search={search} />
      </span>
    </span>
  );
}

/**
 * A document: icon plus title, linking to the page. Its title is the viewer's
 * permission-checked lookup; while it loads a dot shows, and a page the viewer
 * cannot see shows a lock instead of its title.
 */
export function PageChip({
  page,
  search,
  menu,
}: {
  page: DatabaseSelectOption;
  search?: string;
  menu?: boolean;
}) {
  const { t } = useTranslation();
  const pending = !page.unavailable && !page.slugId && !page.name;
  const title = page.unavailable
    ? t("No access")
    : pending
      ? "…"
      : page.name || t("Untitled");
  const shown = menu ? title : clampText(title, PAGE_TITLE_LIMIT);
  const content = (
    <>
      {page.unavailable ? (
        <IconLock size={14} className={classes.menuIcon} />
      ) : page.icon ? (
        <span className={classes.pageIcon}>{page.icon}</span>
      ) : (
        <IconFileDescription size={15} className={classes.menuIcon} />
      )}
      <span className={classes.chipName}>
        <Highlighted text={shown} search={search} />
      </span>
    </>
  );
  const props = {
    className: classes.personChip,
    "data-kind": "page",
    "data-page-id": page.id,
    "data-unavailable": page.unavailable || undefined,
    title: menu
      ? undefined
      : page.unavailable
        ? t("No access to this document")
        : title,
  };
  if (menu || !page.slugId) return <span {...props}>{content}</span>;
  return (
    <a
      {...props}
      className={`${classes.personChip} ${classes.pageLink}`}
      href={buildPageUrl(page.spaceSlug, page.slugId, page.name)}
      // Cards and cells react to clicks; following the link must not.
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {content}
    </a>
  );
}

/** Option badge, or the chip of a member / document column; `menu` shows full names, no links. */
export function OptionLabel({
  type,
  option,
  search,
  menu,
}: {
  type: DatabaseColumnType;
  option: DatabaseSelectOption;
  search?: string;
  menu?: boolean;
}) {
  if (type === "person")
    return <PersonChip person={option} search={search} menu={menu} />;
  if (type === "page")
    return <PageChip page={option} search={search} menu={menu} />;
  return <OptionBadge option={option} search={search} />;
}

/** Gap between chips, in pixels; the same for members and documents. */
const CHIP_GAP = 6;
/** Narrowest a chip may get: members keep the avatar, documents icon plus one character. */
const CHIP_MIN_WIDTH: Partial<Record<DatabaseColumnType, number>> = {
  person: 18,
  page: 15 + 4 + 14 + 10,
};
const MORE_WIDTH = 16;

/**
 * Member / document chips in one line: as many as fit at their narrowest; the
 * rest becomes "…". Chips shrink from their name down to that minimum. With
 * `wrap` they flow onto more lines instead.
 */
export function ChipList({
  type,
  options,
  search,
  wrap,
}: {
  type: DatabaseColumnType;
  options: DatabaseSelectOption[];
  search?: string;
  wrap?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || wrap) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [wrap]);

  const min = CHIP_MIN_WIDTH[type] ?? 40;
  let shown = options.length;
  if (!wrap && width > 0) {
    const fits = (count: number, more: boolean) =>
      count * min +
        (count - 1) * CHIP_GAP +
        (more ? CHIP_GAP + MORE_WIDTH : 0) <=
      width;
    while (shown > 1 && !fits(shown, shown < options.length)) shown -= 1;
  }
  const hidden = options.slice(shown);

  return (
    <div
      ref={ref}
      className={classes.chipList}
      data-wrap={wrap || undefined}
      style={{ gap: CHIP_GAP }}
    >
      {options.slice(0, shown).map((option) => (
        <OptionLabel
          key={option.id}
          type={type}
          option={option}
          search={search}
        />
      ))}
      {hidden.length > 0 && (
        <span
          className={classes.chipMore}
          title={hidden.map((option) => option.name).join(", ")}
        >
          …
        </span>
      )}
    </div>
  );
}

export function OptionBadge({
  option,
  onRemove,
  search,
}: {
  option: DatabaseSelectOption;
  onRemove?: () => void;
  search?: string;
}) {
  return (
    <Badge
      size="sm"
      radius="sm"
      variant="light"
      color={DATABASE_COLOR_MAP[option.color]}
      tt="none"
      fw={500}
      className={classes.optionBadge}
      rightSection={
        onRemove ? (
          <span
            role="button"
            className={classes.badgeRemove}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            ×
          </span>
        ) : undefined
      }
    >
      {option.name ? <Highlighted text={option.name} search={search} /> : " "}
    </Badge>
  );
}

interface MenuRowProps {
  icon?: Icon;
  label: ReactNode;
  /** Text shown on the right, e.g. the current value of a submenu. */
  hint?: ReactNode;
  submenu?: boolean;
  danger?: boolean;
  active?: boolean;
  onClick: () => void;
}

/** A row in our popover menus; Mantine Menu steals focus from inputs placed inside it. */
export function MenuRow({
  icon: RowIcon,
  label,
  hint,
  submenu,
  danger,
  active,
  onClick,
}: MenuRowProps) {
  return (
    <UnstyledButton
      className={classes.menuRow}
      data-danger={danger || undefined}
      data-active={active || undefined}
      onClick={onClick}
    >
      <Group gap={8} wrap="nowrap" flex={1} miw={0}>
        {RowIcon && <RowIcon size={15} className={classes.menuIcon} />}
        <Text size="sm" truncate inherit>
          {label}
        </Text>
      </Group>
      {hint !== undefined && (
        <Text size="xs" c="dimmed" truncate>
          {hint}
        </Text>
      )}
      {submenu && <IconChevronRight size={14} className={classes.menuIcon} />}
    </UnstyledButton>
  );
}

export function MenuBack({
  label,
  onBack,
}: {
  label: ReactNode;
  onBack: () => void;
}) {
  return (
    <UnstyledButton className={classes.menuBack} onClick={onBack}>
      <IconChevronLeft size={14} />
      <Text size="sm" fw={600}>
        {label}
      </Text>
    </UnstyledButton>
  );
}

export function MenuDivider() {
  return <div className={classes.menuDivider} />;
}

const ALIGN_ICONS: Record<DatabaseAlign, Icon> = {
  left: IconAlignLeft,
  center: IconAlignCenter,
  right: IconAlignRight,
};

/** i18n keys. */
const ALIGN_LABELS: Record<DatabaseAlign, string> = {
  left: "Align left",
  center: "Align center",
  right: "Align right",
};

/** Left / center / right toggle buttons; `null` = none active (mixed). */
export function AlignPicker({
  value,
  onChange,
  className,
}: {
  value: DatabaseAlign | null;
  onChange: (align: DatabaseAlign) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Group gap={2} wrap="nowrap" className={className}>
      {DATABASE_ALIGNS.map((align) => {
        const AlignIcon = ALIGN_ICONS[align];
        return (
          <ActionIcon
            key={align}
            size="sm"
            variant={value === align ? "light" : "subtle"}
            color="gray"
            aria-label={t(ALIGN_LABELS[align])}
            title={t(ALIGN_LABELS[align])}
            aria-pressed={value === align}
            onClick={() => onChange(align)}
          >
            <AlignIcon size={14} />
          </ActionIcon>
        );
      })}
    </Group>
  );
}
