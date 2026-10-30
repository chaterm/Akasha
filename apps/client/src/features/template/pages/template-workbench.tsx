import "@/features/editor/styles/index.css";
import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  Loader,
  Menu,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { useHotkeys, useWindowEvent } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import {
  IconAlertCircle,
  IconCheck,
  IconChevronRight,
  IconDots,
  IconMoodSmile,
  IconTrash,
} from "@tabler/icons-react";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import {
  Link,
  useBlocker,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { getAppName } from "@/lib/config.ts";
import EmojiPicker from "@/components/ui/emoji-picker";
import { templateExtensions } from "@/features/editor/extensions/extensions";
import { EditorBubbleMenu } from "@/features/editor/components/bubble-menu/bubble-menu";
import { EditorLinkMenu } from "@/features/editor/components/link/link-menu";
import TableMenu from "@/features/editor/components/table/table-menu.tsx";
import CalloutMenu from "@/features/editor/components/callout/callout-menu.tsx";
import { TransclusionLookupProvider } from "@/features/editor/components/transclusion/transclusion-lookup-context";
import {
  useCreateTemplate,
  useRemoveTemplate,
  useSaveTemplate,
  useTemplate,
} from "../api/template-hooks";
import {
  PageTemplate,
  TemplateAvailability,
  TemplateDraft,
} from "../api/template.types";
import { TemplateAvailabilityPicker } from "../components/template-availability-picker";
import { TemplateCreator } from "../components/template-creator";
import { isAvailabilityEmpty } from "../lib/availability";
import { SaveState, useAutosave } from "../lib/use-autosave";
import classes from "./template-workbench.module.css";

const AUTOSAVE_DELAY = 1200;
const DIRTY_KINDS = ["meta", "body"] as const;
/** 新建模板的路由参数；此时模板还不存在，点"创建"才落库 */
const NEW_ID = "new";

export default function TemplateWorkbench() {
  const { templateId } = useParams<{ templateId: string }>();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const isNew = templateId === NEW_ID;
  const {
    data: template,
    isLoading,
    isError,
  } = useTemplate(isNew ? undefined : templateId);

  if (isNew) {
    const spaceId = searchParams.get("spaceId");
    return (
      <Workbench key={NEW_ID} isNew template={newTemplateDraft(spaceId)} />
    );
  }

  if (isLoading) {
    return (
      <Group justify="center" p="xl">
        <Loader size="sm" />
      </Group>
    );
  }
  if (isError || !template) {
    return <Notice text={t("Template not found")} />;
  }
  if (!template.canManage) {
    return (
      <Notice text={t("You don't have permission to edit this template")} />
    );
  }

  // key：切换模板时重建编辑器与本地草稿
  return <Workbench key={template.id} template={template} />;
}

/** 新建页的初始模板：默认"所有空间"，从某个空间筛选进来时默认指定该空间 */
function newTemplateDraft(spaceId: string | null): PageTemplate {
  const now = new Date().toISOString();
  return {
    id: NEW_ID,
    title: "",
    description: null,
    icon: null,
    allSpaces: !spaceId,
    spaceIds: spaceId ? [spaceId] : [],
    otherSpaceCount: 0,
    workspaceId: "",
    creatorId: null,
    lastUpdatedById: null,
    creator: null,
    canManage: true,
    createdAt: now,
    updatedAt: now,
  };
}

function Notice({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className={classes.notice}>
      <Text c="dimmed">{text}</Text>
      <Anchor component={Link} to="/templates" size="sm" mt="xs">
        {t("Back to templates")}
      </Anchor>
    </div>
  );
}

function Workbench({
  template,
  isNew = false,
}: {
  template: PageTemplate;
  /** 新建模式：不自动保存，点"创建"（或 Mod+S）才落库 */
  isNew?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const save = useSaveTemplate(template.id);
  const createTemplate = useCreateTemplate();
  const removeTemplate = useRemoveTemplate();
  // 新建模式下是否改过内容，用于离开时确认
  const draftDirty = useRef(false);
  const createInFlight = useRef(false);
  const isCreating = isNew && createTemplate.isPending;

  const navigationBlocker = useBlocker(
    () => isNew && (draftDirty.current || createInFlight.current),
  );

  useEffect(() => {
    if (navigationBlocker.state !== "blocked") return;
    // 创建请求不可取消，等待完成后再跳转，避免请求回调把用户拉回编辑页。
    if (createInFlight.current) {
      navigationBlocker.reset();
      return;
    }
    let resolved = false;
    const modalId = modals.openConfirmModal({
      title: t("Discard this template?"),
      centered: true,
      children: (
        <Text size="sm">
          {t("The template has not been created. Your changes will be lost.")}
        </Text>
      ),
      labels: { confirm: t("Discard"), cancel: t("Keep editing") },
      confirmProps: { color: "red" },
      onConfirm: () => {
        resolved = true;
        navigationBlocker.proceed();
      },
      onClose: () => {
        if (!resolved) navigationBlocker.reset();
      },
    });
    return () => {
      resolved = true;
      modals.close(modalId);
    };
  }, [navigationBlocker, t]);

  const [title, setTitle] = useState(template.title ?? "");
  const [description, setDescription] = useState(template.description ?? "");
  const [icon, setIcon] = useState<string | null>(template.icon);
  const [availability, setAvailability] = useState<TemplateAvailability>({
    allSpaces: template.allSpaces,
    spaceIds: template.spaceIds,
  });
  const latest = useRef({ title, description, icon, availability });
  latest.current = { title, description, icon, availability };
  const editorRef = useRef<Editor | null>(null);

  const blocker = !title.trim()
    ? t("Enter a name to save")
    : isAvailabilityEmpty(availability, template.otherSpaceCount)
      ? t("Select at least one space to save")
      : null;

  const { saveState, markDirty, flush, discard, hasUnsaved } = useAutosave(
    DIRTY_KINDS,
    {
      delay: AUTOSAVE_DELAY,
      buildDraft: ({ meta, body }) => {
        const current = latest.current;
        // 标题为空或没选空间时不保存，等用户填好
        if (
          meta &&
          (!current.title.trim() ||
            isAvailabilityEmpty(current.availability, template.otherSpaceCount))
        ) {
          return null;
        }
        const draft: TemplateDraft = {};
        if (meta) {
          draft.title = current.title.trim();
          draft.description = current.description.trim() || null;
          draft.icon = current.icon;
          draft.allSpaces = current.availability.allSpaces;
          draft.spaceIds = current.availability.spaceIds;
        }
        if (body && editorRef.current)
          draft.content = editorRef.current.getJSON();
        return draft;
      },
      save: (draft) => save.mutateAsync(draft),
    },
  );

  /** 记录改动：已有模板走自动保存，新建模板只标记为未保存 */
  const touch = (kind: (typeof DIRTY_KINDS)[number]) => {
    if (isNew) draftDirty.current = true;
    else markDirty(kind);
  };

  const create = async () => {
    if (
      blocker ||
      createInFlight.current ||
      navigationBlocker.state === "blocked"
    )
      return;
    createInFlight.current = true;
    editorRef.current?.setEditable(false, false);
    const current = latest.current;
    try {
      const tpl = await createTemplate.mutateAsync({
        title: current.title.trim(),
        description: current.description.trim() || undefined,
        icon: current.icon ?? undefined,
        allSpaces: current.availability.allSpaces,
        spaceIds: current.availability.spaceIds,
        content: editorRef.current?.getJSON(),
      });
      draftDirty.current = false;
      createInFlight.current = false;
      // 替换掉 /templates/new，返回时不会回到空白新建页
      navigate(`/templates/${tpl.id}`, { replace: true });
    } finally {
      createInFlight.current = false;
      if (!editorRef.current?.isDestroyed) {
        editorRef.current?.setEditable(true, false);
      }
    }
  };

  const leave = () => navigate("/templates");

  const editor = useEditor({
    extensions: templateExtensions,
    content: template.content ?? "",
    immediatelyRender: true,
    editable: !isCreating,
    editorProps: {
      attributes: { "aria-label": t("Template content") },
    },
    onUpdate: () => touch("body"),
  });
  editorRef.current = editor;

  // 快捷键只注册一次，通过 ref 调到最新的 create（闭包里有当前标题等状态）
  const createRef = useRef(create);
  createRef.current = create;
  useHotkeys(
    [
      [
        "mod+s",
        () =>
          void (isNew ? createRef.current().catch(() => undefined) : flush()),
      ],
    ],
    [],
    true,
  );

  useWindowEvent("beforeunload", (e) => {
    if (isNew ? draftDirty.current : hasUnsaved()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  const confirmDelete = () =>
    modals.openConfirmModal({
      title: t("Delete template"),
      centered: true,
      children: (
        <Text size="sm">
          {t(
            "Delete “{{title}}”? Pages already created from it are not affected.",
            { title: title || t("Untitled") },
          )}
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => {
        discard();
        removeTemplate.mutate(template, {
          onSuccess: () => navigate("/templates"),
        });
      },
    });

  return (
    <>
      <Helmet>
        <title>
          {title || t("Untitled template")} - {getAppName()}
        </title>
      </Helmet>

      <header className={classes.toolbar}>
        <nav className={classes.crumbs} aria-label={t("Breadcrumb")}>
          <Anchor component={Link} to="/templates" size="sm" c="dimmed">
            {t("Templates")}
          </Anchor>
          <IconChevronRight
            size={14}
            className={classes.crumbSep}
            aria-hidden
          />
          <Text size="sm" truncate className={classes.crumbCurrent}>
            {icon ? `${icon} ` : ""}
            {title || t("Untitled template")}
          </Text>
        </nav>

        {isNew ? (
          <Group gap="xs" wrap="nowrap">
            <Button
              variant="default"
              size="xs"
              onClick={leave}
              disabled={isCreating}
            >
              {t("Cancel")}
            </Button>
            <Tooltip label={blocker} disabled={!blocker} withArrow>
              <Button
                size="xs"
                disabled={!!blocker}
                loading={createTemplate.isPending}
                onClick={() => create().catch(() => undefined)}
              >
                {t("Create template")}
              </Button>
            </Tooltip>
          </Group>
        ) : (
          <Group gap="sm" wrap="nowrap">
            <SaveIndicator state={saveState} blocker={blocker} />
            <Menu position="bottom-end" shadow="md" withinPortal>
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={t("More actions")}
                >
                  <IconDots size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={confirmDelete}
                >
                  {t("Delete template")}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        )}
      </header>

      <div className={classes.canvas}>
        <div className={classes.metaBlock}>
          <div className={classes.iconRow}>
            <EmojiPicker
              onEmojiSelect={(emoji) => {
                if (createInFlight.current) return;
                setIcon(emoji.native);
                touch("meta");
              }}
              removeEmojiAction={() => {
                if (createInFlight.current) return;
                setIcon(null);
                touch("meta");
              }}
              readOnly={isCreating}
              icon={
                icon ? (
                  <span className={classes.iconGlyph}>{icon}</span>
                ) : (
                  <Group gap={4} wrap="nowrap" className={classes.addIcon}>
                    <IconMoodSmile size={16} />
                    <span>{t("Add icon")}</span>
                  </Group>
                )
              }
              actionIconProps={{
                size: icon ? "xl" : "auto",
                variant: "subtle",
                c: "gray",
              }}
            />
          </div>
          <input
            className={classes.titleInput}
            value={title}
            disabled={isCreating}
            maxLength={200}
            placeholder={t("Untitled template")}
            aria-label={t("Template name")}
            aria-invalid={!title.trim() || undefined}
            onChange={(e) => {
              setTitle(e.currentTarget.value);
              touch("meta");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                editor?.commands.focus("start");
              }
            }}
          />
          <Textarea
            variant="unstyled"
            autosize
            minRows={1}
            maxLength={1000}
            placeholder={t(
              "Add a short description so others know when to use it",
            )}
            aria-label={t("Description")}
            value={description}
            disabled={isCreating}
            onChange={(e) => {
              setDescription(e.currentTarget.value);
              touch("meta");
            }}
            classNames={{ input: classes.descriptionInput }}
          />
          <div className={classes.metaRow}>
            {!isNew && (
              <>
                <TemplateCreator template={template} size="sm" />
                <span className={classes.metaDot} aria-hidden>
                  ·
                </span>
              </>
            )}
            <Text size="sm" c="dimmed">
              {t("Available in")}
            </Text>
            <TemplateAvailabilityPicker
              disabled={isCreating}
              size="xs"
              value={availability}
              otherSpaceCount={template.otherSpaceCount}
              onChange={(next) => {
                if (createInFlight.current) return;
                setAvailability(next);
                touch("meta");
              }}
            />
          </div>
          <div className={classes.hint}>
            {isNew
              ? t(
                  "Type / to insert blocks. Click “Create template” when you are done.",
                )
              : t("Type / to insert blocks. Changes are saved automatically.")}
          </div>
        </div>

        <TransclusionLookupProvider>
          <div className="editor-container" style={{ position: "relative" }}>
            <EditorContent editor={editor} />
            {editor && !isCreating && (
              <>
                <EditorBubbleMenu editor={editor} templateMode />
                <EditorLinkMenu editor={editor} />
                <TableMenu editor={editor} />
                <CalloutMenu editor={editor} />
              </>
            )}
          </div>
        </TransclusionLookupProvider>
        <div style={{ paddingBottom: "20vh" }} />
      </div>
    </>
  );
}

function SaveIndicator({
  state,
  blocker,
}: {
  state: SaveState;
  /** 阻止保存的原因（如缺标题） */
  blocker: string | null;
}) {
  const { t } = useTranslation();
  let content: React.ReactNode = null;

  if (blocker) {
    content = (
      <Text size="xs" c="orange" className={classes.status}>
        {blocker}
      </Text>
    );
  } else if (state === "saving" || state === "pending") {
    content = (
      <Group gap={4} className={classes.status} wrap="nowrap">
        <Loader size={10} color="gray" />
        <Text size="xs" c="dimmed">
          {t("Saving…")}
        </Text>
      </Group>
    );
  } else if (state === "saved") {
    content = (
      <Group gap={4} className={classes.status} wrap="nowrap">
        <IconCheck size={12} color="var(--mantine-color-green-filled)" />
        <Text size="xs" c="dimmed">
          {t("Saved")}
        </Text>
      </Group>
    );
  } else if (state === "error") {
    content = (
      <Tooltip label={t("Press Mod+S to retry")} withArrow>
        <Group gap={4} className={classes.status} wrap="nowrap">
          <IconAlertCircle size={12} color="var(--mantine-color-red-filled)" />
          <Text size="xs" c="red">
            {t("Save failed")}
          </Text>
        </Group>
      </Tooltip>
    );
  }

  return (
    <div aria-live="polite" className={classes.statusSlot}>
      {content}
    </div>
  );
}
