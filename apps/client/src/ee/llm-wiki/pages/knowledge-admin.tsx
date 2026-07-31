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
  Menu,
  Modal,
  MultiSelect,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconDatabaseSearch,
  IconDotsVertical,
  IconInfoCircle,
  IconRefresh,
} from "@tabler/icons-react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getAppName } from "@/lib/config";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import useUserRole from "@/hooks/use-user-role";
import {
  forceRebuildKnowledgeSpace,
  getKnowledgeDiagnostics,
  getKnowledgeRunDiagnostics,
  getKnowledgeRunDiagnosticsSummary,
  getKnowledgeRunPageDiagnostics,
  getKnowledgeWorkerDiagnostics,
  retryKnowledgePages,
  runKnowledgeAdminAction,
  updateKnowledgeSpace,
} from "../services/knowledge-service";
import classes from "../styles/knowledge-admin.module.css";
import type {
  KnowledgeAdminSpaceAction,
  KnowledgeCompilationStageProgress,
  KnowledgeCompileRunProgress,
  KnowledgeCompileStatus,
  KnowledgePageCompileStage,
  KnowledgePageCompileStatus,
  KnowledgeQueueSnapshot,
  KnowledgeRunDiagnostic,
  KnowledgeRunPhase,
  KnowledgeRunStatus,
} from "../types/knowledge.types";

const DIAGNOSTICS_LIMIT = 50;
const EMPTY_QUEUE_COUNTS = {
  waiting: 0,
  active: 0,
  delayed: 0,
  prioritized: 0,
  waitingChildren: 0,
  paused: 0,
  failed: 0,
  completed: 0,
};

export function knowledgeDiagnosticsRefetchInterval(): number | false {
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return false;
  }
  return 5000;
}
const COMPILE_STATUS_OPTIONS: Array<{
  value: KnowledgePageCompileStatus;
  label: string;
}> = [
  { value: "failed", label: "failed" },
  { value: "running", label: "running" },
  { value: "queued", label: "queued" },
  { value: "succeeded", label: "succeeded" },
  { value: "skipped", label: "skipped" },
  { value: "not_started", label: "not started" },
];
const COMPILE_STAGE_OPTIONS: Array<{
  value: KnowledgePageCompileStage;
  label: string;
}> = [
  "queued",
  "read_source",
  "image_enrichment",
  "analysis",
  "generation",
  "merge",
  "validation",
  "import",
  "completed",
].map((value) => ({ value: value as KnowledgePageCompileStage, label: value }));

const RUN_STATUS_OPTIONS = [
  "queued",
  "compiling",
  "aggregate_pending",
  "aggregating",
  "succeeded",
  "partial",
  "failed",
  "superseded",
].map((value) => ({ value, label: value.replace(/_/g, " ") }));

const RUN_PHASE_OPTIONS = [
  "text",
  "initial_aggregate",
  "images",
  "image_merge",
  "final_aggregate",
  "complete",
].map((value) => ({ value, label: value.replace(/_/g, " ") }));

type ConfirmedSpaceCompilation = {
  mode: "update" | "force";
  spaceId: string;
  spaceName: string;
};

