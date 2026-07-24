import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  Loader,
  MultiSelect,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconDatabaseSearch,
  IconInfoCircle,
  IconRefresh,
} from "@tabler/icons-react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getAppName } from "@/lib/config";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import {
  compileKnowledgeSpaces,
  getKnowledgeDiagnostics,
  retryKnowledgePages,
  runKnowledgeAdminAction,
} from "../services/knowledge-service";
import classes from "../styles/knowledge-admin.module.css";
import type {
  KnowledgeAdminSpaceAction,
  KnowledgeCompileStatus,
  KnowledgePageCompileStage,
  KnowledgePageCompileStatus,
} from "../types/knowledge.types";

const DIAGNOSTICS_LIMIT = 50;
const COMPILE_STATUS_OPTIONS: Array<{
  value: KnowledgePageCompileStatus;
  label: string;
}> = [
  { value: "failed", label: "failed" },
  { value: "running", label: "running" },
  { value: "queued", label: "queued" },
  { value: "succeeded", label: "succeeded" },
  { value: "not_started", label: "not started" },
];
const COMPILE_STAGE_OPTIONS: Array<{
  value: KnowledgePageCompileStage;
  label: string;
}> = [
  "queued",
  "read_source",
  "analysis",
  "generation",
  "merge",
  "validation",
  "import",
  "completed",
].map((value) => ({ value: value as KnowledgePageCompileStage, label: value }));

