import { useMemo, useState } from "react";
import {
  ActionIcon,
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
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  useMutation,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconDatabaseSearch,
  IconDotsVertical,
  IconInfoCircle,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getAppName } from "@/lib/config";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import useUserRole from "@/hooks/use-user-role";
import {
  cancelKnowledgeCompilationRun,
  forceRebuildKnowledgeSpace,
  getKnowledgeDelayedPageDiagnostics,
  getKnowledgePageCompilationLog,
  getKnowledgeQualityDiagnostics,
  getKnowledgeQuarantineDiagnostics,
  getKnowledgeRetrievalDiagnostics,
  getKnowledgeRunDiagnostics,
  getKnowledgeRunDiagnosticsSummary,
  getKnowledgeRunPageDiagnostics,
  getKnowledgeWorkerDiagnostics,
  immediatelyCompileDelayedPage,
  removeDelayedPageFromQueue,
  retryKnowledgePages,
  runKnowledgeAdminAction,
  updateKnowledgeSpace,
} from "../services/knowledge-service";
import classes from "../styles/knowledge-admin.module.css";
import type {
  KnowledgeAdminSpaceAction,
  KnowledgeDelayedPageDiagnosticsPage,
  KnowledgeDelayedPageStatus,
  KnowledgePageLogItem,
  KnowledgeQualityReport,
  KnowledgeQuarantineDiagnosticsPage,
  KnowledgeQueueSnapshot,
  KnowledgeRetrievalDiagnosticsSummary,
  KnowledgeRunDiagnostic,
  KnowledgeRunPhase,
  KnowledgeRunStatus,
} from "../types/knowledge.types";

const PAGE_SIZE = 50;
const ALL_SPACES_VALUE = "__all_spaces__";
const ACTIVE_RUN_STATUSES: KnowledgeRunStatus[] = [
  "queued",
  "compiling",
  "aggregate_pending",
  "aggregating",
];

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
  "cancelled",
].map((value) => ({ value, label: humanizeState(value) }));

const RUN_PHASE_OPTIONS = [
  "text",
  "initial_aggregate",
  "images",
  "image_merge",
  "finalizing",
  "final_aggregate",
  "complete",
].map((value) => ({ value, label: humanizeState(value) }));

const PAGE_LOG_STATUS_OPTIONS = [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
].map((value) => ({ value, label: humanizeState(value) }));

// Quick relative time windows for the compilation log, in hours.
const PAGE_LOG_RANGE_HOURS: Record<string, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};
type PageLogRange = keyof typeof PAGE_LOG_RANGE_HOURS | "all";

type ConfirmedSpaceCompilation = {
  mode: "update" | "force";
  spaceId: string;
  spaceName: string;
};

type ConfirmedRunCancellation = {
  runId: string;
  spaceName: string;
};

type ConfirmedDelayedPageCompilation = {
  scheduleId: string;
  pageName: string;
};

type RunStatusFilter = KnowledgeRunStatus | "active";
type DiagnosticsSection = "runs" | "delayed" | "log" | "health";

