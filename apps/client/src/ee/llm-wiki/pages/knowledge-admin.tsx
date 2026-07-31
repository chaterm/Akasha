import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
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
  KnowledgeQueueSnapshot,
  KnowledgeRunDiagnostic,
  KnowledgeRunPhase,
  KnowledgeRunStatus,
} from "../types/knowledge.types";

const PAGE_SIZE = 50;

export function knowledgeDiagnosticsRefetchInterval(): number | false {
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return false;
  }
  return 5_000;
}

const RUN_STATUS_OPTIONS = [
  "queued",
  "compiling",
  "aggregate_pending",
  "aggregating",
  "succeeded",
  "partial",
  "failed",
  "superseded",
].map((value) => ({ value, label: humanizeState(value) }));

const RUN_PHASE_OPTIONS = [
  "text",
  "initial_aggregate",
  "images",
  "image_merge",
  "final_aggregate",
  "complete",
].map((value) => ({ value, label: humanizeState(value) }));

type ConfirmedSpaceCompilation = {
  mode: "update" | "force";
  spaceId: string;
  spaceName: string;
};

export default function KnowledgeAdminPage() {
  const { t } = useTranslation();
  const { isOwner } = useUserRole();
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [runStatus, setRunStatus] = useState<KnowledgeRunStatus | null>(null);
  const [runPhase, setRunPhase] = useState<KnowledgeRunPhase | null>(null);
  const [runSearch, setRunSearch] = useState("");
  const [runPage, setRunPage] = useState(1);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runPageDetailPage, setRunPageDetailPage] = useState(1);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
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
  const selectedSpaces = useMemo(
    () => spaces.filter((space) => spaceIds.includes(space.id)),
    [spaceIds, spaces],
  );

  useEffect(() => {
    if (!spaceIdsInitialized.current && spaceOptions.length > 0) {
      spaceIdsInitialized.current = true;
      setSpaceIds([spaceOptions[0].value]);
    }
  }, [spaceOptions]);

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
        limit: PAGE_SIZE,
      }),
    enabled: spaceIds.length > 0,
    refetchInterval: knowledgeDiagnosticsRefetchInterval,
    refetchIntervalInBackground: false,
  });
  const runPageDetailQuery = useQuery({
    queryKey: ["knowledge-run-pages", selectedRunId, runPageDetailPage],
    queryFn: () =>
      getKnowledgeRunPageDiagnostics({
        runId: selectedRunId!,
        page: runPageDetailPage,
        limit: PAGE_SIZE,
      }),
    enabled: selectedRunId !== null,
    refetchInterval: selectedRunId
      ? knowledgeDiagnosticsRefetchInterval
      : false,
    refetchIntervalInBackground: false,
  });
  const workerQuery = useQuery({
    queryKey: ["knowledge-workers"],
    queryFn: getKnowledgeWorkerDiagnostics,
    enabled: isOwner,
    refetchInterval: isOwner ? 30_000 : false,
    refetchIntervalInBackground: false,
  });

  const refreshRunViews = () => {
    void runSummaryQuery.refetch();
    void runListQuery.refetch();
    if (selectedRunId) void runPageDetailQuery.refetch();
  };

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
    onSuccess: () => {
      setConfirmedCompilation(null);
      setConfirmationSpaceName("");
      setConfirmationError(null);
      notifications.show({ message: t("Knowledge update queued") });
      refreshRunViews();
    },
    onError: (error) => setConfirmationError(error.message),
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
      refreshRunViews();
    },
    onError: (error) =>
      notifications.show({ color: "red", message: error.message }),
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
      refreshRunViews();
    },
    onError: (error) =>
      notifications.show({ color: "red", message: error.message }),
  });

  const runSummary = runSummaryQuery.data;
  const runs = runListQuery.data?.items ?? [];
  const runPageCount = Math.max(
    1,
    Math.ceil((runListQuery.data?.total ?? 0) / PAGE_SIZE),
  );
  const detailPageCount = Math.max(
    1,
    Math.ceil((runPageDetailQuery.data?.total ?? 0) / PAGE_SIZE),
  );
  const openCompilation = (
    mode: ConfirmedSpaceCompilation["mode"],
    spaceId: string,
    spaceName: string,
  ) => {
    setConfirmedCompilation({ mode, spaceId, spaceName });
    setConfirmationSpaceName("");
    setConfirmationError(null);
    confirmedCompilationMutation.reset();
  };

  return (
    <>
      <Helmet>
        <title>
          {t("Knowledge diagnostics")} - {getAppName()}
        </title>
      </Helmet>
      <Container size="xl" py="xl">
        <Stack gap="lg">
          <Group justify="space-between">
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
                loading={runSummaryQuery.isFetching || runListQuery.isFetching}
                disabled={spaceIds.length === 0}
                onClick={refreshRunViews}
              >
                {t("Refresh")}
              </Button>
            </Group>
          </Group>

          <Modal
            opened={confirmedCompilation !== null}
            onClose={() => {
              if (!confirmedCompilationMutation.isPending) {
                setConfirmedCompilation(null);
              }
            }}
            title={
              confirmedCompilation?.mode === "force"
                ? t("Force rebuild knowledge")
                : t("Update knowledge")
            }
            centered
          >
            {confirmedCompilation && (
              <Stack gap="md">
                <Alert
                  color={confirmedCompilation.mode === "force" ? "red" : "blue"}
                  icon={
                    confirmedCompilation.mode === "force" ? (
                      <IconAlertTriangle size={18} />
                    ) : (
                      <IconInfoCircle size={18} />
                    )
                  }
                >
                  {confirmedCompilation.mode === "force"
                    ? t(
                        "Compiled knowledge is cleared before a complete rebuild. Original pages and attachments are preserved.",
                      )
                    : t(
                        "Only changed pages are compiled; unchanged knowledge is reused.",
                      )}
                </Alert>
                <Text size="sm">
                  {t("Enter the exact space name to continue:")}{" "}
                  <Text component="span" fw={700}>
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
                  data-autofocus
                />
                <Group justify="flex-end">
                  <Button
                    variant="default"
                    disabled={confirmedCompilationMutation.isPending}
                    onClick={() => setConfirmedCompilation(null)}
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
                    onClick={() =>
                      confirmedCompilationMutation.mutate({
                        target: confirmedCompilation,
                        confirmationSpaceName,
                      })
                    }
                  >
                    {t("Confirm")}
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
              setSelectedPageIds([]);
            }}
            title={t("Run pages")}
            size="xl"
          >
            {runPageDetailQuery.isError && (
              <Alert color="red">{runPageDetailQuery.error.message}</Alert>
            )}
            {runPageDetailQuery.isLoading ? (
              <Loader size="sm" />
            ) : (
              <Stack gap="md">
                <Group justify="flex-end">
                  <Button
                    size="xs"
                    disabled={selectedPageIds.length === 0}
                    loading={retryPagesMutation.isPending}
                    onClick={() =>
                      retryPagesMutation.mutate({ pageIds: selectedPageIds })
                    }
                  >
                    {t("Retry selected")}
                  </Button>
                </Group>
                <Table.ScrollContainer minWidth={980}>
                  <Table highlightOnHover verticalSpacing="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t("Retry")}</Table.Th>
                        <Table.Th>{t("Page")}</Table.Th>
                        <Table.Th>{t("Text")}</Table.Th>
                        <Table.Th>{t("Images")}</Table.Th>
                        <Table.Th>{t("Merge")}</Table.Th>
                        <Table.Th>{t("Failure category")}</Table.Th>
                        <Table.Th>{t("Updated")}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {(runPageDetailQuery.data?.items ?? []).map((page) => (
                        <Table.Tr key={page.runPageId}>
                          <Table.Td>
                            <Checkbox
                              disabled={page.status !== "failed"}
                              checked={selectedPageIds.includes(
                                page.sourcePageId,
                              )}
                              onChange={(event) =>
                                setSelectedPageIds((current) =>
                                  event.currentTarget.checked
                                    ? [
                                        ...new Set([
                                          ...current,
                                          page.sourcePageId,
                                        ]),
                                      ]
                                    : current.filter(
                                        (id) => id !== page.sourcePageId,
                                      ),
                                )
                              }
                            />
                          </Table.Td>
                          <Table.Td>
                            <Text fw={600}>
                              {page.title || page.sourcePageId}
                            </Text>
                            <Text className={classes.mono} c="dimmed">
                              {page.sourcePageId}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <StateBadge value={page.status} />
                          </Table.Td>
                          <Table.Td>
                            {page.succeededImageCount}/{page.expectedImageCount}
                          </Table.Td>
                          <Table.Td>
                            <StateBadge value={page.mergeStatus} />
                          </Table.Td>
                          <Table.Td>
                            {page.errorCategory ? (
                              <Stack gap={4}>
                                <StateBadge value={page.errorCategory} />
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
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
                {detailPageCount > 1 && (
                  <Pagination
                    value={runPageDetailPage}
                    onChange={setRunPageDetailPage}
                    total={detailPageCount}
                  />
                )}
              </Stack>
            )}
          </Modal>

          <section className={classes.panel}>
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
          </section>

          {(runSummaryQuery.isError || runListQuery.isError) && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              {runSummaryQuery.error?.message ?? runListQuery.error?.message}
            </Alert>
          )}

          <section className={classes.panel}>
            <Group justify="space-between" mb="md">
              <div>
                <Title order={2} size="h4">
                  {t("Space compilation runs")}
                </Title>
                <Text size="sm" c="dimmed">
                  {t(
                    "PostgreSQL is the scheduling authority. Redis worker counts are capacity estimates only.",
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
                label={t("Longest slot wait")}
                value={formatDuration(
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
            {isOwner && workerQuery.data && (
              <Text size="xs" c="dimmed" mt="sm">
                {t("Database pool per instance")}:{" "}
                {workerQuery.data.databaseMaxPool} · {t("Image capacity")}:{" "}
                {workerQuery.data.image.capacity ?? t("Unknown")}
              </Text>
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
                  {runs.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={10}>
                        <Text className={classes.emptyText}>
                          {t("No compilation runs")}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    runs.map((run) => (
                      <RunRow
                        key={run.runId}
                        run={run}
                        onViewPages={() => {
                          setSelectedRunId(run.runId);
                          setRunPageDetailPage(1);
                          setSelectedPageIds([]);
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

          <section className={classes.panel}>
            <Title order={2} size="h4" mb="md">
              {t("Space operations")}
            </Title>
            <Table.ScrollContainer minWidth={900}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("Space")}</Table.Th>
                    <Table.Th>{t("Actions")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {selectedSpaces.map((space) => (
                    <Table.Tr key={space.id}>
                      <Table.Td>{space.name}</Table.Td>
                      <Table.Td>
                        <Group gap="xs">
                          <Button
                            size="xs"
                            variant="light"
                            onClick={() =>
                              openCompilation("update", space.id, space.name)
                            }
                          >
                            {t("Update knowledge")}
                          </Button>
                          <Button
                            size="xs"
                            variant="default"
                            loading={actionMutation.isPending}
                            onClick={() =>
                              actionMutation.mutate({
                                action: "rebuild_embeddings",
                                spaceIds: [space.id],
                              })
                            }
                          >
                            {t("Rebuild embeddings")}
                          </Button>
                          <MaintenanceMenu
                            onAction={(action) =>
                              actionMutation.mutate({
                                action,
                                spaceIds: [space.id],
                              })
                            }
                            onForce={() =>
                              openCompilation("force", space.id, space.name)
                            }
                          />
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </section>
        </Stack>
      </Container>
    </>
  );
}

function RunRow({
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
        <Text fw={600}>{run.spaceName}</Text>
        <Text className={classes.mono} c="dimmed">
          {run.runId}
        </Text>
      </Table.Td>
      <Table.Td>
        <Stack gap={4} align="flex-start">
          <StateBadge value={run.status} />
          <Badge variant="outline">{humanizeState(run.phase)}</Badge>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{humanizeState(run.queueState ?? "active")}</Text>
        <Text size="xs" c="dimmed">
          #{run.spaceJobSequence}
          {run.lastYieldReason ? ` · ${run.lastYieldReason}` : ""}
        </Text>
      </Table.Td>
      <Table.Td>{formatProgress(run.progress.text)}</Table.Td>
      <Table.Td>{formatProgress(run.progress.images)}</Table.Td>
      <Table.Td>{formatProgress(run.progress.merge)}</Table.Td>
      <Table.Td>{formatDuration(run.currentSliceWaitMs)}</Table.Td>
      <Table.Td>{formatDuration(run.runDurationMs)}</Table.Td>
      <Table.Td>{run.workerId ?? "-"}</Table.Td>
      <Table.Td>
        <Button size="xs" variant="subtle" onClick={onViewPages}>
          {t("View pages")}
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

function MaintenanceMenu({
  onAction,
  onForce,
}: {
  onAction: (action: KnowledgeAdminSpaceAction) => void;
  onForce: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconDotsVertical size={14} />}
        >
          {t("More")}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => onAction("reindex_access")}>
          {t("Reindex access")}
        </Menu.Item>
        <Menu.Item onClick={() => onAction("mark_stale")}>
          {t("Mark stale")}
        </Menu.Item>
        <Menu.Item color="red" onClick={onForce}>
          {t("Force rebuild knowledge")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function QueueSnapshotCard({
  title,
  snapshot,
}: {
  title: string;
  snapshot: KnowledgeQueueSnapshot;
}) {
  return (
    <div className={classes.queueCard}>
      <Text fw={600}>{title}</Text>
      <Group gap="xs" mt="xs">
        {[
          ["waiting", snapshot.waiting],
          ["active", snapshot.active],
          ["delayed", snapshot.delayed],
          ["failed", snapshot.failed],
        ].map(([label, value]) => (
          <Badge key={label} variant="light">
            {label}: {value}
          </Badge>
        ))}
      </Group>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={classes.metricCard}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700}>{value}</Text>
    </div>
  );
}

function StateBadge({ value }: { value: string }) {
  const color =
    value === "failed" || value === "provider" || value === "publication"
      ? "red"
      : value === "partial" || value === "budget_timeout"
        ? "orange"
        : value === "succeeded" || value === "complete"
          ? "green"
          : "blue";
  return (
    <Badge color={color} variant="light">
      {humanizeState(value)}
    </Badge>
  );
}

function formatProgress(progress: { expected: number; succeeded: number }) {
  return `${progress.succeeded}/${progress.expected}`;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function humanizeState(value: string): string {
  return value.replace(/_/g, " ");
}
