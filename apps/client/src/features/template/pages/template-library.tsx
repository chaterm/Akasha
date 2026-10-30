import { useMemo, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Container,
  Group,
  Menu,
  Modal,
  Select,
  SimpleGrid,
  Skeleton,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import {
  IconDots,
  IconEdit,
  IconEye,
  IconPlus,
  IconSearch,
  IconStack2,
  IconTemplate,
  IconTrash,
} from "@tabler/icons-react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { getAppName } from "@/lib/config.ts";
import {
  useRemoveTemplate,
  useTemplate,
  useTemplateList,
} from "../api/template-hooks";
import { PageTemplate } from "../api/template.types";
import { TemplateCard } from "../components/template-card";
import { TemplatePreview } from "../components/template-preview";
import { TemplateCreator } from "../components/template-creator";
import { useSpaceDirectory } from "../lib/use-space-names";
import classes from "./template-library.module.css";

const ALL = "all";
const ALL_SPACES = "allSpaces";

/** 模板管理页：只负责创建、编辑、删除；"使用模板"在空间内完成。 */
export default function TemplateLibrary() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { spaces, availabilityLabel } = useSpaceDirectory();
  const [filter, setFilter] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 250);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const listParams = useMemo(() => {
    if (filter === ALL_SPACES) return { scope: "allSpaces" as const };
    if (filter !== ALL) return { scope: "space" as const, spaceId: filter };
    return { scope: "all" as const };
  }, [filter]);

  const {
    data: templates = [],
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useTemplateList({ ...listParams, query: debouncedQuery || undefined });

  const removeTemplate = useRemoveTemplate();

  const isSpaceFilter = filter !== ALL && filter !== ALL_SPACES;
  // 只进入新建页，不落库；用户在新建页点"创建"才生成模板。
  // 正在按某个空间筛选时，新建页默认指定该空间
  const handleCreate = () =>
    navigate(
      isSpaceFilter
        ? `/templates/new?spaceId=${encodeURIComponent(filter)}`
        : "/templates/new",
    );

  const scopeLabel = availabilityLabel;

  const confirmDelete = (tpl: PageTemplate) =>
    modals.openConfirmModal({
      title: t("Delete template"),
      centered: true,
      children: (
        <Text size="sm">
          {t(
            "Delete “{{title}}”? Pages already created from it are not affected.",
            { title: tpl.title || t("Untitled") },
          )}
        </Text>
      ),
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => removeTemplate.mutate(tpl),
    });

  const open = (tpl: PageTemplate) =>
    tpl.canManage ? navigate(`/templates/${tpl.id}`) : setPreviewId(tpl.id);

  const isFiltered = filter !== ALL || !!debouncedQuery;

  // 公共模板和团队自建模板分两组展示；某组为空时不显示组标题
  const sections = [
    {
      key: "builtin",
      label: t("Built-in templates"),
      items: templates.filter((tpl) => tpl.builtin),
    },
    {
      key: "custom",
      label: t("Team templates"),
      items: templates.filter((tpl) => !tpl.builtin),
    },
  ].filter((section) => section.items.length > 0);

  const renderCard = (tpl: PageTemplate) => (
    <TemplateCard
      key={tpl.id}
      template={tpl}
      scopeLabel={scopeLabel(tpl)}
      onClick={() => open(tpl)}
      ariaLabel={
        tpl.canManage
          ? t("Edit template {{title}}", { title: tpl.title })
          : t("Preview template {{title}}", { title: tpl.title })
      }
      footer={<CardFooter template={tpl} scope={scopeLabel(tpl)} />}
      actions={
        tpl.canManage && (
          <Menu position="bottom-end" withinPortal shadow="md">
            <Menu.Target>
              <ActionIcon
                variant="default"
                size="sm"
                aria-label={t("Template actions")}
              >
                <IconDots size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconEdit size={14} />}
                onClick={() => navigate(`/templates/${tpl.id}`)}
              >
                {t("Edit")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconEye size={14} />}
                onClick={() => setPreviewId(tpl.id)}
              >
                {t("Preview")}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={14} />}
                onClick={() => confirmDelete(tpl)}
              >
                {t("Delete")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )
      }
    />
  );

  return (
    <>
      <Helmet>
        <title>
          {t("Templates")} - {getAppName()}
        </title>
      </Helmet>

      <Container size={1120} py="xl">
        <Group
          justify="space-between"
          align="flex-end"
          mb="lg"
          wrap="wrap"
          gap="md"
        >
          <div>
            <Title order={2}>{t("Templates")}</Title>
            <Text c="dimmed" size="sm" mt={4}>
              {t(
                "Create and maintain page templates. Members can pick them when creating pages in a space.",
              )}
            </Text>
          </div>
          <Button leftSection={<IconPlus size={16} />} onClick={handleCreate}>
            {t("New template")}
          </Button>
        </Group>

        <Group justify="space-between" mb="lg" gap="sm" wrap="wrap">
          <Select
            size="sm"
            w={{ base: "100%", xs: 220 }}
            aria-label={t("Filter by availability")}
            leftSection={<IconStack2 size={16} />}
            data={[
              { value: ALL, label: t("All templates") },
              { value: ALL_SPACES, label: t("Available in all spaces") },
              {
                group: t("By space"),
                items: spaces.map((s) => ({ value: s.id, label: s.name })),
              },
            ]}
            value={filter}
            onChange={(v) => setFilter(v ?? ALL)}
            allowDeselect={false}
            searchable
            nothingFoundMessage={t("No matching spaces")}
            comboboxProps={{ withinPortal: true }}
          />
          <TextInput
            size="sm"
            w={{ base: "100%", xs: 260 }}
            leftSection={<IconSearch size={16} />}
            placeholder={t("Search templates")}
            aria-label={t("Search templates")}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </Group>

        {isLoading ? (
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }} spacing="md">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} height={210} radius="md" />
            ))}
          </SimpleGrid>
        ) : templates.length === 0 ? (
          <div className={classes.empty}>
            <div className={classes.emptyIcon}>
              <IconTemplate size={28} stroke={1.5} />
            </div>
            <Text fw={600} mt="md">
              {isFiltered ? t("No matching templates") : t("No templates yet")}
            </Text>
            <Text c="dimmed" size="sm" mt={4} maw={420} ta="center">
              {isFiltered
                ? t("Try another keyword or scope.")
                : t(
                    "Turn the documents your team writes over and over — meeting notes, PRDs, retrospectives — into templates. You can also use “Save as template” from any page menu.",
                  )}
            </Text>
            {!isFiltered && (
              <Button
                mt="lg"
                variant="light"
                leftSection={<IconPlus size={16} />}
                onClick={handleCreate}
              >
                {t("Create the first template")}
              </Button>
            )}
          </div>
        ) : (
          sections.map((section) => (
            <section key={section.key} className={classes.section}>
              <Group gap={8} mb="sm">
                <Text fw={600} size="sm">
                  {section.label}
                </Text>
                <Text size="xs" c="dimmed">
                  {section.items.length}
                </Text>
              </Group>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }} spacing="md">
                {section.items.map(renderCard)}
              </SimpleGrid>
            </section>
          ))
        )}

        {hasNextPage && (
          <Group justify="center" mt="lg">
            <Button
              variant="default"
              loading={isFetchingNextPage}
              onClick={() => fetchNextPage()}
            >
              {t("Load more")}
            </Button>
          </Group>
        )}
      </Container>

      <PreviewModal
        templateId={previewId}
        onClose={() => setPreviewId(null)}
        scopeLabel={scopeLabel}
      />
    </>
  );
}

