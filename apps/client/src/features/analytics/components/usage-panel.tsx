import { useState } from "react";
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  CopyButton,
  Drawer,
  Group,
  Loader,
  Pagination,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { BarChart } from "@mantine/charts";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconInfoCircle,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  useAnalyticsUsageEventsQuery,
  useAnalyticsUsageQuery,
} from "../queries/analytics-query";
import {
  AnalyticsDateFilter,
  AnalyticsUsageFilter,
  AnalyticsUsageOverview,
  AnalyticsUsageRow,
  UsageGroup,
} from "../types/analytics.types";
import { StatCard } from "./stat-card";

function timestamp(value: string | null) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "—";
}

function Identifier({ value }: { value: string }) {
  const { t } = useTranslation();
  if (value === "__none__") return null;
  return (
    <Group gap={4} wrap="nowrap">
      <Text
        size="xs"
        c="dimmed"
        ff="monospace"
        style={{ overflowWrap: "anywhere" }}
      >
        {value}
      </Text>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={t(copied ? "Copied" : "Copy ID")}>
            <ActionIcon
              size="xs"
              variant="subtle"
              onClick={(event) => {
                event.stopPropagation();
                copy();
              }}
              aria-label={t("Copy ID")}
            >
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

function ResultBadge({ outcome }: { outcome: string }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="light"
      color={outcome === "error" ? "red" : outcome === "ok" ? "teal" : "gray"}
    >
      {t(
        outcome === "error"
          ? "Failed"
          : outcome === "ok"
            ? "Succeeded"
            : "Result unknown",
      )}
    </Badge>
  );
}

function UsageCharts({
  data,
  compact = false,
}: {
  data: AnalyticsUsageOverview;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const hourly = data.daily.some((row) => row.date.includes(" "));
  return (
    <SimpleGrid cols={{ base: 1, md: compact ? 1 : 2 }}>
      <Paper withBorder radius="md" p="md">
        <Text size="sm" fw={600} mb="md">
          {t("Call trend")}
        </Text>
        <BarChart
          h={200}
          data={data.daily.map((row) => ({
            ...row,
            label: hourly ? row.date.slice(11) : row.date.slice(5),
          }))}
          dataKey="label"
          type="stacked"
          withLegend
          series={[
            { name: "api", label: "API", color: "cyan.5" },
            { name: "mcp", label: "MCP", color: "violet.6" },
          ]}
        />
      </Paper>
      <Paper withBorder radius="md" p="md">
        <Text size="sm" fw={600} mb="md">
          {t("Operations by endpoint")}
        </Text>
        {data.byOp.length ? (
          <BarChart
            h={Math.max(160, Math.min(data.byOp.length, 8) * 28)}
            orientation="vertical"
            yAxisProps={{ width: compact ? 170 : 150 }}
            data={data.byOp.slice(0, 8)}
            dataKey="op"
            series={[{ name: "count", label: t("Calls"), color: "violet.6" }]}
          />
        ) : (
          <Text size="sm" c="dimmed">
            {t("No data in this range")}
          </Text>
        )}
        {data.byOp.length > 8 && (
          <Text size="xs" c="dimmed" mt="xs">
            {t("Showing the top 8 endpoints")}
          </Text>
        )}
      </Paper>
    </SimpleGrid>
  );
}

function UsageDetail({
  row,
  filter,
  onClose,
}: {
  row: AnalyticsUsageRow | null;
  filter: AnalyticsUsageFilter;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const params = { ...filter, entityId: row?.id, page: 1 };
  const overview = useAnalyticsUsageQuery(params, !!row);
  const events = useAnalyticsUsageEventsQuery(
    { ...params, page, limit: 20 },
    !!row,
  );
  const name =
    row?.name ||
    row?.email ||
    t(
      row?.id === "__none__"
        ? filter.groupBy === "key"
          ? "No API key"
          : "No associated user"
        : "Unnamed",
    );
  return (
    <Drawer
      opened={!!row}
      onClose={onClose}
      position="right"
      size="xl"
      title={t("Call details")}
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      {row && (
        <Stack gap="lg">
          <Stack gap={4}>
            <Text fw={600} size="lg">
              {name}
            </Text>
            <Identifier value={row.id} />
            {row.email && (
              <Text size="sm" c="dimmed">
                {row.email}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              {t(
                "Details follow the current time range and filters. Times are in Asia/Shanghai.",
              )}
            </Text>
          </Stack>
          {overview.isLoading && <Loader size="sm" />}
          {overview.isError && (
            <Alert color="red">{t("Failed to load analytics")}</Alert>
          )}
          {overview.data && (
            <>
              <SimpleGrid cols={3}>
                <StatCard
                  label={t("Total calls")}
                  value={overview.data.summary.ops}
                />
                <StatCard
                  label={t("Failed API calls")}
                  value={overview.data.summary.failedOps}
                />
                <StatCard
                  label={t("Result unknown")}
                  value={overview.data.summary.unknownOps}
                />
              </SimpleGrid>
              <UsageCharts data={overview.data} compact />
            </>
          )}
          <Text fw={600}>{t("Individual calls")}</Text>
          {events.isLoading && <Loader size="sm" />}
          {events.isError && (
            <Alert color="red">{t("Failed to load analytics")}</Alert>
          )}
          {events.data && (
            <>
              <Text size="sm" c="dimmed">
                {t("{{total}} calls", {
                  total: events.data.total.toLocaleString(),
                })}
              </Text>
              <Table.ScrollContainer minWidth={650}>
                <Table verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t("Time / endpoint")}</Table.Th>
                      <Table.Th>{t("Caller / key")}</Table.Th>
                      <Table.Th>{t("Result")}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {events.data.items.map((event) => (
                      <Table.Tr key={event.id}>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {timestamp(event.createdAt)}
                          </Text>
                          <Text
                            size="sm"
                            ff="monospace"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {event.op}
                          </Text>
                          <Badge size="xs" variant="outline" mt={4}>
                            {event.channel?.toUpperCase()}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">
                            {event.actorName ||
                              event.actorEmail ||
                              event.actorId ||
                              t("Unknown")}
                          </Text>
                          {event.userId && event.userId !== event.actorId && (
                            <Text size="xs" c="dimmed">
                              {t("Delegated user")}:{" "}
                              {event.userName ||
                                event.userEmail ||
                                event.userId}
                            </Text>
                          )}
                          <Text size="xs" mt={4}>
                            {event.keyName ||
                              (event.keyId
                                ? t("Unnamed key")
                                : t("No API key"))}
                          </Text>
                          {event.keyId && <Identifier value={event.keyId} />}
                        </Table.Td>
                        <Table.Td>
                          <ResultBadge outcome={event.outcome} />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                    {!events.data.items.length && (
                      <Table.Tr>
                        <Table.Td colSpan={3}>
                          <Text ta="center" c="dimmed" py="lg">
                            {t("No matching calls")}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
              {events.data.total > 20 && (
                <Pagination
                  value={page}
                  onChange={setPage}
                  total={Math.ceil(events.data.total / 20)}
                  size="sm"
                />
              )}
            </>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

export function UsagePanel({
  dates,
  enabled,
}: {
  dates: AnalyticsDateFilter;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const [groupBy, setGroupBy] = useState<UsageGroup>("key");
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [filters, setFilters] = useState<{
    keyType?: string;
    channel?: string;
    outcome?: string;
    op?: string;
  }>({});
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<AnalyticsUsageFilter["sort"]>("ops");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<AnalyticsUsageRow | null>(null);
  const scope = JSON.stringify([
    dates.range,
    dates.from,
    dates.to,
    groupBy,
    debouncedSearch,
    filters,
  ]);
  const [previousScope, setPreviousScope] = useState(scope);
  // Reset before the query renders, so a changed filter never requests an old page.
  if (previousScope !== scope) {
    setPreviousScope(scope);
    setPage(1);
    setSelected(null);
  }
  if (!enabled && selected) setSelected(null);
  const filter: AnalyticsUsageFilter = {
    ...dates,
    ...filters,
    groupBy,
    search: debouncedSearch || undefined,
    sort,
    direction,
    page,
    limit: 20,
  };
  const query = useAnalyticsUsageQuery(filter, enabled);
  const { data } = query;
  const knownOps = Array.from(
    new Set([
      ...(data?.byOp.map((row) => row.op) ?? []),
      ...(filters.op ? [filters.op] : []),
    ]),
  ).sort();
  const changeFilter = (key: keyof typeof filters, value: string | null) => {
    setPage(1);
    setFilters((previous) => ({ ...previous, [key]: value || undefined }));
  };
  const changeSort = (key: typeof sort) => {
    setPage(1);
    setSort(key);
    setDirection(sort === key && direction === "desc" ? "asc" : "desc");
  };
  const sortLabel = (key: typeof sort, label: string) => (
    <UnstyledButton
      onClick={() => changeSort(key)}
      aria-label={t("Sort by {{column}}", { column: label })}
    >
      <Group gap={4} wrap="nowrap">
        <Text size="sm" fw={600}>
          {label}
        </Text>
        {sort === key &&
          (direction === "desc" ? (
            <IconArrowDown size={14} />
          ) : (
            <IconArrowUp size={14} />
          ))}
      </Group>
    </UnstyledButton>
  );
  const label = (row: AnalyticsUsageRow) =>
    row.name ||
    row.email ||
    t(
      row.id === "__none__"
        ? groupBy === "key"
          ? "No API key"
          : "No associated user"
        : "Unnamed",
    );

  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        {t(
          "Explore calls by agent, user or API key. All statistics follow the filters below.",
        )}
      </Text>
      <Paper withBorder p="md" radius="md">
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          <TextInput
            label={t("Search caller or key")}
            placeholder={t("Name, email or ID")}
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(event) => {
              setPage(1);
              setSearch(event.currentTarget.value);
            }}
          />
          <Select
            label={t("Credential type")}
            placeholder={t("All types")}
            clearable
            value={filters.keyType ?? null}
            onChange={(value) => changeFilter("keyType", value)}
            data={[
              { value: "agent", label: t("Agent key") },
              { value: "personal", label: t("Personal key") },
              { value: "sso", label: "SSO" },
              { value: "unknown", label: t("Unknown") },
            ]}
          />
          <Select
            label={t("Channel")}
            placeholder={t("All channels")}
            clearable
            value={filters.channel ?? null}
            onChange={(value) => changeFilter("channel", value)}
            data={[
              { value: "api", label: "API" },
              { value: "mcp", label: "MCP" },
            ]}
          />
          <Select
            label={t("Result")}
            placeholder={t("All results")}
            clearable
            value={filters.outcome ?? null}
            onChange={(value) => changeFilter("outcome", value)}
            data={[
              { value: "ok", label: t("Succeeded") },
              { value: "error", label: t("Failed") },
              { value: "called", label: t("Result unknown") },
            ]}
          />
          <Select
            label={t("Endpoint / tool")}
            placeholder={t("All endpoints")}
            searchable
            clearable
            value={filters.op ?? null}
            onChange={(value) => changeFilter("op", value)}
            data={knownOps}
          />
          <Group align="end" h="100%">
            <Button
              variant="subtle"
              onClick={() => {
                setSearch("");
                setFilters({});
                setPage(1);
              }}
            >
              {t("Clear filters")}
            </Button>
          </Group>
        </SimpleGrid>
      </Paper>
      <Alert variant="light" icon={<IconInfoCircle size={16} />}>
        {t(
          "MCP records tool calls; execution results are unknown. REST statistics include authenticated API-key calls; authentication rejections are excluded.",
        )}
      </Alert>
      <Group justify="space-between" gap="sm">
        <Group gap="xs">
          {(
            [
              ["agent", "By agent"],
              ["user", "By user"],
              ["key", "By key"],
            ] as const
          ).map(([value, text]) => (
            <Button
              key={value}
              size="xs"
              variant={groupBy === value ? "filled" : "light"}
              onClick={() => {
                setPage(1);
                setGroupBy(value);
              }}
            >
              {t(text)}
            </Button>
          ))}
        </Group>
        <Group gap="xs">
          {data && (
            <Text size="xs" c="dimmed">
              {t("Updated at {{time}}", { time: timestamp(data.updatedAt) })}
            </Text>
          )}
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} />}
            loading={query.isFetching}
            disabled={!enabled}
            onClick={() => query.refetch()}
          >
            {t("Refresh")}
          </Button>
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        {t(
          groupBy === "agent"
            ? "Agent view includes agent-key calls only."
            : groupBy === "user"
              ? "Users are direct callers or delegated users. Agent calls without a delegated user are grouped as unassociated."
              : "SSO calls without an API key are grouped separately. Revoked keys retain their call history.",
        )}
      </Text>
      {query.isLoading && (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      )}
      {query.isError && (
        <Alert color="red">{t("Failed to load analytics")}</Alert>
      )}
      {data && (
        <>
          <SimpleGrid cols={{ base: 2, lg: 4 }}>
            <StatCard
              label={t("Total calls")}
              value={data.summary.ops}
              hint={`API ${data.summary.api.toLocaleString()} / MCP ${data.summary.mcp.toLocaleString()}`}
            />
            <StatCard
              label={t("Active agents")}
              value={data.summary.activeAgents}
            />
            <StatCard
              label={t("Active keys")}
              value={data.summary.activeKeys}
              hint={t("{{count}} active users", {
                count: data.summary.activeUsers,
              })}
            />
            <StatCard
              label={t("Failed API calls")}
              value={data.summary.failedOps}
              hint={t("{{count}} calls with unknown results", {
                count: data.summary.unknownOps,
              })}
            />
          </SimpleGrid>
          <Accordion variant="separated">
            <Accordion.Item value="charts">
              <Accordion.Control>
                {t("Call trend and endpoint breakdown")}
              </Accordion.Control>
              <Accordion.Panel>
                <UsageCharts data={data} />
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <Paper withBorder p="md" radius="md">
            <Group justify="space-between" mb="sm">
              <Text fw={600}>
                {t(
                  groupBy === "agent"
                    ? "Agent activity"
                    : groupBy === "user"
                      ? "User call statistics"
                      : "API key call statistics",
                )}
              </Text>
              <Text size="sm" c="dimmed">
                {t("{{total}} results", { total: data.total.toLocaleString() })}
              </Text>
            </Group>
            <Table.ScrollContainer minWidth={1000}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={300}>
                      {t(
                        groupBy === "agent"
                          ? "Agent"
                          : groupBy === "user"
                            ? "User"
                            : "API key",
                      )}
                    </Table.Th>
                    <Table.Th>
                      {t(groupBy === "key" ? "Caller / creator" : "Keys used")}
                    </Table.Th>
                    <Table.Th ta="right">
                      {sortLabel("ops", t("Calls"))}
                    </Table.Th>
                    <Table.Th ta="right">API / MCP</Table.Th>
                    <Table.Th ta="right">
                      {sortLabel("failedOps", t("Failed API calls"))}
                    </Table.Th>
                    <Table.Th>{sortLabel("lastOpAt", t("Last call"))}</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.items.map((row) => (
                    <Table.Tr
                      key={row.id}
                      onClick={() => setSelected(row)}
                      style={{ cursor: "pointer" }}
                    >
                      <Table.Td>
                        <UnstyledButton onClick={() => setSelected(row)}>
                          <Text size="sm" fw={500} c="blue">
                            {label(row)}
                          </Text>
                        </UnstyledButton>
                        <Identifier value={row.id} />
                        {row.email && (
                          <Text size="xs" c="dimmed">
                            {row.email}
                          </Text>
                        )}
                        {groupBy === "key" && (
                          <Group gap={4} mt={4}>
                            {row.keyTypes.map((type) => (
                              <Badge key={type} size="xs" variant="light">
                                {t(
                                  type === "agent"
                                    ? "Agent key"
                                    : type === "personal"
                                      ? "Personal key"
                                      : type === "sso"
                                        ? "SSO"
                                        : "Unknown",
                                )}
                              </Badge>
                            ))}
                            {row.id !== "__none__" &&
                              row.status !== "active" && (
                                <Badge size="xs" color="gray">
                                  {t(
                                    row.status === "revoked"
                                      ? "Revoked"
                                      : "Expired",
                                  )}
                                </Badge>
                              )}
                          </Group>
                        )}
                      </Table.Td>
                      <Table.Td maw={220}>
                        {groupBy === "key" ? (
                          <>
                            <Text size="sm" lineClamp={2}>
                              {row.actors || "—"}
                            </Text>
                            <Text size="xs" c="dimmed" lineClamp={2}>
                              {t("Creator")}: {row.creators || "—"}
                            </Text>
                          </>
                        ) : (
                          row.keyCount.toLocaleString()
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text fw={600} size="sm">
                          {row.ops.toLocaleString()}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        {row.api.toLocaleString()} / {row.mcp.toLocaleString()}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text c={row.failedOps ? "red" : undefined} size="sm">
                          {row.failedOps.toLocaleString()}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" style={{ whiteSpace: "nowrap" }}>
                          {timestamp(row.lastOpAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <ActionIcon
                          variant="subtle"
                          aria-label={t("View call details")}
                          onClick={() => setSelected(row)}
                        >
                          <IconChevronRight size={16} />
                        </ActionIcon>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {!data.items.length && (
                    <Table.Tr>
                      <Table.Td colSpan={7}>
                        <Text ta="center" c="dimmed" py="xl">
                          {t("No matching calls")}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {data.total > 20 && (
              <Group justify="end" mt="md">
                <Pagination
                  value={page}
                  onChange={setPage}
                  total={Math.ceil(data.total / 20)}
                />
              </Group>
            )}
          </Paper>
        </>
      )}
      <UsageDetail
        key={selected?.id ?? "closed"}
        row={enabled ? selected : null}
        filter={filter}
        onClose={() => setSelected(null)}
      />
    </Stack>
  );
}
