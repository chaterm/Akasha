import { useMemo, useState } from "react";
import {
  Checkbox,
  Divider,
  Popover,
  Radio,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconSearch, IconStack2 } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { TemplateAvailability } from "../api/template.types";
import { useSpaceDirectory } from "../lib/use-space-names";
import { isAvailabilityEmpty } from "../lib/availability";
import classes from "./template-availability-picker.module.css";

interface Props {
  value: TemplateAvailability;
  onChange: (value: TemplateAvailability) => void;
  /** 用户看不到的已指定空间数（只读，保存时服务端保留） */
  otherSpaceCount?: number;
  label?: string;
  size?: "xs" | "sm";
  fullWidth?: boolean;
  /** 在触发器下方显示"至少选择一个空间"的错误（表单场景） */
  showError?: boolean;
  disabled?: boolean;
}

/** 选择模板可用范围：所有空间，或多个指定空间。 */
export function TemplateAvailabilityPicker({
  value,
  onChange,
  otherSpaceCount = 0,
  label,
  size = "sm",
  fullWidth,
  showError,
  disabled = false,
}: Props) {
  const { t } = useTranslation();
  const { spaces, availabilityLabel } = useSpaceDirectory();
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? spaces.filter((s) => s.name.toLowerCase().includes(q)) : spaces;
  }, [spaces, query]);

  const empty = isAvailabilityEmpty(value, otherSpaceCount);
  const summary = empty
    ? t("No space selected")
    : availabilityLabel({ ...value, otherSpaceCount });

  const toggleSpace = (id: string, checked: boolean) => {
    const next = checked
      ? [...value.spaceIds, id]
      : value.spaceIds.filter((x) => x !== id);
    onChange({ allSpaces: false, spaceIds: next });
  };

  return (
    <div style={fullWidth ? { width: "100%" } : undefined}>
      {label && (
        <Text size="sm" fw={500} mb={4}>
          {label}
        </Text>
      )}
      <Popover
        opened={opened && !disabled}
        disabled={disabled}
        onChange={setOpened}
        position="bottom-start"
        width={300}
        shadow="md"
        withinPortal
        trapFocus
      >
        <Popover.Target>
          <UnstyledButton
            disabled={disabled}
            className={classes.trigger}
            data-size={size}
            data-full={fullWidth || undefined}
            data-invalid={empty || undefined}
            onClick={() => setOpened((o) => !o)}
            aria-haspopup="dialog"
            aria-expanded={opened}
            aria-invalid={empty || undefined}
            aria-label={t("Available in: {{scope}}", { scope: summary })}
          >
            <IconStack2 size={14} className={classes.triggerIcon} />
            <span className={classes.triggerText}>{summary}</span>
            <IconChevronDown size={14} className={classes.triggerIcon} />
          </UnstyledButton>
        </Popover.Target>

        <Popover.Dropdown p={0}>
          <Radio.Group
            value={value.allSpaces ? "all" : "some"}
            onChange={(v) =>
              onChange(
                v === "all"
                  ? { allSpaces: true, spaceIds: [] }
                  : { allSpaces: false, spaceIds: value.spaceIds },
              )
            }
          >
            <Stack gap={0} p="xs">
              <label className={classes.option}>
                <Radio value="all" size="xs" />
                <div>
                  <Text size="sm">{t("All spaces")}</Text>
                  <Text size="xs" c="dimmed">
                    {t("Available in every space, including new ones")}
                  </Text>
                </div>
              </label>
              <label className={classes.option}>
                <Radio value="some" size="xs" />
                <div>
                  <Text size="sm">{t("Specific spaces")}</Text>
                  <Text size="xs" c="dimmed">
                    {t("Only members of the selected spaces can use it")}
                  </Text>
                </div>
              </label>
            </Stack>
          </Radio.Group>

          {!value.allSpaces && (
            <>
              <Divider />
              <div className={classes.searchRow}>
                <TextInput
                  size="xs"
                  variant="filled"
                  leftSection={<IconSearch size={14} />}
                  placeholder={t("Search spaces")}
                  aria-label={t("Search spaces")}
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                />
              </div>
              <ScrollArea.Autosize mah={240} type="auto">
                <Stack gap={0} px="xs" pb="xs">
                  {filtered.map((space) => (
                    <Checkbox
                      key={space.id}
                      size="xs"
                      className={classes.spaceRow}
                      label={space.name}
                      checked={value.spaceIds.includes(space.id)}
                      onChange={(e) =>
                        toggleSpace(space.id, e.currentTarget.checked)
                      }
                    />
                  ))}
                  {filtered.length === 0 && (
                    <Text size="xs" c="dimmed" ta="center" py="sm">
                      {t("No matching spaces")}
                    </Text>
                  )}
                </Stack>
              </ScrollArea.Autosize>
              {otherSpaceCount > 0 && (
                <Text size="xs" c="dimmed" px="sm" pb="xs">
                  {t("Also available in {{count}} spaces you can't see", {
                    count: otherSpaceCount,
                  })}
                </Text>
              )}
              {empty && (
                <Text size="xs" c="red" px="sm" pb="xs" role="alert">
                  {t("Select at least one space")}
                </Text>
              )}
            </>
          )}
        </Popover.Dropdown>
      </Popover>
      {empty && showError && (
        <Text size="xs" c="red" mt={4} role="alert">
          {t("Select at least one space, or choose All spaces")}
        </Text>
      )}
    </div>
  );
}
