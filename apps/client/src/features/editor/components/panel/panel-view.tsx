import { useEffect, useRef, useState, type CSSProperties } from "react";
import { NodeViewContent, NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Popover,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_PANEL_ATTRIBUTES,
  getPanelInlineStyle,
  getPanelTitleInlineStyle,
  normalizePanelAttributes,
  normalizePanelBorderStyle,
} from "@docmost/editor-ext";
import classes from "./panel.module.css";

const BORDER_STYLES = [
  "none",
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
].map((value) => ({ value, label: value }));

export default function PanelView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { node, updateAttributes, editor } = props;
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState(() =>
    normalizePanelAttributes(node.attrs),
  );
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(normalizePanelAttributes(node.attrs));
  }, [node.attrs]);

  useEffect(() => {
    const storage = editor.storage?.panel;
    if (storage?.autoOpen && editor.isEditable) {
      storage.autoOpen = false;
      setOpened(true);
      setTimeout(() => titleRef.current?.focus(), 0);
    }
  }, [editor]);

  const commit = (nextDraft = draft) => {
    updateAttributes(normalizePanelAttributes(nextDraft));
  };

  const updateDraft = (key: keyof typeof draft, value: unknown) => {
    const nextDraft = { ...draft, [key]: value };
    setDraft(nextDraft);
    commit(nextDraft);
  };

  const panelStyle = getPanelInlineStyle(node.attrs);
  const titleStyle = getPanelTitleInlineStyle(node.attrs);
  const title = String(node.attrs.title || "");
  const header =
    title || editor.isEditable ? (
      <div className={classes.header} style={titleStyle}>
        {title && (
          <Text className={classes.title} size="sm" fw={600}>
            {title}
          </Text>
        )}
        {editor.isEditable && (
          <ActionIcon
            className={classes.settings}
            variant="subtle"
            size="sm"
            aria-label={t("Panel settings")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setOpened((value) => !value)}
          >
            <IconSettings size={15} />
          </ActionIcon>
        )}
      </div>
    ) : null;

  return (
    <NodeViewWrapper
      className={classes.wrapper}
      style={panelStyle ? parseInlineStyle(panelStyle) : undefined}
    >
      {editor.isEditable ? (
        <Popover
          opened={opened}
          onChange={setOpened}
          position="bottom-start"
          withArrow
          shadow="md"
          trapFocus
          withinPortal
        >
          <Popover.Target>{header}</Popover.Target>

          <Popover.Dropdown>
            <Stack gap="xs" w={280}>
              <TextInput
                ref={titleRef}
                label={t("Panel title")}
                value={draft.title}
                onChange={(event) =>
                  updateDraft("title", event.currentTarget.value)
                }
              />
              <Select
                label={t("Border style")}
                data={BORDER_STYLES}
                value={normalizePanelBorderStyle(draft.borderStyle)}
                onChange={(value) =>
                  updateDraft("borderStyle", value || "solid")
                }
              />
              <Group grow align="flex-end">
                <TextInput
                  label={t("Border color")}
                  value={draft.borderColor}
                  onChange={(event) =>
                    updateDraft("borderColor", event.currentTarget.value)
                  }
                />
                <NumberInput
                  label={t("Border width")}
                  value={draft.borderWidth ?? ""}
                  min={0}
                  max={50}
                  allowDecimal={false}
                  hideControls
                  onChange={(value) => updateDraft("borderWidth", value)}
                />
              </Group>
              <TextInput
                label={t("Background color")}
                value={draft.bgColor}
                onChange={(event) =>
                  updateDraft("bgColor", event.currentTarget.value)
                }
              />
              <Group grow>
                <TextInput
                  label={t("Title background color")}
                  value={draft.titleBgColor}
                  onChange={(event) =>
                    updateDraft("titleBgColor", event.currentTarget.value)
                  }
                />
                <TextInput
                  label={t("Title text color")}
                  value={draft.titleColor}
                  onChange={(event) =>
                    updateDraft("titleColor", event.currentTarget.value)
                  }
                />
              </Group>
              <Button
                size="xs"
                variant="subtle"
                onClick={() => {
                  setDraft(DEFAULT_PANEL_ATTRIBUTES);
                  commit(DEFAULT_PANEL_ATTRIBUTES);
                }}
              >
                {t("Reset")}
              </Button>
            </Stack>
          </Popover.Dropdown>
        </Popover>
      ) : (
        header
      )}

      <NodeViewContent className={classes.content} />
    </NodeViewWrapper>
  );
}

function parseInlineStyle(style: string): CSSProperties {
  return style.split(";").reduce<CSSProperties>((result, declaration) => {
    const [property, value] = declaration.split(":");
    if (!property || !value) return result;

    if (property.trim() === "border-style") result.borderStyle = value.trim();
    if (property.trim() === "border-color") result.borderColor = value.trim();
    if (property.trim() === "border-width") result.borderWidth = value.trim();
    if (property.trim() === "background-color") {
      result.backgroundColor = value.trim();
    }
    return result;
  }, {});
}