export default function KnowledgeAdminPage() {
  const { t } = useTranslation();
  const { isOwner, isAdmin } = useUserRole();
  const [spaceSelection, setSpaceSelection] = useState<string[]>([
    ALL_SPACES_VALUE,
  ]);
  const [runStatus, setRunStatus] = useState<RunStatusFilter | null>("active");
  const [runPhase, setRunPhase] = useState<KnowledgeRunPhase | null>(null);
  const [runSearch, setRunSearch] = useState("");
  const [runPage, setRunPage] = useState(1);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runPageDetailPage, setRunPageDetailPage] = useState(1);
  const [activeSection, setActiveSection] =
    useState<DiagnosticsSection>("runs");
  const [delayedStatus, setDelayedStatus] =
    useState<KnowledgeDelayedPageStatus | null>(null);
  const [delayedSearch, setDelayedSearch] = useState("");
  const [delayedPage, setDelayedPage] = useState(1);
  const [confirmedDelayedPage, setConfirmedDelayedPage] =
    useState<ConfirmedDelayedPageCompilation | null>(null);
  const [delayedPageConfirmationName, setDelayedPageConfirmationName] =
    useState("");
  const [delayedPageConfirmationError, setDelayedPageConfirmationError] =
    useState<string | null>(null);
  const [quarantinePage, setQuarantinePage] = useState(1);
  const [logRange, setLogRange] = useState<PageLogRange>("24h");
  const [logStatus, setLogStatus] = useState<string | null>(null);
  const [logSearch, setLogSearch] = useState("");
  const [logPage, setLogPage] = useState(1);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [confirmedCompilation, setConfirmedCompilation] =
    useState<ConfirmedSpaceCompilation | null>(null);
  const [confirmationSpaceName, setConfirmationSpaceName] = useState("");
  const [confirmationError, setConfirmationError] = useState<string | null>(
    null,
  );
  const [confirmedRunCancellation, setConfirmedRunCancellation] =
    useState<ConfirmedRunCancellation | null>(null);
  const [cancelConfirmationSpaceName, setCancelConfirmationSpaceName] =
    useState("");
  const [cancelReason, setCancelReason] = useState("");
  const { data: spacesData, isLoading: spacesLoading } = useGetSpacesQuery({
    limit: 5000,
  });
  const spaces = spacesData?.items ?? [];
  const spaceOptions = useMemo(
    () => [
      { value: ALL_SPACES_VALUE, label: t("All spaces") },
      ...spaces.map((space) => ({ value: space.id, label: space.name })),
    ],
    [spaces, t],
  );
  const spaceSlugById = useMemo(
    () => new Map(spaces.map((space) => [space.id, space.slug] as const)),
    [spaces],
  );
  const allSpacesSelected = spaceSelection.includes(ALL_SPACES_VALUE);
  const selectedSpaceIds = allSpacesSelected ? [] : spaceSelection;
  const diagnosticsScope = allSpacesSelected
    ? {}
    : { spaceIds: selectedSpaceIds };
  const diagnosticsScopeReady =
    allSpacesSelected || selectedSpaceIds.length > 0;
  const selectedSpaces = useMemo(
    () => spaces.filter((space) => selectedSpaceIds.includes(space.id)),
    [selectedSpaceIds, spaces],
  );
  const runStatuses =
    runStatus === "active"
      ? ACTIVE_RUN_STATUSES
      : runStatus
        ? [runStatus]
        : undefined;

  const runSummaryQuery = useQuery({
    queryKey: ["knowledge-run-summary", allSpacesSelected, selectedSpaceIds],
    queryFn: () => getKnowledgeRunDiagnosticsSummary(diagnosticsScope),
    enabled: diagnosticsScopeReady,
    refetchInterval: knowledgeDiagnosticsRefetchInterval,
    refetchIntervalInBackground: false,
  });
  const runListQuery = useQuery({
    queryKey: [
      "knowledge-runs",
      allSpacesSelected,
      selectedSpaceIds,
      runStatus,
      runPhase,
      runSearch,
      runPage,
    ],
    queryFn: () =>
      getKnowledgeRunDiagnostics({
        ...diagnosticsScope,
        ...(runStatuses ? { statuses: runStatuses } : {}),
        ...(runPhase ? { phases: [runPhase] } : {}),
        ...(runSearch.trim() ? { search: runSearch.trim() } : {}),
        page: runPage,
        limit: PAGE_SIZE,
      }),
    enabled: diagnosticsScopeReady,
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
  const qualityQuery = useQuery({
    queryKey: ["knowledge-quality", allSpacesSelected, selectedSpaceIds],
    queryFn: () => getKnowledgeQualityDiagnostics(diagnosticsScope),
    enabled: activeSection === "health" && diagnosticsScopeReady,
  });
  const quarantineQuery = useQuery({
    queryKey: [
      "knowledge-quarantine",
      allSpacesSelected,
      selectedSpaceIds,
      quarantinePage,
    ],
    queryFn: () =>
      getKnowledgeQuarantineDiagnostics({
        ...diagnosticsScope,
        page: quarantinePage,
        limit: 20,
      }),
    enabled: activeSection === "health" && isOwner && diagnosticsScopeReady,
  });
  const retrievalQuery = useQuery({
    queryKey: ["knowledge-retrieval"],
    queryFn: getKnowledgeRetrievalDiagnostics,
    enabled: activeSection === "health" && isOwner,
  });
  const pageLogQuery = useQuery({
    queryKey: [
      "knowledge-page-log",
      allSpacesSelected,
      selectedSpaceIds,
      logRange,
      logStatus,
      logSearch,
      logPage,
    ],
    queryFn: () => {
      const hours = PAGE_LOG_RANGE_HOURS[logRange];
      const from = hours
        ? new Date(Date.now() - hours * 3_600_000).toISOString()
        : undefined;
      return getKnowledgePageCompilationLog({
        ...diagnosticsScope,
        ...(from ? { from } : {}),
        ...(logStatus ? { statuses: [logStatus] } : {}),
        ...(logSearch.trim() ? { search: logSearch.trim() } : {}),
        page: logPage,
        limit: PAGE_SIZE,
      });
    },
    enabled: activeSection === "log" && diagnosticsScopeReady,
    refetchInterval: knowledgeDiagnosticsRefetchInterval,
    refetchIntervalInBackground: false,
  });
  const delayedPageQuery = useQuery({
    queryKey: [
      "knowledge-delayed-pages",
      allSpacesSelected,
      selectedSpaceIds,
      delayedStatus,
      delayedSearch,
      delayedPage,
    ],
    queryFn: () =>
      getKnowledgeDelayedPageDiagnostics({
        ...diagnosticsScope,
        ...(delayedStatus ? { statuses: [delayedStatus] } : {}),
        ...(delayedSearch.trim() ? { search: delayedSearch.trim() } : {}),
        page: delayedPage,
        limit: PAGE_SIZE,
      }),
    enabled: activeSection === "delayed" && diagnosticsScopeReady,
    refetchInterval: knowledgeDiagnosticsRefetchInterval,
    refetchIntervalInBackground: false,
  });

  const refreshRunViews = () => {
    void runSummaryQuery.refetch();
    void runListQuery.refetch();
    if (selectedRunId) void runPageDetailQuery.refetch();
    if (activeSection === "delayed") void delayedPageQuery.refetch();
    if (activeSection === "log") void pageLogQuery.refetch();
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
  const immediateDelayedPageMutation = useMutation({
    mutationFn: immediatelyCompileDelayedPage,
    retry: false,
    onSuccess: () => {
      setConfirmedDelayedPage(null);
      setDelayedPageConfirmationName("");
      setDelayedPageConfirmationError(null);
      notifications.show({ message: t("Page compilation queued") });
      refreshRunViews();
    },
    onError: (error) => setDelayedPageConfirmationError(error.message),
  });
  const removeDelayedPageMutation = useMutation({
    mutationFn: removeDelayedPageFromQueue,
    retry: false,
    onSuccess: () => {
      notifications.show({ message: t("Page removed from delayed queue") });
      refreshRunViews();
    },
    onError: (error) =>
      notifications.show({ color: "red", message: error.message }),
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
  const logRetryMutation = useMutation({
    mutationFn: retryKnowledgePages,
    onSuccess: (data) => {
      notifications.show({
        message: t("Knowledge page retries queued", {
          count: data.queuedPageCount,
        }),
      });
      void pageLogQuery.refetch();
    },
    onError: (error) =>
      notifications.show({ color: "red", message: error.message }),
  });
  const cancelRunMutation = useMutation({
    mutationFn: cancelKnowledgeCompilationRun,
    retry: false,
    onSuccess: (data) => {
      setConfirmedRunCancellation(null);
      setCancelConfirmationSpaceName("");
      setCancelReason("");
      notifications.show({
        message:
          data.disposition === "already_terminal"
            ? t("Compilation run was already finished")
            : t("Compilation run cancelled"),
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
  const openRunCancellation = (run: KnowledgeRunDiagnostic) => {
    setConfirmedRunCancellation({
      runId: run.runId,
      spaceName: run.spaceName,
    });
    setCancelConfirmationSpaceName("");
    setCancelReason("");
    cancelRunMutation.reset();
  };
  const openImmediateDelayedPageCompilation = (
    target: ConfirmedDelayedPageCompilation,
  ) => {
    setConfirmedDelayedPage(target);
    setDelayedPageConfirmationName("");
    setDelayedPageConfirmationError(null);
    immediateDelayedPageMutation.reset();
  };
  const openDelayedPageRemoval = (target: ConfirmedDelayedPageCompilation) => {
    removeDelayedPageMutation.mutate({
      scheduleId: target.scheduleId,
      confirmationPageName: target.pageName,
    });
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
                loading={
                  runSummaryQuery.isFetching ||
                  runListQuery.isFetching ||
                  delayedPageQuery.isFetching
                }
                disabled={!diagnosticsScopeReady}
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
            opened={confirmedDelayedPage !== null}
            onClose={() => {
              if (!immediateDelayedPageMutation.isPending) {
                setConfirmedDelayedPage(null);
              }
            }}
            title={t("Immediate compile")}
            centered
          >
            {confirmedDelayedPage && (
              <Stack gap="md">
                <Alert color="orange" icon={<IconPlayerPlay size={18} />}>
                  {t(
                    "This page will skip the remaining delay and enter the compilation queue immediately. Later edits will start a new one-hour delay.",
                  )}
                </Alert>
                <Text size="sm">
                  {t("Enter the exact page name to continue:")}{" "}
                  <Text component="span" fw={700}>
                    {confirmedDelayedPage.pageName}
                  </Text>
                </Text>
                <TextInput
                  label={t("Type the page name to confirm")}
                  value={delayedPageConfirmationName}
                  onChange={(event) => {
                    setDelayedPageConfirmationName(event.currentTarget.value);
                    setDelayedPageConfirmationError(null);
                  }}
                  error={delayedPageConfirmationError}
                  data-autofocus
                />
                <Group justify="flex-end">
                  <Button
                    variant="default"
                    disabled={immediateDelayedPageMutation.isPending}
                    onClick={() => setConfirmedDelayedPage(null)}
                  >
                    {t("Cancel")}
                  </Button>
                  <Button
                    color="orange"
                    leftSection={<IconPlayerPlay size={16} />}
                    loading={immediateDelayedPageMutation.isPending}
                    disabled={
                      delayedPageConfirmationName !==
                      confirmedDelayedPage.pageName
                    }
                    onClick={() =>
                      immediateDelayedPageMutation.mutate({
                        scheduleId: confirmedDelayedPage.scheduleId,
                        confirmationPageName: delayedPageConfirmationName,
                      })
                    }
                  >
                    {t("Immediate compile")}
                  </Button>
                </Group>
              </Stack>
            )}
          </Modal>

          <Modal
            opened={confirmedRunCancellation !== null}
            onClose={() => {
              if (!cancelRunMutation.isPending) {
                setConfirmedRunCancellation(null);
              }
            }}
            title={t("Cancel compilation run")}
            centered
          >
            {confirmedRunCancellation && (
              <Stack gap="md">
                <Alert color="orange" icon={<IconPlayerStop size={18} />}>
                  {t(
                    "Remaining compilation work will stop. Knowledge already published by completed pages is retained.",
                  )}
                </Alert>
                <Text size="sm">
                  {t("Enter the exact space name to continue:")}{" "}
                  <Text component="span" fw={700}>
                    {confirmedRunCancellation.spaceName}
                  </Text>
                </Text>
                <TextInput
                  label={t("Type the space name to confirm")}
                  value={cancelConfirmationSpaceName}
                  onChange={(event) =>
                    setCancelConfirmationSpaceName(event.currentTarget.value)
                  }
                  data-autofocus
                />
                <TextInput
                  label={t("Reason (optional)")}
                  value={cancelReason}
                  maxLength={400}
                  onChange={(event) =>
                    setCancelReason(event.currentTarget.value)
                  }
                />
                <Group justify="flex-end">
                  <Button
                    variant="default"
                    disabled={cancelRunMutation.isPending}
                    onClick={() => setConfirmedRunCancellation(null)}
                  >
                    {t("Keep running")}
                  </Button>
                  <Button
                    color="orange"
                    leftSection={<IconPlayerStop size={16} />}
                    loading={cancelRunMutation.isPending}
                    disabled={
                      cancelConfirmationSpaceName !==
                      confirmedRunCancellation.spaceName
                    }
                    onClick={() =>
                      cancelRunMutation.mutate({
                        runId: confirmedRunCancellation.runId,
                        ...(cancelReason.trim()
                          ? { reason: cancelReason.trim() }
                          : {}),
                      })
                    }
                  >
                    {t("Cancel run")}
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
                              disabled={
                                page.status !== "failed" &&
                                page.mergeStatus !== "failed"
                              }
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
              value={spaceSelection}
              onChange={(value) => {
                const includesAll = value.includes(ALL_SPACES_VALUE);
                const wasAll = spaceSelection.includes(ALL_SPACES_VALUE);
                const nextValue =
                  value.length === 0
                    ? [ALL_SPACES_VALUE]
                    : includesAll && value.length > 1
                      ? wasAll
                        ? value.filter((item) => item !== ALL_SPACES_VALUE)
                        : [ALL_SPACES_VALUE]
                      : value;
                setSpaceSelection(nextValue);
                setRunPage(1);
                setDelayedPage(1);
                setQuarantinePage(1);
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

          <Tabs
            value={activeSection}
            onChange={(value) =>
              setActiveSection(
                value === "health" || value === "log" || value === "delayed"
                  ? (value as DiagnosticsSection)
                  : "runs",
              )
            }
          >
            <Tabs.List>
              <Tabs.Tab value="runs">{t("Compilation runs")}</Tabs.Tab>
              <Tabs.Tab value="delayed">{t("Delayed queue")}</Tabs.Tab>
              <Tabs.Tab value="log">{t("Compilation log")}</Tabs.Tab>
              <Tabs.Tab value="health">{t("Health and quarantine")}</Tabs.Tab>
            </Tabs.List>
          </Tabs>

          {activeSection === "delayed" ? (
            <DelayedCompilationQueue
              query={delayedPageQuery}
              status={delayedStatus}
              setStatus={(value) => {
                setDelayedStatus(value);
                setDelayedPage(1);
              }}
              search={delayedSearch}
              setSearch={(value) => {
                setDelayedSearch(value);
                setDelayedPage(1);
              }}
              page={delayedPage}
              setPage={setDelayedPage}
              spaceSlugById={spaceSlugById}
              isAdmin={isAdmin}
              onImmediateCompile={openImmediateDelayedPageCompilation}
              onRemoveFromQueue={openDelayedPageRemoval}
              compilingScheduleId={
                immediateDelayedPageMutation.isPending
                  ? (immediateDelayedPageMutation.variables?.scheduleId ?? null)
                  : null
              }
              removingScheduleId={
                removeDelayedPageMutation.isPending
                  ? (removeDelayedPageMutation.variables?.scheduleId ?? null)
                  : null
              }
            />
          ) : activeSection === "log" ? (
            <PageCompilationLog
              query={pageLogQuery}
              range={logRange}
              setRange={(value) => {
                setLogRange(value);
                setLogPage(1);
              }}
              status={logStatus}
              setStatus={(value) => {
                setLogStatus(value);
                setLogPage(1);
              }}
              search={logSearch}
              setSearch={(value) => {
                setLogSearch(value);
                setLogPage(1);
              }}
              page={logPage}
              setPage={setLogPage}
              spaceSlugById={spaceSlugById}
              isAdmin={isAdmin}
              onRetry={(pageId) =>
                logRetryMutation.mutate({ pageIds: [pageId] })
              }
              retryingPageId={
                logRetryMutation.isPending
                  ? (logRetryMutation.variables?.pageIds[0] ?? null)
                  : null
              }
            />
          ) : activeSection === "runs" ? (
            <>
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
                  <Metric
                    label={t("Space dispatch pending")}
                    value={runSummary?.dispatch.spaceUnacknowledged ?? 0}
                  />
                  <Metric
                    label={t("Image dispatch pending")}
                    value={runSummary?.dispatch.imageUnacknowledged ?? 0}
                  />
                  {isOwner && (
                    <>
                      <Metric
                        label={t("Estimated space capacity")}
                        value={workerQuery.data?.space.capacity ?? t("Unknown")}
                      />
                      <Metric
                        label={t("Estimated image capacity")}
                        value={workerQuery.data?.image.capacity ?? t("Unknown")}
                      />
                    </>
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
                  {(runSummary?.workerEvents.lockRenewalFailed ?? 0) > 0 && (
                    <Badge color="orange" variant="outline">
                      {t("Lock renewal failed")}:{" "}
                      {runSummary?.workerEvents.lockRenewalFailed ?? 0}
                    </Badge>
                  )}
                  {(runSummary?.workerEvents.stalled ?? 0) > 0 && (
                    <Badge color="red" variant="outline">
                      {t("Stalled")}: {runSummary?.workerEvents.stalled ?? 0}
                    </Badge>
                  )}
                  {Object.entries({
                    [t("Expired leases")]:
                      runSummary?.recovery.expiredExecutionLeases ?? 0,
                    [t("Space recovering")]:
                      runSummary?.recovery.spaceRecovering ?? 0,
                    [t("Space recovery exhausted")]:
                      runSummary?.recovery.spaceRecoveryExhausted ?? 0,
                    [t("Image recovering")]:
                      runSummary?.recovery.imageRecovering ?? 0,
                    [t("Image recovery exhausted")]:
                      runSummary?.recovery.imageRecoveryExhausted ?? 0,
                  }).map(([label, count]) =>
                    count > 0 ? (
                      <Badge key={label} color="orange" variant="outline">
                        {label}: {count}
                      </Badge>
                    ) : null,
                  )}
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
                    data={[
                      { value: "active", label: t("Active runs") },
                      ...RUN_STATUS_OPTIONS,
                    ]}
                    value={runStatus}
                    onChange={(value) => {
                      setRunStatus(value as RunStatusFilter | null);
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
                        <Table.Th>{t("Compiled at")}</Table.Th>
                        <Table.Th>{t("Worker")}</Table.Th>
                        <Table.Th>{t("Details")}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {runs.length === 0 ? (
                        <Table.Tr>
                          <Table.Td colSpan={11}>
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
                            onCancel={
                              isAdmin &&
                              ACTIVE_RUN_STATUSES.includes(run.status)
                                ? () => openRunCancellation(run)
                                : undefined
                            }
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
                {selectedSpaces.length === 0 ? (
                  <Alert color="blue" icon={<IconInfoCircle size={18} />}>
                    {t("Select a space")}
                  </Alert>
                ) : (
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
                                    openCompilation(
                                      "update",
                                      space.id,
                                      space.name,
                                    )
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
                                    openCompilation(
                                      "force",
                                      space.id,
                                      space.name,
                                    )
                                  }
                                />
                              </Group>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                )}
              </section>
            </>
          ) : (
            <HealthDiagnostics
              qualityQuery={qualityQuery}
              quarantineQuery={quarantineQuery}
              retrievalQuery={retrievalQuery}
              quarantinePage={quarantinePage}
              setQuarantinePage={setQuarantinePage}
              isOwner={isOwner}
            />
          )}
        </Stack>
      </Container>
    </>
  );
}

function DelayedCompilationQueue({
  query,
  status,
  setStatus,
  search,
  setSearch,
  page,
  setPage,
  spaceSlugById,
  isAdmin,
  onImmediateCompile,
  onRemoveFromQueue,
  compilingScheduleId,
  removingScheduleId,
}: {
  query: UseQueryResult<KnowledgeDelayedPageDiagnosticsPage, Error>;
  status: KnowledgeDelayedPageStatus | null;
  setStatus: (value: KnowledgeDelayedPageStatus | null) => void;
  search: string;
  setSearch: (value: string) => void;
  page: number;
  setPage: (value: number) => void;
  spaceSlugById: Map<string, string>;
  isAdmin: boolean;
  onImmediateCompile: (target: ConfirmedDelayedPageCompilation) => void;
  onRemoveFromQueue: (target: ConfirmedDelayedPageCompilation) => void;
  compilingScheduleId: string | null;
  removingScheduleId: string | null;
}) {
  const { t } = useTranslation();
  const data = query.data;
  const items = data?.items ?? [];
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <section className={classes.panel}>
      <Group justify="space-between" mb="md">
        <div>
          <Title order={2} size="h5">
            {t("Delayed compilation queue")}
          </Title>
          <Text size="sm" c="dimmed">
            {t(
              "Automatic page creates and updates compile after one hour without further edits. Manual and force compilation remain immediate.",
            )}
          </Text>
        </div>
        {query.isFetching && <Loader size="sm" />}
      </Group>

      <div className={classes.metricGrid}>
        <Metric
          label={t("Waiting pages")}
          value={data?.summary.waitingPageCount ?? 0}
        />
        <Metric
          label={t("Ready for dispatch")}
          value={data?.summary.duePageCount ?? 0}
        />
        <Metric
          label={t("Affected spaces")}
          value={data?.summary.affectedSpaceCount ?? 0}
        />
        <Metric
          label={t("Next eligible")}
          value={formatDate(data?.summary.nextEligibleAt ?? null)}
        />
      </div>

      <Group gap="sm" my="md" align="flex-end">
        <Select
          label={t("Status")}
          data={[
            { value: "waiting", label: t("Waiting") },
            { value: "due", label: t("Ready for dispatch") },
          ]}
          value={status}
          onChange={(value) =>
            setStatus(value as KnowledgeDelayedPageStatus | null)
          }
          placeholder={t("All statuses")}
          clearable
          w={160}
        />
        <TextInput
          label={t("Search page or space")}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder={t("Title, slug, or space")}
          w={280}
        />
      </Group>

      {query.isError && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {query.error.message}
        </Alert>
      )}
      {query.isLoading ? (
        <Loader size="sm" />
      ) : items.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("No pages are waiting for delayed compilation.")}
        </Text>
      ) : (
        <>
          <Table.ScrollContainer minWidth={isAdmin ? 1280 : 1080}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("Page")}</Table.Th>
                  <Table.Th>{t("Space")}</Table.Th>
                  <Table.Th>{t("Status")}</Table.Th>
                  <Table.Th>{t("Trigger")}</Table.Th>
                  <Table.Th>{t("Changes")}</Table.Th>
                  <Table.Th>{t("Last changed")}</Table.Th>
                  <Table.Th>{t("Eligible at")}</Table.Th>
                  <Table.Th>{t("Remaining")}</Table.Th>
                  {isAdmin && <Table.Th>{t("Actions")}</Table.Th>}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((item) => {
                  const spaceSlug = spaceSlugById.get(item.spaceId);
                  const pageUrl = spaceSlug
                    ? buildPageUrl(spaceSlug, item.slugId, item.title)
                    : null;
                  return (
                    <Table.Tr key={item.scheduleId}>
                      <Table.Td>
                        {pageUrl ? (
                          <Text
                            component={Link}
                            to={pageUrl}
                            size="sm"
                            c="blue"
                            style={{ textDecoration: "none" }}
                          >
                            {item.title || item.slugId || item.sourcePageId}
                          </Text>
                        ) : (
                          <Text size="sm">
                            {item.title || item.slugId || item.sourcePageId}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>{item.spaceName}</Table.Td>
                      <Table.Td>
                        <StateBadge
                          value={
                            item.status === "due"
                              ? "ready_for_dispatch"
                              : "waiting"
                          }
                          label={
                            item.status === "due"
                              ? t("Ready for dispatch")
                              : t("Waiting")
                          }
                        />
                      </Table.Td>
                      <Table.Td>{humanizeState(item.trigger)}</Table.Td>
                      <Table.Td>{item.changeCount}</Table.Td>
                      <Table.Td>{formatDate(item.lastChangedAt)}</Table.Td>
                      <Table.Td>{formatDate(item.eligibleAt)}</Table.Td>
                      <Table.Td>
                        {item.status === "due"
                          ? t("Awaiting dispatch")
                          : formatDuration(item.remainingWaitMs)}
                      </Table.Td>
                      {isAdmin && (
                        <Table.Td>
                          <Group gap="xs" wrap="nowrap">
                            <Button
                              size="xs"
                              variant="light"
                              color="orange"
                              leftSection={<IconPlayerPlay size={14} />}
                              loading={compilingScheduleId === item.scheduleId}
                              disabled={removingScheduleId === item.scheduleId}
                              onClick={() =>
                                onImmediateCompile({
                                  scheduleId: item.scheduleId,
                                  pageName:
                                    item.title ||
                                    item.slugId ||
                                    item.sourcePageId,
                                })
                              }
                            >
                              {t("Immediate compile")}
                            </Button>
                            <ActionIcon
                              size="lg"
                              variant="light"
                              color="red"
                              aria-label={t("Remove from queue")}
                              title={t("Remove from queue")}
                              loading={removingScheduleId === item.scheduleId}
                              disabled={compilingScheduleId === item.scheduleId}
                              onClick={() =>
                                onRemoveFromQueue({
                                  scheduleId: item.scheduleId,
                                  pageName:
                                    item.title ||
                                    item.slugId ||
                                    item.sourcePageId,
                                })
                              }
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Group>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Group justify="space-between" mt="md">
            <Text size="sm" c="dimmed">
              {t("Scheduled pages")}: {data?.total ?? 0}
            </Text>
            {pageCount > 1 && (
              <Pagination value={page} onChange={setPage} total={pageCount} />
            )}
          </Group>
        </>
      )}
    </section>
  );
}

function PageCompilationLog({
  query,
  range,
  setRange,
  status,
  setStatus,
  search,
  setSearch,
  page,
  setPage,
  spaceSlugById,
  isAdmin,
  onRetry,
  retryingPageId,
}: {
  query: UseQueryResult<
    { items: KnowledgePageLogItem[]; total: number },
    Error
  >;
  range: PageLogRange;
  setRange: (value: PageLogRange) => void;
  status: string | null;
  setStatus: (value: string | null) => void;
  search: string;
  setSearch: (value: string) => void;
  page: number;
  setPage: (value: number) => void;
  spaceSlugById: Map<string, string>;
  isAdmin: boolean;
  onRetry: (pageId: string) => void;
  retryingPageId: string | null;
}) {
  const { t } = useTranslation();
  const items = query.data?.items ?? [];
  const pageCount = Math.max(
    1,
    Math.ceil((query.data?.total ?? 0) / PAGE_SIZE),
  );
  const rangeOptions = [
    { value: "1h", label: t("Last hour") },
    { value: "24h", label: t("Last 24 hours") },
    { value: "7d", label: t("Last 7 days") },
    { value: "30d", label: t("Last 30 days") },
    { value: "all", label: t("All time") },
  ];

  return (
    <section className={classes.panel}>
      <Group justify="space-between" mb="md">
        <Title order={2} size="h5">
          {t("Compilation log")}
        </Title>
        <Text size="xs" c="dimmed">
          {t("Most recent compilation per page")}
        </Text>
      </Group>
      <Group gap="sm" mb="md" align="flex-end">
        <Select
          label={t("Time range")}
          data={rangeOptions}
          value={range}
          onChange={(value) => setRange((value as PageLogRange) ?? "24h")}
          allowDeselect={false}
          w={160}
        />
        <Select
          label={t("Status")}
          data={PAGE_LOG_STATUS_OPTIONS}
          value={status}
          onChange={setStatus}
          placeholder={t("All statuses")}
          clearable
          w={160}
        />
        <TextInput
          label={t("Search page")}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder={t("Title or slug")}
          w={240}
        />
      </Group>
      {query.isError && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {query.error.message}
        </Alert>
      )}
      {query.isLoading ? (
        <Loader size="sm" />
      ) : items.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("No compiled pages found in this range.")}
        </Text>
      ) : (
        <>
          <Table.ScrollContainer minWidth={isAdmin ? 1020 : 900}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("Page")}</Table.Th>
                  <Table.Th>{t("Space")}</Table.Th>
                  <Table.Th>{t("Status")}</Table.Th>
                  <Table.Th>{t("Images")}</Table.Th>
                  <Table.Th>{t("Last compiled")}</Table.Th>
                  <Table.Th>{t("Duration")}</Table.Th>
                  <Table.Th>{t("Error")}</Table.Th>
                  {isAdmin && <Table.Th>{t("Actions")}</Table.Th>}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((item) => (
                  <PageLogRow
                    key={item.runPageId}
                    item={item}
                    spaceSlug={spaceSlugById.get(item.spaceId)}
                    isAdmin={isAdmin}
                    onRetry={onRetry}
                    retrying={retryingPageId === item.sourcePageId}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Group justify="flex-end" mt="md">
            <Pagination value={page} onChange={setPage} total={pageCount} />
          </Group>
        </>
      )}
    </section>
  );
}

function PageLogRow({
  item,
  spaceSlug,
  isAdmin,
  onRetry,
  retrying,
}: {
  item: KnowledgePageLogItem;
  spaceSlug: string | undefined;
  isAdmin: boolean;
  onRetry: (pageId: string) => void;
  retrying: boolean;
}) {
  const { t } = useTranslation();
  const imageSummary =
    item.expectedImageCount > 0
      ? item.failedImageCount > 0
        ? t("{{succeeded}}/{{expected}} · {{failed}} failed", {
            succeeded: item.succeededImageCount,
            expected: item.expectedImageCount,
            failed: item.failedImageCount,
          })
        : `${item.succeededImageCount}/${item.expectedImageCount}`
      : "-";
  const pageUrl =
    spaceSlug && item.slugId
      ? buildPageUrl(spaceSlug, item.slugId, item.title)
      : null;

  return (
    <Table.Tr>
      <Table.Td>
        {pageUrl ? (
          <Text
            component={Link}
            to={pageUrl}
            size="sm"
            c="blue"
            style={{ textDecoration: "none" }}
          >
            {item.title || item.slugId || item.sourcePageId}
          </Text>
        ) : (
          <Text size="sm">
            {item.title || item.slugId || item.sourcePageId}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm">{item.spaceName}</Text>
      </Table.Td>
      <Table.Td>
        <StateBadge value={item.status} />
      </Table.Td>
      <Table.Td>
        <Text size="sm" c={item.failedImageCount > 0 ? "red" : undefined}>
          {imageSummary}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{formatDate(item.lastCompiledAt)}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{formatDuration(item.durationMs)}</Text>
      </Table.Td>
      <Table.Td>
        {item.errorCode ? (
          <Text size="xs" c="red">
            {item.errorDetail ?? item.errorSummary ?? item.errorCode}
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            -
          </Text>
        )}
      </Table.Td>
      {isAdmin && (
        <Table.Td>
          {item.status === "failed" ? (
            <Button
              size="xs"
              variant="light"
              leftSection={<IconRefresh size={14} />}
              loading={retrying}
              onClick={() => onRetry(item.sourcePageId)}
            >
              {t("Retry")}
            </Button>
          ) : (
            <Text size="xs" c="dimmed">
              -
            </Text>
          )}
        </Table.Td>
      )}
    </Table.Tr>
  );
}

function HealthDiagnostics({
  qualityQuery,
  quarantineQuery,
  retrievalQuery,
  quarantinePage,
  setQuarantinePage,
  isOwner,
}: {
  qualityQuery: UseQueryResult<KnowledgeQualityReport, Error>;
  quarantineQuery: UseQueryResult<KnowledgeQuarantineDiagnosticsPage, Error>;
  retrievalQuery: UseQueryResult<KnowledgeRetrievalDiagnosticsSummary, Error>;
  quarantinePage: number;
  setQuarantinePage: (page: number) => void;
  isOwner: boolean;
}) {
  const { t } = useTranslation();
  const quality = qualityQuery.data;
  const quarantine = quarantineQuery.data;
  const retrieval = retrievalQuery.data;
  const quarantinePageCount = Math.max(
    1,
    Math.ceil((quarantine?.total ?? 0) / 20),
  );
  const error =
    qualityQuery.error ?? quarantineQuery.error ?? retrievalQuery.error;

  return (
    <Stack gap="lg">
      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {error.message}
        </Alert>
      )}
      <section className={classes.panel}>
        <Group justify="space-between" mb="md">
          <div>
            <Title order={2} size="h4">
              {t("Knowledge health")}
            </Title>
            <Text size="sm" c="dimmed">
              {t(
                "Loaded on demand from database aggregates; compilation polling does not refresh this report.",
              )}
            </Text>
          </div>
          {qualityQuery.isFetching ? (
            <Loader size="sm" />
          ) : quality ? (
            <Badge
              color={healthColor(quality.summary.healthScore)}
              variant="light"
              size="lg"
            >
              {quality.summary.healthScore}
            </Badge>
          ) : null}
        </Group>

        {quality && (
          <>
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

            {isOwner && retrieval && (
              <Group gap="xs" mt="md">
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
              </Group>
            )}

            {quality.topIssues.length > 0 && (
              <Stack gap="xs" mt="md">
                {quality.topIssues.map((issue) => (
                  <Group key={issue.code} justify="space-between" gap="md">
                    <Group gap="xs">
                      <Badge color={issueColor(issue.severity)} variant="light">
                        {issue.severity}
                      </Badge>
                      <Text size="sm">{issue.message}</Text>
                    </Group>
                    <Badge variant="outline">{issue.affectedPageCount}</Badge>
                  </Group>
                ))}
              </Stack>
            )}

            <Table.ScrollContainer minWidth={820}>
              <Table mt="md" highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("Space")}</Table.Th>
                    <Table.Th>{t("Health")}</Table.Th>
                    <Table.Th>{t("Pages")}</Table.Th>
                    <Table.Th>{t("Compiled")}</Table.Th>
                    <Table.Th>{t("Stale")}</Table.Th>
                    <Table.Th>{t("Missing chunks")}</Table.Th>
                    <Table.Th>{t("Missing embeddings")}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {quality.spaces.map((space) => (
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
                      <Table.Td>{space.pageCount}</Table.Td>
                      <Table.Td>{space.compiledPageCount}</Table.Td>
                      <Table.Td>
                        {space.stalePageCount}
                        {space.oldestStaleSourceAgeHours !== null
                          ? ` · ${space.oldestStaleSourceAgeHours}h`
                          : ""}
                      </Table.Td>
                      <Table.Td>{space.missingChunkPageCount}</Table.Td>
                      <Table.Td>{space.missingEmbeddingPageCount}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </>
        )}
      </section>

      {isOwner && (
        <section className={classes.panel}>
          <Group justify="space-between" mb="md">
            <Title order={2} size="h4">
              {t("Quarantine")}
            </Title>
            {quarantineQuery.isFetching ? (
              <Loader size="sm" />
            ) : (
              <Badge variant="light">{quarantine?.total ?? 0}</Badge>
            )}
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
                {(quarantine?.items ?? []).length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Text className={classes.emptyText}>
                        {t("No quarantined artifacts")}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  quarantine?.items.map((item) => (
                    <Table.Tr key={item.id}>
                      <Table.Td>
                        <Text className={classes.mono}>
                          {item.artifactId ?? item.id}
                        </Text>
                      </Table.Td>
                      <Table.Td>{item.artifactKind ?? "-"}</Table.Td>
                      <Table.Td>{item.reasonCodes.join(", ")}</Table.Td>
                      <Table.Td>{item.compilerRunId ?? "-"}</Table.Td>
                      <Table.Td>{formatDate(item.createdAt)}</Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {quarantinePageCount > 1 && (
            <Pagination
              mt="md"
              value={quarantinePage}
              onChange={setQuarantinePage}
              total={quarantinePageCount}
            />
          )}
        </section>
      )}
    </Stack>
  );
}

function RunRow({
  run,
  onViewPages,
  onCancel,
}: {
  run: KnowledgeRunDiagnostic;
  onViewPages: () => void;
  onCancel?: () => void;
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
      <Table.Td>
        <ProgressCell progress={run.progress.text} />
      </Table.Td>
      <Table.Td>
        <ProgressCell progress={run.progress.images} />
      </Table.Td>
      <Table.Td>
        <ProgressCell progress={run.progress.merge} />
      </Table.Td>
      <Table.Td>{formatDuration(run.currentSliceWaitMs)}</Table.Td>
      <Table.Td>{formatDuration(run.runDurationMs)}</Table.Td>
      <Table.Td>
        <Text size="sm">
          {formatDate(run.startedAt ?? run.queuedAt ?? run.createdAt)}
        </Text>
      </Table.Td>
      <Table.Td>{run.workerId ?? "-"}</Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          <Button size="xs" variant="subtle" onClick={onViewPages}>
            {t("View pages")}
          </Button>
          {onCancel && (
            <Button
              size="xs"
              color="orange"
              variant="subtle"
              leftSection={<IconPlayerStop size={14} />}
              onClick={onCancel}
            >
              {t("Cancel run")}
            </Button>
          )}
        </Group>
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

function StateBadge({ value, label }: { value: string; label?: string }) {
  const color =
    value === "cancelled" || value === "superseded"
      ? "gray"
      : value === "failed" || value === "provider" || value === "publication"
        ? "red"
        : value === "partial" ||
            value === "budget_timeout" ||
            value === "due" ||
            value === "ready_for_dispatch"
          ? "orange"
          : value === "succeeded" || value === "complete"
            ? "green"
            : "blue";
  return (
    <Badge color={color} variant="light">
      {label ?? humanizeState(value)}
    </Badge>
  );
}

function ProgressCell({
  progress,
}: {
  progress: {
    expected: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
}) {
  const { t } = useTranslation();
  const completed = progress.succeeded + progress.failed + progress.skipped;
  return (
    <Stack gap={0}>
      <Text size="sm" fw={500}>
        {completed}/{progress.expected}
      </Text>
      <Text size="xs" c="dimmed">
        {t("Succeeded")} {progress.succeeded} · {t("Failed")} {progress.failed}{" "}
        · {t("Skipped")} {progress.skipped}
      </Text>
    </Stack>
  );
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

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function healthColor(score: number): string {
  return score >= 90 ? "green" : score >= 70 ? "yellow" : "red";
}

function issueColor(severity: "high" | "medium" | "low"): string {
  return severity === "high"
    ? "red"
    : severity === "medium"
      ? "yellow"
      : "blue";
}

function humanizeState(value: string): string {
  return value.replace(/_/g, " ");
}