export default function KnowledgeAdminPage() {
  const { t } = useTranslation();
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [compileStatus, setCompileStatus] =
    useState<KnowledgePageCompileStatus | null>(null);
  const [compileStage, setCompileStage] =
    useState<KnowledgePageCompileStage | null>(null);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const spaceIdsInitialized = useRef(false);
  const { data: spacesData, isLoading: spacesLoading } = useGetSpacesQuery({
    limit: 100,
  });
  const spaces = spacesData?.items ?? [];
  const spaceOptions = useMemo(
    () => spaces.map((space) => ({ value: space.id, label: space.name })),
    [spaces],
  );

  useEffect(() => {
    if (!spaceIdsInitialized.current && spaceOptions.length > 0) {
      spaceIdsInitialized.current = true;
      setSpaceIds([spaceOptions[0].value]);
    }
  }, [spaceOptions]);

  const diagnosticsQuery = useQuery({
    queryKey: ["knowledge-diagnostics", spaceIds, compileStatus, compileStage],
    queryFn: () =>
      getKnowledgeDiagnostics({
        spaceIds,
        ...(compileStatus ? { statuses: [compileStatus] } : {}),
        ...(compileStage ? { stages: [compileStage] } : {}),
        limit: DIAGNOSTICS_LIMIT,
      }),
    enabled: spaceIds.length > 0,
    refetchInterval: 5000,
  });

  const compileMutation = useMutation({
    mutationFn: compileKnowledgeSpaces,
    onSuccess: (data) => {
      notifications.show({
        message: t("Knowledge update queued", {
          count: data.queuedSpaceCount,
        }),
      });
      void diagnosticsQuery.refetch();
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        message: error.message,
      });
    },
  });

  const actionMutation = useMutation({
    mutationFn: runKnowledgeAdminAction,
    onSuccess: (data) => {
      notifications.show({
        message: t("Knowledge action queued", {
          action: data.action,
          count: data.queuedSpaceCount,
        }),
      });
      void diagnosticsQuery.refetch();
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        message: error.message,
      });
    },
  });

  const retryPagesMutation = useMutation({
    mutationFn: retryKnowledgePages,
    onSuccess: (data) => {
      setSelectedPageIds([]);
      notifications.show({
        message: t("Knowledge page retries queued", {
          count: data.queuedPageCount,
        }),
      });
      void diagnosticsQuery.refetch();
    },
    onError: (error) => {
      notifications.show({ color: "red", message: error.message });
    },
  });

  const pages = diagnosticsQuery.data?.pages ?? [];
  const jobs = diagnosticsQuery.data?.jobs ?? [];
  const quarantines = diagnosticsQuery.data?.quarantines ?? [];
  const retrieval = diagnosticsQuery.data?.retrieval;
  const compileStatusBySpaceId = useMemo(
    () =>
      new Map(
        (diagnosticsQuery.data?.compileStatuses ?? []).map((status) => [
          status.spaceId,
          status,
        ]),
      ),
    [diagnosticsQuery.data?.compileStatuses],
  );
  const quality = diagnosticsQuery.data?.quality;
  const runSpaceAction = (
    action: KnowledgeAdminSpaceAction,
    targetSpaceId: string,
  ) => {
    actionMutation.mutate({ action, spaceIds: [targetSpaceId] });
  };

  return (
    <>
      <Helmet>
        <title>
          {t("Knowledge diagnostics")} - {getAppName()}
        </title>
      </Helmet>

      <Container size="xl" pt="xl" pb="xl">
        <Stack gap="lg">
          <Group justify="space-between" align="center">
            <Group gap="sm">
              <IconDatabaseSearch size={24} stroke={1.8} />
              <Title order={1} size="h3">
                {t("Knowledge diagnostics")}
              </Title>
            </Group>
            <Group gap="sm">
              <Button
                component={Link}
                to="/ai"
                variant="default"
                leftSection={<IconArrowLeft size={16} />}
              >
                {t("Back")}
              </Button>
              <Button
                variant="default"
                leftSection={<IconRefresh size={16} />}
                loading={diagnosticsQuery.isFetching}
                disabled={spaceIds.length === 0}
                onClick={() => void diagnosticsQuery.refetch()}
              >
                {t("Refresh")}
              </Button>
              <Button
                leftSection={<IconRefresh size={16} />}
                loading={compileMutation.isPending}
                disabled={spaceIds.length === 0}
                onClick={() => compileMutation.mutate({ spaceIds })}
              >
                {t("Update knowledge")}
              </Button>
            </Group>
          </Group>

          <section className={classes.panel}>
            <Group align="end" grow>
              <MultiSelect
                data={spaceOptions}
                value={spaceIds}
                onChange={setSpaceIds}
                label={t("Spaces")}
                searchable
                clearable
                disabled={spacesLoading}
              />
              <Select
                data={COMPILE_STATUS_OPTIONS}
                value={compileStatus}
                onChange={(value) =>
                  setCompileStatus(value as KnowledgePageCompileStatus | null)
                }
                label={t("Compile status")}
                clearable
              />
              <Select
                data={COMPILE_STAGE_OPTIONS}
                value={compileStage}
                onChange={(value) =>
                  setCompileStage(value as KnowledgePageCompileStage | null)
                }
                label={t("Compile stage")}
                clearable
              />
            </Group>
          </section>

          {diagnosticsQuery.isError && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              {diagnosticsQuery.error.message}
            </Alert>
          )}

          {quality && (
            <section className={classes.panel}>
              <Group justify="space-between" mb="md">
                <Title order={2} size="h4">
                  {t("Health")}
                </Title>
                <Badge
                  color={healthColor(quality.summary.healthScore)}
                  variant="light"
                  size="lg"
                >
                  {quality.summary.healthScore}
                </Badge>
              </Group>

              {retrieval && (
                <Group gap="xs" mb="md">
                  <Badge variant="light">
                    {t("Zero-hit")}: {formatPercent(retrieval.zeroHitRate)}
                  </Badge>
                  <Badge variant="light">
                    {t("Embedding fallback")}:{" "}
                    {formatPercent(retrieval.embeddingFallbackRate)}
                  </Badge>
                  <Badge variant="light">
                    {t("ACL fallback")}:{" "}
                    {formatPercent(retrieval.accessPolicyFallbackRate)}
                  </Badge>
                  <Badge variant="outline">
                    {t("Queries")}: {retrieval.sampleCount}
                  </Badge>
                  <Badge variant="outline">
                    {t("Authorized avg")}:{" "}
                    {formatNumber(retrieval.averageAuthorizedCandidateCount)}
                  </Badge>
                  <Badge variant="outline">
                    {t("Filtered avg")}:{" "}
                    {formatNumber(retrieval.averageFilteredCandidateCount)}
                  </Badge>
                </Group>
              )}

              <div className={classes.metricGrid}>
                <Metric label={t("Pages")} value={quality.summary.pageCount} />
                <Metric
                  label={t("Compiled")}
                  value={quality.summary.compiledPageCount}
                />
                <Metric
                  label={t("Stale")}
                  value={quality.summary.stalePageCount}
                />
                <Metric
                  label={t("Missing source")}
                  value={quality.summary.missingSourcePageCount}
                />
                <Metric
                  label={t("Missing chunks")}
                  value={quality.summary.missingChunkPageCount}
                />
                <Metric
                  label={t("Missing embeddings")}
                  value={quality.summary.missingEmbeddingPageCount}
                />
              </div>

              {quality.topIssues.length > 0 && (
                <Stack gap="xs" mt="md">
                  {quality.topIssues.map((issue) => (
                    <Group key={issue.code} justify="space-between" gap="md">
                      <Group gap="xs">
                        <Badge
                          color={issueColor(issue.severity)}
                          variant="light"
                        >
                          {issue.severity}
                        </Badge>
                        <Text size="sm">{issue.message}</Text>
                      </Group>
                      <Badge variant="outline">{issue.affectedPageCount}</Badge>
                    </Group>
                  ))}
                </Stack>
              )}

              <Table.ScrollContainer minWidth={1180}>
                <Table mt="md" highlightOnHover verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t("Space")}</Table.Th>
                      <Table.Th>{t("Health")}</Table.Th>
                      <Table.Th>{t("Compile")}</Table.Th>
                      <Table.Th>{t("Pages")}</Table.Th>
                      <Table.Th>{t("Compiled")}</Table.Th>
                      <Table.Th>
                        <HeaderWithTooltip
                          label={t("Stale")}
                          ariaLabel={t("Stale column help")}
                          tooltip={t(
                            "Shows the number of pages with stale knowledge. The time badge is the age of the oldest stale source.",
                          )}
                        />
                      </Table.Th>
                      <Table.Th>{t("Missing chunks")}</Table.Th>
                      <Table.Th>{t("Missing embeddings")}</Table.Th>
                      <Table.Th>{t("Artifacts")}</Table.Th>
                      <Table.Th>{t("Actions")}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {quality.spaces.map((space) => {
                      const compileStatus = compileStatusBySpaceId.get(
                        space.spaceId,
                      );

                      return (
                        <Table.Tr key={space.spaceId}>
                          <Table.Td>{space.spaceName}</Table.Td>
                          <Table.Td>
                            <Badge
                              color={healthColor(space.healthScore)}
                              variant="light"
                            >
                              {space.healthScore}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <CompileStatusCell status={compileStatus} />
                          </Table.Td>
                          <Table.Td>{space.pageCount}</Table.Td>
                          <Table.Td>{space.compiledPageCount}</Table.Td>
                          <Table.Td>
                            <Group gap="xs">
                              <Text size="sm">{space.stalePageCount}</Text>
                              {space.oldestStaleSourceAgeHours !== null && (
                                <Badge color="yellow" variant="light">
                                  {formatAgeHours(
                                    space.oldestStaleSourceAgeHours,
                                  )}
                                </Badge>
                              )}
                            </Group>
                          </Table.Td>
                          <Table.Td>{space.missingChunkPageCount}</Table.Td>
                          <Table.Td>{space.missingEmbeddingPageCount}</Table.Td>
                          <Table.Td>
                            <Stack gap={4}>
                              <Text size="sm">
                                {t("Sources")}:{" "}
                                {compileStatus?.sourceCount ?? 0}
                              </Text>
                              <Text size="sm">
                                {t("Imported")}:{" "}
                                {compileStatus?.importedArtifactCount ?? 0}
                              </Text>
                              <Text size="sm">
                                {t("Quarantined")}:{" "}
                                {compileStatus?.quarantinedArtifactCount ?? 0}
                              </Text>
                            </Stack>
                          </Table.Td>
                          <Table.Td>
                            <Group gap="xs">
                              <Button
                                size="xs"
                                variant="default"
                                leftSection={<IconRefresh size={14} />}
                                loading={actionMutation.isPending}
                                onClick={() =>
                                  runSpaceAction("retry_compile", space.spaceId)
                                }
                              >
                                {t("Retry compile")}
                              </Button>
                              <Button
                                size="xs"
                                variant="default"
                                leftSection={<IconDatabaseSearch size={14} />}
                                loading={actionMutation.isPending}
                                onClick={() =>
                                  runSpaceAction(
                                    "reindex_access",
                                    space.spaceId,
                                  )
                                }
                              >
                                {t("Reindex access")}
                              </Button>
                              <Button
                                size="xs"
                                variant="default"
                                leftSection={<IconAlertTriangle size={14} />}
                                loading={actionMutation.isPending}
                                onClick={() =>
                                  runSpaceAction("mark_stale", space.spaceId)
                                }
                              >
                                {t("Mark stale")}
                              </Button>
                              <Button
                                size="xs"
                                variant="default"
                                leftSection={<IconRefresh size={14} />}
                                loading={actionMutation.isPending}
                                onClick={() =>
                                  runSpaceAction(
                                    "rebuild_embeddings",
                                    space.spaceId,
                                  )
                                }
                              >
                                {t("Rebuild embeddings")}
                              </Button>
                            </Group>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </section>
          )}

          <section className={classes.panel}>
            <Group justify="space-between" mb="md">
              <Title order={2} size="h4">
                {t("Quarantine")}
              </Title>
              <Badge variant="light">{quarantines.length}</Badge>
            </Group>

            <Table.ScrollContainer minWidth={900}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("Artifact")}</Table.Th>
                    <Table.Th>{t("Kind")}</Table.Th>
                    <Table.Th>{t("Reason")}</Table.Th>
                    <Table.Th>{t("Run")}</Table.Th>
                    <Table.Th>{t("Created")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {quarantines.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={5}>
                        <Text className={classes.emptyText}>
                          {t("No quarantined artifacts")}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    quarantines.map((item) => (
                      <Table.Tr key={item.id}>
                        <Table.Td>
                          <Text className={classes.mono}>
                            {item.artifactId ?? "-"}
                          </Text>
                        </Table.Td>
                        <Table.Td>{item.artifactKind ?? "-"}</Table.Td>
                        <Table.Td>
                          <Text size="sm">
                            {item.reasonCodes.join(", ") || "-"}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Stack gap={4}>
                            <Text className={classes.mono}>
                              {item.compilerRunId ?? "-"}
                            </Text>
                            <Text className={classes.mono} c="dimmed">
                              {item.compileTaskId ?? "-"}
                            </Text>
                          </Stack>
                        </Table.Td>
                        <Table.Td>{formatDate(item.createdAt)}</Table.Td>
                      </Table.Tr>
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </section>

          <section className={classes.panel}>
            <Group justify="space-between" mb="md">
              <Title order={2} size="h4">
                {t("Recent pages")}
              </Title>
              <Group gap="sm">
                {diagnosticsQuery.isLoading && <Loader size="sm" />}
                <Button
                  size="xs"
                  variant="light"
                  disabled={selectedPageIds.length === 0}
                  loading={retryPagesMutation.isPending}
                  onClick={() =>
                    retryPagesMutation.mutate({ pageIds: selectedPageIds })
                  }
                >
                  {t("Retry selected")}
                </Button>
              </Group>
            </Group>

            <Table.ScrollContainer minWidth={1180}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("Select")}</Table.Th>
                    <Table.Th>{t("Page")}</Table.Th>
                    <Table.Th>{t("Space")}</Table.Th>
                    <Table.Th>{t("Updated")}</Table.Th>
                    <Table.Th>{t("Text")}</Table.Th>
                    <Table.Th>{t("Source")}</Table.Th>
                    <Table.Th>{t("Capsule")}</Table.Th>
                    <Table.Th>{t("Chunk")}</Table.Th>
                    <Table.Th>{t("Embedding")}</Table.Th>
                    <Table.Th>{t("Compiled")}</Table.Th>
                    <Table.Th>{t("Access")}</Table.Th>
                    <Table.Th>{t("State")}</Table.Th>
                    <Table.Th>{t("Actions")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {pages.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={13}>
                        <Text className={classes.emptyText}>
                          {t("No pages")}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    pages.map((page) => (
                      <Table.Tr key={page.pageId}>
                        <Table.Td>
                          <Checkbox
                            aria-label={`Select ${page.title || page.slugId}`}
                            checked={selectedPageIds.includes(page.pageId)}
                            onChange={(event) =>
                              setSelectedPageIds((current) =>
                                event.currentTarget.checked
                                  ? [...new Set([...current, page.pageId])]
                                  : current.filter((id) => id !== page.pageId),
                              )
                            }
                          />
                        </Table.Td>
                        <Table.Td>
                          <Anchor
                            component={Link}
                            to={`/s/${page.spaceSlug}/p/${page.slugId}`}
                            className={classes.pageLink}
                          >
                            {page.title || page.slugId}
                          </Anchor>
                          <Text className={classes.mono} c="dimmed">
                            {page.pageId}
                          </Text>
                        </Table.Td>
                        <Table.Td>{page.spaceName}</Table.Td>
                        <Table.Td>{formatDate(page.updatedAt)}</Table.Td>
                        <Table.Td>{page.textLength}</Table.Td>
                        <Table.Td>
                          <CountBadge value={page.knowledgeSourceCount} />
                        </Table.Td>
                        <Table.Td>
                          <CountBadge value={page.knowledgePageSourceCount} />
                        </Table.Td>
                        <Table.Td>
                          <CountBadge value={page.knowledgeChunkCount} />
                        </Table.Td>
                        <Table.Td>
                          <CountBadge
                            value={page.missingEmbeddingChunkCount}
                            inverted
                          />
                        </Table.Td>
                        <Table.Td>{formatDate(page.lastCompiledAt)}</Table.Td>
                        <Table.Td>
                          <Stack gap={4}>
                            <Text size="sm">
                              {formatDate(page.lastAccessPolicyIndexedAt)}
                            </Text>
                            {page.staleAccessPolicyCount > 0 && (
                              <Badge color="yellow" variant="light">
                                {t("Stale")}
                              </Badge>
                            )}
                          </Stack>
                        </Table.Td>
                        <Table.Td>
                          <Stack gap={4}>
                            <Group gap="xs">
                              <Badge
                                color={compileStatusColor(page.compileStatus)}
                                variant="light"
                              >
                                {page.compileStatus}
                              </Badge>
                              {page.compileStage && (
                                <Badge variant="outline">
                                  {page.compileStage}
                                </Badge>
                              )}
                              {page.servingLastSuccessfulVersion && (
                                <Badge color="blue" variant="light">
                                  {t("Last successful version")}
                                </Badge>
                              )}
                            </Group>
                            {page.compileErrorMessage && (
                              <Text size="xs" c="red">
                                {page.compileErrorMessage}
                              </Text>
                            )}
                            <Group gap="xs">
                              {page.deletedAt ? (
                                <Badge color="red" variant="light">
                                  {t("Deleted")}
                                </Badge>
                              ) : page.knowledgeChunkCount > 0 ? (
                                <Badge color="green" variant="light">
                                  {t("Compiled")}
                                </Badge>
                              ) : (
                                <Badge color="gray" variant="light">
                                  {t("Missing")}
                                </Badge>
                              )}
                              {page.staleSourceCount > 0 && (
                                <Badge color="yellow" variant="light">
                                  {t("Stale")}
                                </Badge>
                              )}
                              {page.missingEmbeddingChunkCount > 0 && (
                                <Badge color="orange" variant="light">
                                  {t("Embedding")}
                                </Badge>
                              )}
                            </Group>
                          </Stack>
                        </Table.Td>
                        <Table.Td>
                          {page.compileStatus === "failed" && (
                            <Button
                              size="compact-xs"
                              variant="light"
                              aria-label={`Retry ${page.title || page.slugId}`}
                              loading={retryPagesMutation.isPending}
                              onClick={() =>
                                retryPagesMutation.mutate({
                                  pageIds: [page.pageId],
                                })
                              }
                            >
                              {t("Retry")}
                            </Button>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </section>

          <section className={classes.panel}>
            <Group justify="space-between" mb="md">
              <Title order={2} size="h4">
                {t("AI queue")}
              </Title>
              <Badge variant="light">{jobs.length}</Badge>
            </Group>

            <Table.ScrollContainer minWidth={900}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("Job")}</Table.Th>
                    <Table.Th>{t("State")}</Table.Th>
                    <Table.Th>{t("Space")}</Table.Th>
                    <Table.Th>{t("Pages")}</Table.Th>
                    <Table.Th>{t("Updated")}</Table.Th>
                    <Table.Th>{t("Error")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {jobs.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={6}>
                        <Text className={classes.emptyText}>
                          {t("No matching jobs")}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    jobs.map((job) => (
                      <Table.Tr key={`${job.name}:${job.id}`}>
                        <Table.Td>
                          <Text fw={600}>{job.name}</Text>
                          <Text className={classes.mono} c="dimmed">
                            {job.id}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            color={jobStateColor(job.state)}
                            variant="light"
                          >
                            {job.state}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text className={classes.mono}>
                            {job.spaceId || "-"}
                          </Text>
                        </Table.Td>
                        <Table.Td>{job.pageIds.length}</Table.Td>
                        <Table.Td>
                          {formatTimestamp(
                            job.finishedOn ?? job.processedOn ?? job.timestamp,
                          )}
                        </Table.Td>
                        <Table.Td>{job.failedReason || "-"}</Table.Td>
                      </Table.Tr>
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </section>
        </Stack>
      </Container>
    </>
  );
}

function HeaderWithTooltip({
  label,
  tooltip,
  ariaLabel,
}: {
  label: string;
  tooltip: string;
  ariaLabel: string;
}) {
  return (
    <Group gap={6} wrap="nowrap">
      <span>{label}</span>
      <Tooltip label={tooltip} multiline w={260} withArrow>
        <span aria-label={ariaLabel} className={classes.helpIcon} tabIndex={0}>
          <IconInfoCircle size={15} stroke={1.8} />
        </span>
      </Tooltip>
    </Group>
  );
}

function CountBadge({
  value,
  inverted = false,
}: {
  value: number;
  inverted?: boolean;
}) {
  const color = inverted
    ? value > 0
      ? "yellow"
      : "green"
    : value > 0
      ? "green"
      : "gray";

  return (
    <Badge color={color} variant="light">
      {value}
    </Badge>
  );
}

function CompileStatusCell({ status }: { status?: KnowledgeCompileStatus }) {
  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Badge color={compileStatusColor(status?.status)} variant="light">
          {status?.status ?? "idle"}
        </Badge>
        {status?.durationMs !== null && status?.durationMs !== undefined && (
          <Badge variant="outline">{formatDuration(status.durationMs)}</Badge>
        )}
      </Group>
      <Text className={classes.mono} c="dimmed">
        {status?.lastRunId ?? "-"}
      </Text>
      {status?.succeededPageCount !== undefined && (
        <Text size="xs" c="dimmed">
          pages: {status.succeededPageCount} succeeded /{" "}
          {status.failedPageCount ?? 0} failed / {status.skippedPageCount ?? 0}{" "}
          skipped
        </Text>
      )}
      {status?.failureReason && (
        <Text size="sm" c="red">
          {status.failureReason}
        </Text>
      )}
    </Stack>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className={classes.metricItem}>
      <Text className={classes.metricLabel}>{label}</Text>
      <Text className={classes.metricValue}>{value}</Text>
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatTimestamp(value?: number): string {
  if (!value) return "-";
  return formatDate(new Date(value).toISOString());
}

function jobStateColor(state: string): string {
  if (state === "completed") return "green";
  if (state === "failed") return "red";
  if (state === "active") return "blue";
  if (state === "delayed") return "yellow";
  return "gray";
}

function compileStatusColor(status?: string): string {
  if (status === "succeeded") return "green";
  if (status === "partial") return "yellow";
  if (status === "failed") return "red";
  if (status === "running") return "blue";
  if (status === "queued") return "yellow";
  return "gray";
}

function healthColor(score: number): string {
  if (score >= 80) return "green";
  if (score >= 60) return "yellow";
  return "red";
}

function issueColor(severity: string): string {
  if (severity === "high") return "red";
  if (severity === "medium") return "yellow";
  return "gray";
}

function formatAgeHours(hours: number): string {
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
