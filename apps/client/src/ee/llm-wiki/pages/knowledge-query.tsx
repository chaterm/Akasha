import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  MultiSelect,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconDatabaseSearch,
  IconGitFork,
  IconInfoCircle,
  IconListDetails,
  IconRefresh,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { getAppName } from "@/lib/config";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import {
  compileKnowledgeSpaces,
  queryKnowledge,
} from "../services/knowledge-service";
import type { KnowledgeQueryResult } from "../types/knowledge.types";
import classes from "../styles/knowledge-query.module.css";

export default function KnowledgeQueryPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [result, setResult] = useState<KnowledgeQueryResult | null>(null);
  const { data: spacesData, isLoading: spacesLoading } = useGetSpacesQuery({
    limit: 100,
  });
  const spaces = spacesData?.items ?? [];
  const spaceOptions = useMemo(
    () => spaces.map((space) => ({ value: space.id, label: space.name })),
    [spaces],
  );

  useEffect(() => {
    if (spaceIds.length === 0 && spaceOptions.length > 0) {
      setSpaceIds(spaceOptions.map((space) => space.value));
    }
  }, [spaceIds.length, spaceOptions]);

  const mutation = useMutation({
    mutationFn: queryKnowledge,
    onSuccess: (data) => setResult(data),
  });
  const compileMutation = useMutation({
    mutationFn: compileKnowledgeSpaces,
    onSuccess: (data) => {
      notifications.show({
        message: t("Knowledge update queued", {
          count: data.queuedSpaceCount,
        }),
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        message: error.message,
      });
    },
  });
  const citations = result?.citations ?? [];
  const snippets = result?.snippets ?? [];
  const warnings = result?.warnings ?? [];

  const canSubmit = query.trim().length > 0 && spaceIds.length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || mutation.isPending) return;
    mutation.mutate({ query: query.trim(), spaceIds });
  };

  return (
    <>
      <Helmet>
        <title>
          {t("Knowledge")} - {getAppName()}
        </title>
      </Helmet>

      <Container size="900" pt="xl" pb="xl">
        <Stack gap="lg">
          <Group justify="space-between" align="center">
            <Group gap="sm">
              <IconDatabaseSearch size={24} stroke={1.8} />
              <Title order={1} size="h3">
                {t("Knowledge")}
              </Title>
            </Group>
            <Group gap="sm">
              {spacesLoading && <Loader size="sm" />}
              <Button
                component={Link}
                to="/knowledge/graph"
                variant="default"
                leftSection={<IconGitFork size={16} />}
              >
                {t("Relationship graph")}
              </Button>
              <Button
                component={Link}
                to="/knowledge/admin"
                variant="default"
                leftSection={<IconListDetails size={16} />}
              >
                {t("Diagnostics")}
              </Button>
              <Button
                variant="default"
                leftSection={<IconRefresh size={16} />}
                loading={compileMutation.isPending}
                disabled={spaceIds.length === 0}
                onClick={() => compileMutation.mutate({ spaceIds })}
              >
                {t("Update knowledge")}
              </Button>
            </Group>
          </Group>

          <form className={classes.queryPanel} onSubmit={submit}>
            <Stack gap="md">
              <MultiSelect
                data={spaceOptions}
                value={spaceIds}
                onChange={setSpaceIds}
                label={t("Spaces")}
                searchable
                clearable
                disabled={spacesLoading}
              />
              <Textarea
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                minRows={4}
                maxRows={8}
                autosize
                label={t("Question")}
              />
              <Group justify="flex-end">
                <Button
                  type="submit"
                  rightSection={<IconArrowRight size={16} />}
                  loading={mutation.isPending}
                  disabled={!canSubmit}
                >
                  {t("Ask")}
                </Button>
              </Group>
            </Stack>
          </form>

          {mutation.isError && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              {mutation.error.message}
            </Alert>
          )}

          {result && (
            <Stack gap="md">
              <section className={classes.answerSection}>
                <Text className={classes.sectionLabel}>{t("Answer")}</Text>
                <Text className={classes.answerText} component="div">
                  {result.answer || t("No answer returned.")}
                </Text>
              </section>

              {result.completenessNotice && (
                <Alert color="gray" icon={<IconInfoCircle size={18} />}>
                  {result.completenessNotice}
                </Alert>
              )}

              {warnings.map((warning) => (
                <Alert
                  key={warning}
                  color="yellow"
                  icon={<IconAlertTriangle size={18} />}
                >
                  {warning}
                </Alert>
              ))}

              <section className={classes.snippetSection}>
                <Group justify="space-between" mb="xs">
                  <Text className={classes.sectionLabel}>{t("Snippets")}</Text>
                  <Badge variant="light">{snippets.length}</Badge>
                </Group>
                {snippets.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t("No snippets")}
                  </Text>
                ) : (
                  <Stack gap="md">
                    {snippets.map((snippet) => (
                      <div key={snippet.id} className={classes.snippetItem}>
                        <Group
                          justify="space-between"
                          align="flex-start"
                          gap="sm"
                        >
                          <Text className={classes.snippetTitle}>
                            {snippet.title}
                          </Text>
                          {snippet.retrievalReasons.length > 0 && (
                            <Group gap={4} justify="flex-end">
                              {snippet.retrievalReasons.map((reason) => (
                                <Badge
                                  key={reason}
                                  size="sm"
                                  variant="light"
                                  color={reasonColor(reason)}
                                >
                                  {reasonLabel(reason)}
                                </Badge>
                              ))}
                            </Group>
                          )}
                        </Group>
                        <Text className={classes.snippetText} component="div">
                          {snippet.text}
                        </Text>
                        {snippet.sourceWindows.length > 0 && (
                          <Stack gap="xs" className={classes.sourceWindowList}>
                            {snippet.sourceWindows.map((sourceWindow) => (
                              <div
                                key={`${sourceWindow.sourcePageId}-${sourceWindow.sourceRange.startOffset}`}
                              >
                                <Anchor
                                  href={sourceWindow.url}
                                  className={classes.citationLink}
                                >
                                  {sourceWindow.title}
                                </Anchor>
                                <Text
                                  className={classes.sourceWindowText}
                                  component="div"
                                >
                                  {sourceWindow.text}
                                </Text>
                              </div>
                            ))}
                          </Stack>
                        )}
                      </div>
                    ))}
                  </Stack>
                )}
              </section>

              <section className={classes.citationSection}>
                <Group justify="space-between" mb="xs">
                  <Text className={classes.sectionLabel}>{t("Citations")}</Text>
                  <Badge variant="light">{citations.length}</Badge>
                </Group>
                {citations.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t("No citations")}
                  </Text>
                ) : (
                  <Stack gap="xs">
                    {citations.map((citation) => (
                      <Anchor
                        key={citation.sourcePageId}
                        href={citation.url}
                        className={classes.citationLink}
                      >
                        {citation.title}
                      </Anchor>
                    ))}
                  </Stack>
                )}
              </section>
            </Stack>
          )}
        </Stack>
      </Container>
    </>
  );
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case "semantic":
      return "Semantic";
    case "lexical":
      return "Keyword";
    case "exact-title":
      return "Title";
    case "sidecar-prefiltered":
      return "Authorized";
    default:
      return reason;
  }
}

function reasonColor(reason: string): string {
  switch (reason) {
    case "semantic":
      return "blue";
    case "lexical":
      return "green";
    case "exact-title":
      return "violet";
    case "sidecar-prefiltered":
      return "gray";
    default:
      return "dark";
  }
}