function CardFooter({
  template,
  scope,
}: {
  template: PageTemplate;
  scope: string;
}) {
  return (
    <Group gap={8} mt={10} wrap="nowrap" justify="space-between">
      <TemplateCreator template={template} />
      <Badge
        size="sm"
        variant="light"
        color={template.allSpaces ? "blue" : "gray"}
        radius="sm"
        tt="none"
        fw={500}
        maw="50%"
        style={{ flexShrink: 0 }}
      >
        {scope}
      </Badge>
    </Group>
  );
}

function PreviewModal({
  templateId,
  onClose,
  scopeLabel,
}: {
  templateId: string | null;
  onClose: () => void;
  scopeLabel: (tpl: PageTemplate) => string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: tpl } = useTemplate(templateId);

  return (
    <Modal
      opened={!!templateId}
      onClose={onClose}
      size="xl"
      title={
        tpl && (
          <Group gap="xs">
            <Text fw={600}>
              {tpl.icon ? `${tpl.icon} ` : ""}
              {tpl.title || t("Untitled")}
            </Text>
            <Badge size="xs" variant="light" radius="sm">
              {scopeLabel(tpl)}
            </Badge>
          </Group>
        )
      }
    >
      {tpl ? (
        <>
          {tpl.description && (
            <Text size="sm" c="dimmed" mb="xs">
              {tpl.description}
            </Text>
          )}
          <Group mb="md">
            <TemplateCreator template={tpl} withUpdated size="sm" />
          </Group>
          <div className={classes.previewBody}>
            <TemplatePreview content={tpl.content} />
          </div>
          {tpl.canManage && (
            <Group justify="flex-end" mt="md">
              <Button
                variant="light"
                leftSection={<IconEdit size={16} />}
                onClick={() => navigate(`/templates/${tpl.id}`)}
              >
                {t("Edit template")}
              </Button>
            </Group>
          )}
        </>
      ) : (
        <Skeleton height={240} />
      )}
    </Modal>
  );
}