export default function KnowledgeAdminPage() {
  const { t } = useTranslation();
  const { isOwner } = useUserRole();
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [compileStatus, setCompileStatus] =
    useState<KnowledgePageCompileStatus | null>(null);
  const [compileStage, setCompileStage] =
    useState<KnowledgePageCompileStage | null>(null);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [runStatus, setRunStatus] = useState<KnowledgeRunStatus | null>(null);
  const [runPhase, setRunPhase] = useState<KnowledgeRunPhase | null>(null);
  const [runSearch, setRunSearch] = useState("");
  const [runPage, setRunPage] = useState(1);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runPageDetailPage, setRunPageDetailPage] = useState(1);
  const [confirmedCompilation, setConfirmedCompilation] =
    useState<ConfirmedSpaceCompilation | null>(null);
  const [confirmationSpaceName, setConfirmationSpaceName] = useState("");
  const [confirmationError, setConfirmationError] = useState<string | null>(
    null,
  );
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
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });

  const runSummaryQuery = useQuery({
    queryKey: ["knowledge-run-summary", spaceIds],
    queryFn: () => getKnowledgeRunDiagnosticsSummary({ spaceIds }),
    enabled: spaceIds.length > 0,
    refetchInterval: knowledgeDiagnosticsRefetchInterval,
    refetchIntervalInBackground: false,
  });

  const runListQuery = useQuery({
    queryKey: [
      "knowledge-runs",
      spaceIds,
      runStatus,
      runPhase,
      runSearch,
      runPage,
    ],
    queryFn: () =>
      getKnowledgeRunDiagnostics({
        spaceIds,
        ...(runStatus ? { statuses: [runStatus] } : {}),
        ...(runPhase ? { phases: [runPhase] } : {}),
        ...(runSearch.trim() ? { search: runSearch.trim() } : {}),
        page: runPage,
        limit: DIAGNOSTICS_LIMIT,
      }),
    enabled: spaceIds.length > 0,
    refetchInterval: knowledgeDiagnosticsRefetchInterval,
    refetchIntervalInBackground: false,
  });

  const workerQuery = useQuery({
    queryKey: ["knowledge-workers"],
    queryFn: getKnowledgeWorkerDiagnostics,
    enabled: isOwner,
    refetchInterval: isOwner ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  const runPageDetailQuery = useQuery({
    queryKey: ["knowledge-run-pages", selectedRunId, runPageDetailPage],
    queryFn: () =>
      getKnowledgeRunPageDiagnostics({
        runId: selectedRunId!,
        page: runPageDetailPage,
        limit: DIAGNOSTICS_LIMIT,
      }),
    enabled: selectedRunId !== null,
    refetchInterval: selectedRunId
      ? knowledgeDiagnosticsRefetchInterval
      : false,
    refetchIntervalInBackground: false,
  });

  const confirmedCompilationMutation = useMutation({
    mutationFn: async (params: {
      target: ConfirmedSpaceCompilation;
      confirmationSpaceName: string;
    }) => {
      const request = {
        spaceId: params.target.spaceId,
        confirmationSpaceName: params.confirmationSpaceName,
      };
      return params.target.mode === "force"
        ? forceRebuildKnowledgeSpace(request)
        : updateKnowledgeSpace(request);
    },
    retry: false,
    onSuccess: (data) => {
      setConfirmedCompilation(null);
      setConfirmationSpaceName("");
      setConfirmationError(null);
      notifications.show({
        message: t("Knowledge update queued", {
          count: data.runId ? 1 : 0,
        }),
      });
      void diagnosticsQuery.refetch();
      void runSummaryQuery.refetch();
      void runListQuery.refetch();
    },
    onError: (error) => {
      setConfirmationError(error.message);
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
      void runSummaryQuery.refetch();
      void runListQuery.refetch();
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
      void runSummaryQuery.refetch();
      void runListQuery.refetch();
    },
    onError: (error) => {
      notifications.show({ color: "red", message: error.message });
    },
  });

  const pages = diagnosticsQuery.data?.pages ?? [];
  const jobs = diagnosticsQuery.data?.jobs ?? [];
  const queueCounts = diagnosticsQuery.data?.queueCounts ?? EMPTY_QUEUE_COUNTS;
  const queueSnapshots = diagnosticsQuery.data?.queueSnapshots ?? {
    text: { ...queueCounts, sampledAt: null },
    image: { ...EMPTY_QUEUE_COUNTS, sampledAt: null },
  };
  const compileRuns = diagnosticsQuery.data?.compileRuns ?? [];
  const canViewGlobalQueues =
    diagnosticsQuery.data?.canViewGlobalQueues === true;
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
  const runSummary = runSummaryQuery.data;
  const runDiagnostics = runListQuery.data?.items ?? [];
  const runPageCount = Math.max(
    1,
    Math.ceil((runListQuery.data?.total ?? 0) / DIAGNOSTICS_LIMIT),
  );
  const runDetailPageCount = Math.max(
    1,
    Math.ceil((runPageDetailQuery.data?.total ?? 0) / DIAGNOSTICS_LIMIT),
  );
  const runSpaceAction = (
    action: KnowledgeAdminSpaceAction,
    targetSpaceId: string,
  ) => {
    actionMutation.mutate({ action, spaceIds: [targetSpaceId] });
  };
  const openConfirmedCompilation = (
    mode: ConfirmedSpaceCompilation["mode"],
    spaceId: string,
    spaceName: string,
  ) => {
    setConfirmedCompilation({ mode, spaceId, spaceName });
    setConfirmationSpaceName("");
    setConfirmationError(null);
    confirmedCompilationMutation.reset();
  };
  const closeConfirmedCompilation = () => {
    if (confirmedCompilationMutation.isPending) {
      return;
    }
    setConfirmedCompilation(null);
    setConfirmationSpaceName("");
    setConfirmationError(null);
  };
  const submitConfirmedCompilation = () => {
    if (
      !confirmedCompilation ||
      confirmationSpaceName !== confirmedCompilation.spaceName
    ) {
      return;
    }
    confirmedCompilationMutation.mutate({
      target: confirmedCompilation,
      confirmationSpaceName,
    });
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
                loading={
                  diagnosticsQuery.isFetching ||
                  runSummaryQuery.isFetching ||
                  runListQuery.isFetching
                }
                disabled={spaceIds.length === 0}
                onClick={() => {
                  void diagnosticsQuery.refetch();
                  void runSummaryQuery.refetch();
                  void runListQuery.refetch();
                  if (selectedRunId) void runPageDetailQuery.refetch();
                }}
              >
                {t("Refresh")}
              </Button>
            </Group>
          </Group>

          <Modal
            opened={confirmedCompilation !== null}
            onClose={closeConfirmedCompilation}
            closeOnClickOutside={!confirmedCompilationMutation.isPending}
            closeOnEscape={!confirmedCompilationMutation.isPending}
            title={
              confirmedCompilation?.mode === "force"
                ? t("Force rebuild knowledge")
                : t("Update knowledge")
            }
            centered
          >
            {confirmedCompilation && (
              <Stack gap="md">
                {confirmedCompilation.mode === "force" ? (
                  <Alert color="red" icon={<IconAlertTriangle size={18} />}>
                    <Stack gap="xs">
                      <Text size="sm" fw={600}>
                        {t(
                          "This permanently clears all compiled knowledge, image recognition cache, vectors, and relationships for this space.",
                        )}
                      </Text>
                      <Text size="sm">
                        {t(
                          "Original pages and attachments are preserved. Knowledge is unavailable while rebuilding.",
                        )}
                      </Text>
                    </Stack>
                  </Alert>
                ) : (
                  <Alert color="blue" icon={<IconInfoCircle size={18} />}>
                    {t(
                      "Only changed pages are compiled. Unchanged pages reuse existing knowledge, and existing knowledge is not cleared.",
                    )}
                  </Alert>
                )}

                <Text size="sm">
                  {t("Enter the exact space name to continue:")}{" "}
                  <Text
                    component="span"
                    fw={700}
                    className={classes.confirmationName}
                  >
                    {confirmedCompilation.spaceName}
                  </Text>
                </Text>
                <TextInput
                  label={t("Type the space name to confirm")}
                  value={confirmationSpaceName}
                  onChange={(event) => {
                    setConfirmationSpaceName(event.currentTarget.value);
                    setConfirmationError(null);
                  }}
                  error={confirmationError}
                  autoComplete="off"
                  data-autofocus
                />
                <Group justify="flex-end">
                  <Button
                    variant="default"
                    onClick={closeConfirmedCompilation}
                    disabled={confirmedCompilationMutation.isPending}
                  >
                    {t("Cancel")}
                  </Button>
                  <Button
                    color={
                      confirmedCompilation.mode === "force" ? "red" : undefined
                    }
                    loading={confirmedCompilationMutation.isPending}
                    disabled={
                      confirmationSpaceName !== confirmedCompilation.spaceName
                    }
                    onClick={submitConfirmedCompilation}
                  >
                    {confirmedCompilation.mode === "force"
                      ? t("Confirm force rebuild")
                      : t("Confirm knowledge update")}
                  </Button>
                </Group>
              </Stack>
            )}
          </Modal>

          <Modal
            opened={selectedRunId !== null}
            onClose={() => {
              setSelectedRunId(null);
              setRunPageDetailPage(1);
            }}
            title={t("Run pages")}
            size="xl"
          >
            {runPageDetailQuery.isError && (
              <Alert color="red" icon={<IconAlertTriangle size={18} />}>
                {runPageDetailQuery.error.message}
              </Alert>
            )}
            {runPageDetailQuery.isLoading ? (
              <Loader size="sm" />
            ) : (
              <Stack gap="md">
                <Table.ScrollContainer minWidth={960}>
                  <Table highlightOnHover verticalSpacing="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t("Page")}</Table.Th>
                        <Table.Th>{t("Text")}</Table.Th>
                        <Table.Th>{t("Images")}</Table.Th>
                        <Table.Th>{t("Merge")}</Table.Th>
                        <Table.Th>{t("Failure category")}</Table.Th>
                        <Table.Th>{t("Updated")}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {(runPageDetailQuery.data?.items ?? []).length === 0 ? (
                        <Table.Tr>
                          <Table.Td colSpan={6}>
                            <Text className={classes.emptyText}>
                              {t("No Run pages")}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ) : (
                        runPageDetailQuery.data?.items.map((page) => (
                          <Table.Tr key={page.runPageId}>
                            <Table.Td>
                              <Text fw={600}>
                                {page.title || page.sourcePageId}
                              </Text>
                              <Text className={classes.mono} c="dimmed">
                                {page.sourcePageId}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Badge
                                color={compileStatusColor(page.status)}
                                variant="light"
                              >
                                {humanizeState(page.status)}
                              </Badge>
                            </Table.Td>
                            <Table.Td>
                              <Stack gap={4} align="flex-start">
                                <Badge variant="light">
                                  {page.succeededImageCount}/
                                  {page.expectedImageCount}
                                </Badge>
                                {(page.imageFailures.retryableExhausted > 0 ||
                                  page.imageFailures.permanent > 0) && (
                                  <Text size="xs" c="dimmed">
                                    {t("Retry exhausted")}:{" "}
                                    {page.imageFailures.retryableExhausted} ·{" "}
                                    {t("Permanent")}:{" "}
                                    {page.imageFailures.permanent}
                                  </Text>
                                )}
                              </Stack>
                            </Table.Td>
                            <Table.Td>
                              <Badge variant="outline">
                                {humanizeState(page.mergeStatus)}
                              </Badge>
                            </Table.Td>
                            <Table.Td>
                              {page.errorCategory ? (
                                <Stack gap={4} align="flex-start">
                                  <Badge
                                    color={
                                      page.errorCategory === "budget_timeout"
                                        ? "orange"
                                        : "red"
                                    }
                                    variant="light"
                                  >
                                    {humanizeState(page.errorCategory)}
                                  </Badge>
                                  {page.errorSummary && (
                                    <Text size="xs" c="dimmed">
                                      {page.errorSummary}
                                    </Text>
                                  )}
                                </Stack>
                              ) : (
                                "-"
                              )}
                            </Table.Td>
                            <Table.Td>{formatDate(page.updatedAt)}</Table.Td>
                          </Table.Tr>
                        ))
                      )}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
                {runDetailPageCount > 1 && (
                  <Pagination
                    value={runPageDetailPage}
                    onChange={setRunPageDetailPage}
                    total={runDetailPageCount}
                  />
                )}
              </Stack>
            )}
          </Modal>

          <section className={classes.panel}>
            <Group align="end" grow>
              <MultiSelect
                data={spaceOptions}
                value={spaceIds}
                onChange={(value) => {
                  setSpaceIds(value);
                  setRunPage(1);
                  setSelectedRunId(null);
                }}
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

          {(runSummaryQuery.isError || runListQuery.isError) && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              {runSummaryQuery.error?.message ?? runListQuery.error?.message}
            </Alert>
          )}

          <section className={classes.panel}>
            <Group justify="space-between" align="flex-start" mb="md">
              <div>
                <Title order={2} size="h4">
                  {t("Space compilation runs")}
                </Title>
                <Text size="sm" c="dimmed">
                  {t(
                    "PostgreSQL is the scheduling authority. Redis worker and capacity values are estimates only.",
                  )}
                </Text>
              </div>
              {(runSummaryQuery.isFetching || runListQuery.isFetching) && (
                <Loader size="sm" />
              )}
            </Group>

            <div className={classes.metricGrid}>
              <Metric
                label={t("Active runs")}
                value={runSummary?.activeRunCount ?? 0}
              />
              <Metric
                label={t("Active space slots")}
                value={runSummary?.activeSpaceSlotRunCount ?? 0}
              />
              <Metric
                label={t("Queued runs")}
                value={runSummary?.queuedRunCount ?? 0}
              />
              <Metric
                label={t("Waiting initialization")}
                value={runSummary?.waitingInitializationCount ?? 0}
              />
              <Metric
                label={t("Longest current slot wait")}
                value={formatRunDuration(
                  runSummary?.longestCurrentSlotWaitMs ?? null,
                )}
              />
              <Metric
                label={t("Recent yields")}
                value={runSummary?.recentYieldCount ?? 0}
              />
              <Metric
                label={t("Recent completed")}
                value={runSummary?.recentCompletedCount ?? 0}
              />
              <Metric
                label={t("Recent failed")}
                value={runSummary?.recentFailedCount ?? 0}
              />
              <Metric
                label={t("Dispatch unacknowledged")}
                value={
                  (runSummary?.dispatch.spaceUnacknowledged ?? 0) +
                  (runSummary?.dispatch.imageUnacknowledged ?? 0)
                }
              />
              <Metric
                label={t("Expired leases")}
                value={runSummary?.recovery.expiredExecutionLeases ?? 0}
              />
              <Metric
                label={t("Budget timeouts")}
                value={runSummary?.failureCategories.budgetTimeout ?? 0}
              />
              {isOwner && (
                <Metric
                  label={t("Estimated space capacity")}
                  value={workerQuery.data?.space.capacity ?? t("Unknown")}
                />
              )}
            </div>

            <Group gap="xs" mt="md">
              {Object.entries(runSummary?.phaseCounts ?? {}).map(
                ([phase, count]) => (
                  <Badge key={phase} variant="light">
                    {humanizeState(phase)}: {count}
                  </Badge>
                ),
              )}
              <Badge color="orange" variant="outline">
                {t("Lock renewal failed")}:{" "}
                {runSummary?.workerEvents.lockRenewalFailed ?? 0}
              </Badge>
              <Badge color="red" variant="outline">
                {t("Stalled")}: {runSummary?.workerEvents.stalled ?? 0}
              </Badge>
            </Group>

            {isOwner && runSummary?.queues && (
              <div className={classes.queueGrid}>
                <QueueSnapshotCard
                  title={t("Space work queue")}
                  snapshot={runSummary.queues.space}
                />
                <QueueSnapshotCard
                  title={t("Shared image queue")}
                  snapshot={runSummary.queues.image}
                />
              </div>
            )}

            <Group align="end" grow mt="lg">
              <TextInput
                label={t("Search Space or Run")}
                value={runSearch}
                onChange={(event) => {
                  setRunSearch(event.currentTarget.value);
                  setRunPage(1);
                }}
              />
              <Select
                data={RUN_STATUS_OPTIONS}
                value={runStatus}
                onChange={(value) => {
                  setRunStatus(value as KnowledgeRunStatus | null);
                  setRunPage(1);
                }}
                label={t("Run status")}
                clearable
              />
              <Select
                data={RUN_PHASE_OPTIONS}
                value={runPhase}
                onChange={(value) => {
                  setRunPhase(value as KnowledgeRunPhase | null);
                  setRunPage(1);
                }}
                label={t("Run phase")}
                clearable
              />
            </Group>

            <Table.ScrollContainer minWidth={1240}>
              <Table mt="md" highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("Space")}</Table.Th>
                    <Table.Th>{t("State")}</Table.Th>
                    <Table.Th>{t("Slice")}</Table.Th>
                    <Table.Th>{t("Text")}</Table.Th>
                    <Table.Th>{t("Images")}</Table.Th>
                    <Table.Th>{t("Merge")}</Table.Th>
                    <Table.Th>{t("Current wait")}</Table.Th>
                    <Table.Th>{t("Run duration")}</Table.Th>
                    <Table.Th>{t("Worker")}</Table.Th>
                    <Table.Th>{t("Details")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {runDiagnostics.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={10}>
                        <Text className={classes.emptyText}>
                          {t("No compilation runs")}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    runDiagnostics.map((run) => (
                      <ScalableRunRow
                        key={run.runId}
                        run={run}
                        onViewPages={() => {
                          setSelectedRunId(run.runId);
                          setRunPageDetailPage(1);
                        }}
                      />
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="space-between" mt="md">
              <Text size="sm" c="dimmed">
                {t("Runs")}: {runListQuery.data?.total ?? 0}
              </Text>
              {runPageCount > 1 && (
                <Pagination
                  value={runPage}
                  onChange={setRunPage}
                  total={runPageCount}
                />
              )}
            </Group>
          </section>

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
                                variant="light"
                                leftSection={<IconRefresh size={14} />}
                                onClick={() =>
                                  openConfirmedCompilation(
                                    "update",
                                    space.spaceId,
                                    space.spaceName,
                                  )
                                }
                              >
                                {t("Update knowledge")}
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
                              <Menu position="bottom-end" withinPortal>
                                <Menu.Target>
                                  <Button
                                    size="xs"
                                    variant="subtle"
                                    color="red"
                                    leftSection={<IconDotsVertical size={14} />}
                                  >
                                    {t("Dangerous actions")}
                                  </Button>
                                </Menu.Target>
                                <Menu.Dropdown>
                                  <Menu.Label>{t("Danger zone")}</Menu.Label>
                                  <Menu.Item
                                    color="red"
                                    leftSection={
                                      <IconAlertTriangle size={14} />
                                    }
                                    onClick={() =>
                                      openConfirmedCompilation(
                                        "force",
                                        space.spaceId,
                                        space.spaceName,
                                      )
                                    }
                                  >
                                    {t("Force rebuild knowledge")}
                                  </Menu.Item>
                                </Menu.Dropdown>
                              </Menu>
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
            <Title order={2} size="h4" mb="md">
              {t("Compilation run history")}
            </Title>
            <Table.ScrollContainer minWidth={1120}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("Space")}</Table.Th>
                    <Table.Th>{t("State")}</Table.Th>
                    <Table.Th>{t("Text progress")}</Table.Th>
                    <Table.Th>{t("Image progress")}</Table.Th>
                    <Table.Th>{t("Merge progress")}</Table.Th>
                    <Table.Th>{t("Updated")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {compileRuns.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={6}>
                        <Text className={classes.emptyText}>
                          {t("No compilation runs")}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    compileRuns.map((run) => (
                      <CompilationRunRow key={run.runId} run={run} />
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
                    <Table.Th>{t("Missing embeddings")}</Table.Th>
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

          {canViewGlobalQueues && (
            <section className={classes.panel}>
              <Stack gap="sm" mb="md">
                <div>
                  <Title order={2} size="h4">
                    {t("Current queue tasks")}
                  </Title>
                  <Text size="sm" c="dimmed">
                    {t(
                      "Current Redis snapshot; completed and failed counts are not historical totals.",
                    )}
                  </Text>
                </div>
                <div className={classes.queueGrid}>
                  <QueueSnapshotCard
                    title={t("Text compilation queue")}
                    snapshot={queueSnapshots.text}
                  />
                  <QueueSnapshotCard
                    title={t("Image recognition queue")}
                    snapshot={queueSnapshots.image}
                  />
                </div>
                <Group justify="space-between">
                  <Text fw={600}>{t("Current sampled jobs")}</Text>
                  <Group gap="xs">
                    <Text size="sm" c="dimmed">
                      {t("Recent records")}
                    </Text>
                    <Badge variant="light">{jobs.length}</Badge>
                  </Group>
                </Group>
              </Stack>

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
                              job.finishedOn ??
                                job.processedOn ??
                                job.timestamp,
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
          )}
        </Stack>
      </Container>
    </>
  );
}

function QueueSnapshotCard({
  title,
  snapshot,
}: {
  title: string;
  snapshot?: KnowledgeQueueSnapshot;
}) {
  const { t } = useTranslation();
  const value = snapshot ?? { ...EMPTY_QUEUE_COUNTS, sampledAt: null };
  const waiting = value.waiting + value.prioritized + value.waitingChildren;

  return (
    <div className={classes.queueCard}>
      <Text fw={600}>{title}</Text>
      <Group gap="xs" mt="xs">
        <Badge color="yellow" variant="light">
          {t("Waiting")}: {waiting}
        </Badge>
        <Badge color="blue" variant="light">
          {t("Active")}: {value.active}
        </Badge>
        <Badge color="orange" variant="light">
          {t("Delayed")}: {value.delayed}
        </Badge>
        <Badge color="gray" variant="light">
          {t("Paused")}: {value.paused}
        </Badge>
        <Badge color="red" variant="light">
          {t("Failed")}: {value.failed}
        </Badge>
        <Badge color="green" variant="light">
          {t("Completed")}: {value.completed}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed" mt="xs">
        {t("Sampled")}: {formatDate(value.sampledAt)}
      </Text>
    </div>
  );
}

function ScalableRunRow({
  run,
  onViewPages,
}: {
  run: KnowledgeRunDiagnostic;
  onViewPages: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Table.Tr>
      <Table.Td>
        <Text fw={600}>{run.spaceName || run.spaceId}</Text>
        <Text className={classes.mono} c="dimmed">
          {run.runId}
        </Text>
      </Table.Td>
      <Table.Td>
        <Stack gap={4} align="flex-start">
          <Badge color={compileStatusColor(run.status)} variant="light">
            {humanizeState(run.status)}
          </Badge>
          <Text size="xs" c="dimmed">
            {humanizeState(run.phase)}
          </Text>
          {run.queueState && (
            <Badge variant="outline">{humanizeState(run.queueState)}</Badge>
          )}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Text fw={600}>#{run.spaceJobSequence}</Text>
        <Text size="xs" c="dimmed">
          {run.lastYieldReason ? humanizeState(run.lastYieldReason) : "-"}
        </Text>
      </Table.Td>
      <Table.Td>
        {run.progress.text.succeeded}/{run.progress.text.expected}
        {(run.progress.text.failed > 0 || run.progress.text.skipped > 0) && (
          <Text size="xs" c="dimmed">
            {run.progress.text.failed} failed · {run.progress.text.skipped}{" "}
            skipped
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {run.progress.images.succeeded}/{run.progress.images.expected}
      </Table.Td>
      <Table.Td>
        {run.progress.merge.succeeded}/{run.progress.merge.expected}
      </Table.Td>
      <Table.Td>{formatRunDuration(run.currentSliceWaitMs)}</Table.Td>
      <Table.Td>{formatRunDuration(run.runDurationMs)}</Table.Td>
      <Table.Td>
        <Text className={classes.mono}>{run.workerId ?? "-"}</Text>
      </Table.Td>
      <Table.Td>
        <Button size="compact-xs" variant="light" onClick={onViewPages}>
          {t("View pages")}
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

function CompilationRunRow({ run }: { run: KnowledgeCompileRunProgress }) {
  return (
    <Table.Tr>
      <Table.Td>
        <Text fw={600}>{run.spaceName || run.spaceId || "-"}</Text>
        <Text className={classes.mono} c="dimmed">
          {run.runId || "-"}
        </Text>
      </Table.Td>
      <Table.Td>
        <Stack gap={4} align="flex-start">
          <Badge color={compileStatusColor(run.status)} variant="light">
            {run.status}
          </Badge>
          {(run.mode || run.phase) && (
            <Text size="xs" c="dimmed">
              {[run.mode, run.phase].filter(Boolean).join(" · ")}
            </Text>
          )}
        </Stack>
      </Table.Td>
      <Table.Td>
        <CompilationProgressCell progress={run.progress.text} />
      </Table.Td>
      <Table.Td>
        <CompilationProgressCell progress={run.progress.image} />
      </Table.Td>
      <Table.Td>
        <CompilationProgressCell progress={run.progress.merge} />
      </Table.Td>
      <Table.Td>{formatDate(run.updatedAt ?? run.createdAt ?? null)}</Table.Td>
    </Table.Tr>
  );
}

function CompilationProgressCell({
  progress,
}: {
  progress: KnowledgeCompilationStageProgress;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap={5}>
      <Group gap={5}>
        <Badge variant="light">
          {t("Expected")}: {progress.expected}
        </Badge>
        <Badge color="green" variant="light">
          {t("Succeeded")}: {progress.succeeded}
        </Badge>
        <Badge color="red" variant="light">
          {t("Failed")}: {progress.failed}
        </Badge>
        <Badge color="gray" variant="light">
          {t("Skipped")}: {progress.skipped}
        </Badge>
        <Badge color="yellow" variant="light">
          {t("Pending")}: {progress.pending}
        </Badge>
        <Badge color="orange" variant="outline">
          {t("Waiting")}: {progress.waiting}
        </Badge>
      </Group>
      {progress.lastAttemptError && (
        <Text size="xs" c="red">
          {t("Last attempt error")}: {progress.lastAttemptError}
        </Text>
      )}
    </Stack>
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

function Metric({ label, value }: { label: string; value: number | string }) {
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
  if (status === "superseded" || status === "skipped") return "gray";
  if (status === "failed") return "red";
  if (
    status === "running" ||
    status === "compiling" ||
    status === "aggregating" ||
    status === "aggregate_pending"
  )
    return "blue";
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

function formatRunDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function humanizeState(value: string): string {
  return value.replace(/_/g, " ");
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
