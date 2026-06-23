import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCheck, IconSearch, IconX } from "@tabler/icons-react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { getAppName } from "@/lib/config";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import {
  applyReviewApplication,
  discoverReview,
  getReviewApplicationDiff,
  loadReviewSnapshot,
  negotiateReview,
  planReviewApplication,
  revertReviewApplication,
} from "../services/review-service";
import type {
  DraftApplyOperation,
  DraftApproach,
  ReviewApplication,
  ReviewApplicationDiff,
  ResolvedReview,
  ReviewDocMeta,
  ReviewItem,
  ReviewSnapshot,
  ReviewType,
} from "../types/review.types";

const TYPE_LABEL: Record<ReviewType, string> = {
  "missing-page": "缺页",
  suggestion: "改进建议",
  contradiction: "冲突",
  duplicate: "重合",
};

const TYPE_COLOR: Record<ReviewType, string> = {
  "missing-page": "blue",
  suggestion: "teal",
  contradiction: "red",
  duplicate: "orange",
};

const FEEDBACK_DEEPSEARCH = "DeepSearch";
const FEEDBACK_ACCEPT = "采纳";
const FEEDBACK_SKIP = "暂时跳过";

type ItemState = {
  busy?: "draft" | "plan" | "diff" | "apply" | "revert";
  resolved?: ResolvedReview;
  application?: ReviewApplication;
  diff?: ReviewApplicationDiff;
  freeText: string;
};

const ARTIFACT_LIMIT = 200;

const BUSY_LABEL: Record<NonNullable<ItemState["busy"]>, string> = {
  draft: "AI is generating the draft ...",
  plan: "Generating application preview ...",
  diff: "Loading diff ...",
  apply: "Applying to wiki ...",
  revert: "Reverting application ...",
};

export default function ReviewPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const { data: spacesData, isLoading: spacesLoading } = useGetSpacesQuery({
    limit: 100,
  });
  const spaces = spacesData?.items ?? [];
  const spaceOptions = useMemo(
    () => spaces.map((space) => ({ value: space.id, label: space.name })),
    [spaces],
  );

  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [docMap, setDocMap] = useState<Record<string, ReviewDocMeta>>({});
  const [states, setStates] = useState<Record<string, ItemState>>({});

  useEffect(() => {
    if (spaceId || spaceOptions.length === 0) return;
    const email = currentUser?.user?.email?.toLowerCase();
    const personal = email
      ? spaceOptions.find((opt) => opt.label.toLowerCase().includes(email))
      : undefined;
    setSpaceId(personal?.value ?? spaceOptions[0].value);
  }, [spaceId, spaceOptions, currentUser]);

  useEffect(() => {
    setItems(null);
    setDocMap({});
    setStates({});
  }, [spaceId]);

  const snapshotQuery = useQuery({
    queryKey: ["review-snapshot", spaceId],
    queryFn: () => loadReviewSnapshot({ spaceId: spaceId! }),
    enabled: !!spaceId,
  });

  useEffect(() => {
    if (snapshotQuery.isSuccess && snapshotQuery.data) {
      applySnapshot(snapshotQuery.data, setItems, setDocMap, setStates);
    }
  }, [snapshotQuery.data, snapshotQuery.isSuccess]);

  const discoverMutation = useMutation({
    mutationFn: discoverReview,
    onSuccess: (snapshot) => {
      if (spaceId) {
        queryClient.setQueryData(["review-snapshot", spaceId], snapshot);
      }
      applySnapshot(snapshot, setItems, setDocMap, setStates);
      if (snapshot.items.length === 0) {
        notifications.show({ message: t("No review items found") });
      }
    },
    onError: (error) => {
      notifications.show({ color: "red", message: error.message });
    },
  });

  const patchState = (id: string, patch: Partial<ItemState>) => {
    setStates((prev) => ({
      ...prev,
      [id]: { freeText: "", ...prev[id], ...patch },
    }));
  };

  const resolveItem = async (item: ReviewItem, feedback: string) => {
    if (!spaceId) return;
    patchState(item.id, { busy: "draft" });
    try {
      const resolved = await negotiateReview({ spaceId, item, feedback });
      patchState(item.id, {
        busy: undefined,
        resolved,
        application: undefined,
      });
      queryClient.setQueryData(
        ["review-snapshot", spaceId],
        (snapshot: ReviewSnapshot | null | undefined) =>
          upsertResolvedSnapshot(snapshot, resolved),
      );

      if (!resolved.skipped && resolved.draft) {
        patchState(item.id, { busy: "plan" });
        const application = await planReviewApplication({
          spaceId,
          itemId: item.id,
        });
        patchState(item.id, {
          busy: undefined,
          application,
          diff: {
            application,
            beforeContent: application.beforeContent,
            afterContent: application.afterContent,
          },
        });
        queryClient.setQueryData(
          ["review-snapshot", spaceId],
          (snapshot: ReviewSnapshot | null | undefined) =>
            upsertApplicationSnapshot(snapshot, application),
        );
      }
    } catch (error) {
      patchState(item.id, { busy: undefined });
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const planItem = async (item: ReviewItem) => {
    if (!spaceId) return;
    patchState(item.id, { busy: "plan" });
    try {
      const application = await planReviewApplication({
        spaceId,
        itemId: item.id,
      });
      patchState(item.id, {
        busy: undefined,
        application,
        diff: {
          application,
          beforeContent: application.beforeContent,
          afterContent: application.afterContent,
        },
      });
      queryClient.setQueryData(
        ["review-snapshot", spaceId],
        (snapshot: ReviewSnapshot | null | undefined) =>
          upsertApplicationSnapshot(snapshot, application),
      );
    } catch (error) {
      patchState(item.id, { busy: undefined });
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const previewApplication = async (item: ReviewItem) => {
    const application = states[item.id]?.application;
    if (!application) return;
    patchState(item.id, { busy: "diff" });
    try {
      const diff = await getReviewApplicationDiff({
        applicationId: application.id,
      });
      patchState(item.id, { busy: undefined, diff });
    } catch (error) {
      patchState(item.id, { busy: undefined });
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const applyApplication = async (item: ReviewItem) => {
    if (!spaceId) return;
    const application = states[item.id]?.application;
    if (!application) return;
    patchState(item.id, { busy: "apply" });
    try {
      const updated = await applyReviewApplication({
        applicationId: application.id,
      });
      patchState(item.id, {
        busy: undefined,
        application: updated,
        diff: states[item.id]?.diff
          ? { ...states[item.id]!.diff!, application: updated }
          : undefined,
      });
      queryClient.setQueryData(
        ["review-snapshot", spaceId],
        (snapshot: ReviewSnapshot | null | undefined) =>
          upsertApplicationSnapshot(snapshot, updated),
      );
    } catch (error) {
      patchState(item.id, { busy: undefined });
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const revertApplication = async (item: ReviewItem) => {
    if (!spaceId) return;
    const application = states[item.id]?.application;
    if (!application) return;
    patchState(item.id, { busy: "revert" });
    try {
      const updated = await revertReviewApplication({
        applicationId: application.id,
      });
      patchState(item.id, {
        busy: undefined,
        application: updated,
        diff: states[item.id]?.diff
          ? { ...states[item.id]!.diff!, application: updated }
          : undefined,
      });
      queryClient.setQueryData(
        ["review-snapshot", spaceId],
        (snapshot: ReviewSnapshot | null | undefined) =>
          upsertApplicationSnapshot(snapshot, updated),
      );
    } catch (error) {
      patchState(item.id, { busy: undefined });
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleDiscover = () => {
    if (!spaceId) return;
    discoverMutation.mutate({ spaceId, limit: ARTIFACT_LIMIT });
  };

  const hasSnapshot = Boolean(snapshotQuery.data);
  const orderedItems = useMemo(() => {
    if (!items) return [];

    return items
      .map((item, index) => ({
        item,
        index,
        handled: isItemHandled(states[item.id]),
      }))
      .sort((left, right) => {
        if (left.handled === right.handled) {
          return left.index - right.index;
        }
        return left.handled ? 1 : -1;
      });
  }, [items, states]);

  return (
    <Container size="md" py="lg">
      <Helmet>
        <title>
          {t("Review")} - {getAppName()}
        </title>
      </Helmet>

      <Stack gap="lg">
        <div>
          <Title order={2}>{t("Review")}</Title>
          <Text c="dimmed" size="sm">
            {t(
              "Let AI review the structured wiki of a space, then decide each item.",
            )}
          </Text>
        </div>

        <Group align="flex-end">
          <Select
            label={t("Space")}
            placeholder={t("Select a space")}
            data={spaceOptions}
            value={spaceId}
            onChange={setSpaceId}
            searchable
            disabled={
              spacesLoading ||
              discoverMutation.isPending ||
              snapshotQuery.isLoading
            }
            style={{ flex: 1 }}
          />
          <Button
            onClick={handleDiscover}
            loading={discoverMutation.isPending}
            disabled={!spaceId || snapshotQuery.isLoading}
          >
            {t(hasSnapshot ? "Re-review" : "Start review")}
          </Button>
        </Group>

        {snapshotQuery.isLoading && !discoverMutation.isPending && (
          <Group justify="center" py="xl">
            <Loader size="sm" />
            <Text c="dimmed">{t("Loading saved review ...")}</Text>
          </Group>
        )}

        {discoverMutation.isPending && (
          <Group justify="center" py="xl">
            <Loader size="sm" />
            <Text c="dimmed">{t("AI is reviewing the wiki ...")}</Text>
          </Group>
        )}

        {items?.length === 0 && !discoverMutation.isPending && (
          <Alert icon={<IconCheck size={18} />} color="green">
            {t("AI found nothing worth reviewing.")}
          </Alert>
        )}

        {items && items.length > 0 && (
          <Stack gap="md">
            {orderedItems.map(({ item, index }) => (
              <ReviewItemCard
                key={item.id}
                item={item}
                index={index}
                docMap={docMap}
                state={states[item.id]}
                onFreeTextChange={(v) => patchState(item.id, { freeText: v })}
                onDeepSearch={() => resolveItem(item, FEEDBACK_DEEPSEARCH)}
                onAccept={() => resolveItem(item, FEEDBACK_ACCEPT)}
                onSkip={() => resolveItem(item, FEEDBACK_SKIP)}
                onSubmitFreeText={() =>
                  resolveItem(item, states[item.id]?.freeText?.trim() || "")
                }
                onPlan={() => planItem(item)}
                onPreviewDiff={() => previewApplication(item)}
                onApply={() => applyApplication(item)}
                onRevert={() => revertApplication(item)}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

function applySnapshot(
  snapshot: ReviewSnapshot,
  setItems: (items: ReviewItem[] | null) => void,
  setDocMap: (value: Record<string, ReviewDocMeta>) => void,
  setStates: (value: Record<string, ItemState>) => void,
) {
  setItems(snapshot.items);
  setDocMap(Object.fromEntries(snapshot.docs.map((doc) => [doc.id, doc])));
  setStates(
    buildStatesFromResolvedReviews(
      snapshot.resolvedReviews,
      snapshot.applications,
    ),
  );
}

function buildStatesFromResolvedReviews(
  resolvedReviews: ResolvedReview[],
  applications: ReviewApplication[] = [],
): Record<string, ItemState> {
  const latestApplications = new Map<string, ReviewApplication>();
  for (const application of applications) {
    if (!latestApplications.has(application.reviewItemId)) {
      latestApplications.set(application.reviewItemId, application);
    }
  }

  return Object.fromEntries(
    resolvedReviews.map((resolved) => {
      const application = latestApplications.get(resolved.item.id);
      return [
        resolved.item.id,
        {
          freeText: "",
          resolved,
          application,
          diff: application
            ? {
                application,
                beforeContent: application.beforeContent,
                afterContent: application.afterContent,
              }
            : undefined,
        },
      ];
    }),
  );
}

function upsertResolvedSnapshot(
  snapshot: ReviewSnapshot | null | undefined,
  resolved: ResolvedReview,
): ReviewSnapshot | null {
  if (!snapshot) return snapshot ?? null;

  const resolvedReviews = [
    ...snapshot.resolvedReviews.filter(
      (entry) => entry.item.id !== resolved.item.id,
    ),
    resolved,
  ];

  return {
    ...snapshot,
    resolvedReviews,
    updatedAt: new Date().toISOString(),
  };
}

function upsertApplicationSnapshot(
  snapshot: ReviewSnapshot | null | undefined,
  application: ReviewApplication,
): ReviewSnapshot | null {
  if (!snapshot) return snapshot ?? null;

  const applications = [
    application,
    ...snapshot.applications.filter((entry) => entry.id !== application.id),
  ];

  return {
    ...snapshot,
    applications,
    updatedAt: new Date().toISOString(),
  };
}

function isItemHandled(state?: ItemState): boolean {
  if (!state?.resolved) return false;
  if (state.resolved.skipped || state.resolved.applied) return true;
  return (
    state.application?.status === "applied" ||
    state.application?.status === "reverted"
  );
}

function DocLink({
  docId,
  docMap,
  size = "xs",
}: {
  docId: string;
  docMap: Record<string, ReviewDocMeta>;
  size?: "xs" | "sm";
}) {
  const meta = docMap[docId];
  const label = meta?.title || `${docId.slice(0, 8)}…`;

  if (meta?.sourcePageId) {
    return (
      <Anchor
        href={`/p/${meta.sourcePageId}`}
        target="_blank"
        rel="noopener noreferrer"
        size={size}
      >
        {label}
      </Anchor>
    );
  }

  return (
    <Text component="span" size={size} c={meta?.title ? undefined : "dimmed"}>
      {label}
    </Text>
  );
}

function ReviewRichText({
  text,
  docMap,
  size = "sm",
  c = "dimmed",
  fw,
  td,
}: {
  text: string;
  docMap: Record<string, ReviewDocMeta>;
  size?: "xs" | "sm" | "md";
  c?: string;
  fw?: number;
  td?: string;
}) {
  const parts = splitDocReferences(text);

  return (
    <Text size={size} c={c} fw={fw} td={td} style={{ whiteSpace: "pre-wrap" }}>
      {parts.map((part, index) =>
        part.type === "text" ? (
          <Fragment key={`text-${index}`}>{part.value}</Fragment>
        ) : (
          <DocLink
            key={`doc-${index}-${part.docId}`}
            docId={part.docId}
            docMap={docMap}
            size={size === "md" ? "sm" : size}
          />
        ),
      )}
    </Text>
  );
}

function ReviewItemCard({
  item,
  index,
  docMap,
  state,
  onFreeTextChange,
  onDeepSearch,
  onAccept,
  onSkip,
  onSubmitFreeText,
  onPlan,
  onPreviewDiff,
  onApply,
  onRevert,
}: {
  item: ReviewItem;
  index: number;
  docMap: Record<string, ReviewDocMeta>;
  state?: ItemState;
  onFreeTextChange: (value: string) => void;
  onDeepSearch: () => void;
  onAccept: () => void;
  onSkip: () => void;
  onSubmitFreeText: () => void;
  onPlan: () => void;
  onPreviewDiff: () => void;
  onApply: () => void;
  onRevert: () => void;
}) {
  const { t } = useTranslation();
  const busy = state?.busy;
  const resolved = state?.resolved;
  const handled = isItemHandled(state);
  const hasResolution = Boolean(resolved);

  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      bg={handled ? "var(--mantine-color-gray-0)" : undefined}
      style={{
        opacity: handled ? 0.78 : 1,
        transition: "opacity 120ms ease",
      }}
    >
      <Stack gap="xs">
        <Group gap="xs">
          <Text fw={700}>#{index + 1}</Text>
          <Badge color={TYPE_COLOR[item.type]} variant="light">
            {TYPE_LABEL[item.type]}
          </Badge>
          {handled && (
            <Badge color="gray" variant="outline">
              {t("Reviewed")}
            </Badge>
          )}
          <ReviewRichText
            text={item.title}
            docMap={docMap}
            size="md"
            fw={600}
            c={handled ? "dimmed" : undefined}
            td={handled ? "line-through" : undefined}
          />
        </Group>

        <div>
          <Text size="sm" fw={600}>
            {t("Report")}
          </Text>
          <ReviewRichText text={item.detail} docMap={docMap} />
        </div>
        <div>
          <Text size="sm" fw={600}>
            {t("AI recommendation")}
          </Text>
          <ReviewRichText text={item.recommendation} docMap={docMap} />
        </div>
        {item.relatedDocIds.length > 0 && (
          <Group gap={6} align="center">
            <Text size="xs" c="dimmed">
              {t("Related docs")}:
            </Text>
            {item.relatedDocIds.map((id, i) => (
              <Group key={id} gap={4} align="center">
                {i > 0 && (
                  <Text size="xs" c="dimmed">
                    、
                  </Text>
                )}
                <DocLink docId={id} docMap={docMap} />
              </Group>
            ))}
          </Group>
        )}
        {item.type === "missing-page" && item.outline.length > 0 && (
          <Text size="xs" c="dimmed">
            {t("Suggested outline")}: {item.outline.join(" / ")}
          </Text>
        )}
        {item.type === "duplicate" && (
          <Group gap={6} align="center">
            <Text size="xs" c="dimmed">
              {t("Suggested primary")}:
            </Text>
            {item.suggestedPrimaryId ? (
              <DocLink docId={item.suggestedPrimaryId} docMap={docMap} />
            ) : (
              <Text size="xs" c="dimmed">
                {t("(undecided)")}
              </Text>
            )}
          </Group>
        )}

        {busy ? (
          <Group gap="xs" mt="xs">
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              {t(BUSY_LABEL[busy])}
            </Text>
          </Group>
        ) : hasResolution ? (
          <ResolvedBlock
            resolved={resolved!}
            application={state?.application}
            diff={state?.diff}
            docMap={docMap}
            onPlan={onPlan}
            onPreviewDiff={onPreviewDiff}
            onApply={onApply}
            onRevert={onRevert}
          />
        ) : (
          <>
            <Group gap="xs" mt="xs">
              <Button
                size="xs"
                variant="light"
                leftSection={<IconSearch size={14} />}
                onClick={onDeepSearch}
              >
                {t("DeepSearch")}
              </Button>
              <Button
                size="xs"
                color="green"
                leftSection={<IconCheck size={14} />}
                onClick={onAccept}
              >
                {t("Accept")}
              </Button>
              <Button
                size="xs"
                variant="default"
                leftSection={<IconX size={14} />}
                onClick={onSkip}
              >
                {t("Skip")}
              </Button>
            </Group>

            <Group gap="xs" align="flex-end">
              <TextInput
                placeholder={t("Or type your own feedback ...")}
                value={state?.freeText ?? ""}
                onChange={(e) => onFreeTextChange(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (state?.freeText?.trim() ?? "")) {
                    onSubmitFreeText();
                  }
                }}
                style={{ flex: 1 }}
              />
              <Button
                size="sm"
                variant="subtle"
                onClick={onSubmitFreeText}
                disabled={!(state?.freeText?.trim() ?? "")}
              >
                {t("Submit")}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Paper>
  );
}

function splitDocReferences(text: string) {
  const parts: Array<
    { type: "text"; value: string } | { type: "doc"; docId: string }
  > = [];
  const pattern = /\[id=([0-9a-fA-F-]{36})\]/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, start) });
    }

    const docId = match[1];
    if (docId) {
      parts.push({ type: "doc", docId });
    }
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

function ResolvedBlock({
  resolved,
  application,
  diff,
  docMap,
  onPlan,
  onPreviewDiff,
  onApply,
  onRevert,
}: {
  resolved: ResolvedReview;
  application?: ReviewApplication;
  diff?: ReviewApplicationDiff;
  docMap: Record<string, ReviewDocMeta>;
  onPlan: () => void;
  onPreviewDiff: () => void;
  onApply: () => void;
  onRevert: () => void;
}) {
  const { t } = useTranslation();

  if (resolved.skipped || !resolved.draft) {
    return (
      <Alert color="gray" mt="xs" icon={<IconX size={16} />}>
        {t("Skipped, no draft produced.")}
      </Alert>
    );
  }

  const draft = resolved.draft;
  const applyOperation =
    draft.applyOperation ?? fallbackDraftApplyOperation(draft.approach);
  const isRenameOnly = applyOperation === "rename-page";
  const showDraftBody = !diff;
  return (
    <Paper bg="var(--mantine-color-gray-0)" radius="sm" p="sm" mt="xs">
      <Stack gap="xs">
        <ExecutionSummary
          resolved={resolved}
          application={application}
          docMap={docMap}
        />
        {resolved.deepSearched && (
          <Text size="xs" c="dimmed">
            {t("DeepSearch")} · {resolved.searchResults.length}
          </Text>
        )}
        {draft.notes && (
          <Text size="xs" c="dimmed">
            {t("Tradeoff")}: {draft.notes}
          </Text>
        )}
        {showDraftBody && (
          <>
            <Text size="sm" fw={600}>
              {draft.title}
            </Text>
            {isRenameOnly ? (
              <Alert color="blue" variant="light">
                {t("Only renames the page; body is unchanged.")}
              </Alert>
            ) : (
              <Textarea
                value={draft.body}
                readOnly
                autosize
                minRows={4}
                maxRows={20}
                styles={{
                  input: { fontFamily: "monospace", fontSize: "12px" },
                }}
              />
            )}
          </>
        )}
        <ApplicationBlock
          application={application}
          diff={diff}
          legacyApplied={resolved.applied}
          onPlan={onPlan}
          onPreviewDiff={onPreviewDiff}
          onApply={onApply}
          onRevert={onRevert}
        />
      </Stack>
    </Paper>
  );
}

function ApplicationBlock({
  application,
  diff,
  legacyApplied,
  onPlan,
  onPreviewDiff,
  onApply,
  onRevert,
}: {
  application?: ReviewApplication;
  diff?: ReviewApplicationDiff;
  legacyApplied?: ResolvedReview["applied"];
  onPlan: () => void;
  onPreviewDiff: () => void;
  onApply: () => void;
  onRevert: () => void;
}) {
  const { t } = useTranslation();

  if (!application) {
    if (legacyApplied) {
      return (
        <Group gap={6} align="center" mt="xs">
          <Badge color="teal" variant="filled">
            {t("Applied")}
          </Badge>
          <Text size="xs" c="dimmed">
            {legacyApplied.action === "created"
              ? t("Created page")
              : t("Updated page")}
            :
          </Text>
          <Anchor
            size="xs"
            href={`/p/${legacyApplied.pageId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {legacyApplied.pageTitle}
          </Anchor>
        </Group>
      );
    }

    return (
      <Group gap="xs" mt="xs">
        <Button size="xs" variant="light" onClick={onPlan}>
          {t("Generate preview")}
        </Button>
      </Group>
    );
  }

  return (
    <Stack gap="xs" mt="xs">
      {application.sourceRefs.some((ref) => ref.type === "web") && (
        <Stack gap={4}>
          <Text size="xs" fw={600}>
            {t("External sources")}
          </Text>
          {application.sourceRefs
            .filter((ref) => ref.type === "web")
            .map((ref, index) => (
              <Anchor
                key={`${ref.url}-${index}`}
                size="xs"
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {ref.title}
              </Anchor>
            ))}
        </Stack>
      )}

      <Group gap="xs">
        {!diff && (
          <Button size="xs" variant="default" onClick={onPreviewDiff}>
            {t("Preview Diff")}
          </Button>
        )}
        {application.status === "draft" && (
          <Button size="xs" color="green" onClick={onApply}>
            {t("Apply to Wiki")}
          </Button>
        )}
        {application.status === "applied" && (
          <Button size="xs" color="red" variant="light" onClick={onRevert}>
            {t("Revert changes")}
          </Button>
        )}
      </Group>

      {application.status === "conflicted" && (
        <Alert color="yellow">
          {t(
            "The page changed after this plan was generated. Please handle it manually.",
          )}
        </Alert>
      )}

      {application.status === "applied" && application.appliedAt && (
        <Text size="xs" c="dimmed">
          {t("Applied at")}: {new Date(application.appliedAt).toLocaleString()}
        </Text>
      )}
      {application.status === "reverted" && application.revertedAt && (
        <Text size="xs" c="dimmed">
          {t("Reverted at")}:{" "}
          {new Date(application.revertedAt).toLocaleString()}
        </Text>
      )}

      {diff && <DiffPreview diff={diff} />}
    </Stack>
  );
}

function ExecutionSummary({
  resolved,
  application,
  docMap,
}: {
  resolved: ResolvedReview;
  application?: ReviewApplication;
  docMap: Record<string, ReviewDocMeta>;
}) {
  const { t } = useTranslation();
  const draft = resolved.draft;
  if (!draft) return null;

  if (application) {
    return (
      <Group gap={6} align="center">
        <Badge
          color={APPLICATION_STATUS_COLOR[application.status]}
          variant="light"
        >
          {t(APPLICATION_STATUS_LABEL[application.status])}
        </Badge>
        <Text size="sm" fw={600}>
          {t(OPERATION_LABEL[application.operation])}
        </Text>
        <Text size="sm" c="dimmed">
          ·
        </Text>
        <WritingLocation application={application} />
      </Group>
    );
  }

  const applyOperation =
    draft.applyOperation ?? fallbackDraftApplyOperation(draft.approach);

  return (
    <Group gap={6} align="center">
      <Text size="sm" fw={600}>
        {t("Draft ready")}
      </Text>
      <Text size="sm" c="dimmed">
        ·
      </Text>
      <Text size="sm">
        {t("Expected write")}: {t(DRAFT_OPERATION_LABEL[applyOperation])}
      </Text>
      <Text size="sm" c="dimmed">
        ·
      </Text>
      <Text size="sm" c="dimmed">
        {t("Suggested landing")}:
      </Text>
      <DraftLanding draft={draft} docMap={docMap} />
    </Group>
  );
}

function DraftLanding({
  draft,
  docMap,
}: {
  draft: ResolvedReview["draft"];
  docMap: Record<string, ReviewDocMeta>;
}) {
  const { t } = useTranslation();
  if (!draft) return null;

  if (draft.targetDocId) {
    return <DocLink docId={draft.targetDocId} docMap={docMap} size="sm" />;
  }

  return (
    <Text size="sm" c="dimmed">
      {t("(new page)")}
      {draft.title ? ` · ${draft.title}` : ""}
    </Text>
  );
}

function WritingLocation({ application }: { application: ReviewApplication }) {
  const { t } = useTranslation();
  const pageId = application.createdPageId ?? application.targetPageId;
  const hasPath = application.targetHeadingPath.length > 0;

  return (
    <Group gap={4} align="center">
      <Text size="sm" c="dimmed">
        {t("Write location")}:
      </Text>
      {pageId ? (
        <Anchor
          size="sm"
          href={`/p/${pageId}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {application.targetPageTitle ?? pageId}
        </Anchor>
      ) : (
        <Text size="sm" c="dimmed">
          {application.targetPageTitle ?? t("(new page)")}
        </Text>
      )}
      {hasPath && (
        <Text size="sm" c="dimmed">
          / {application.targetHeadingPath.join(" / ")}
        </Text>
      )}
    </Group>
  );
}

function DiffPreview({ diff }: { diff: ReviewApplicationDiff }) {
  const { t } = useTranslation();
  const preview = buildHighlightedDiffPreview(
    diff.beforeContent ?? "",
    diff.afterContent,
  );

  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        {t("Only the changed section is shown.")}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
        <DiffPane title={t("Before")} lines={preview.before} />
        <DiffPane title={t("After")} lines={preview.after} />
      </SimpleGrid>
    </Stack>
  );
}

function DiffPane({
  title,
  lines,
}: {
  title: string;
  lines: HighlightedDiffLine[];
}) {
  const renderedLines =
    lines.length > 0
      ? lines
      : [
          {
            id: "empty",
            kind: "omitted" as const,
            content: "(empty)",
            lineNumber: null,
          },
        ];

  return (
    <Stack gap={4}>
      <Text size="xs" fw={600}>
        {title}
      </Text>
      <Paper
        withBorder
        radius="sm"
        style={{
          maxHeight: 420,
          overflow: "auto",
          background: "var(--mantine-color-gray-0)",
        }}
      >
        {renderedLines.map((line) => (
          <div
            key={line.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              borderLeft: `3px solid ${diffLineBorder(line.kind)}`,
              background: diffLineBackground(line.kind),
            }}
          >
            <span
              style={{
                boxSizing: "border-box",
                flex: "0 0 48px",
                padding: "2px 8px",
                color: "var(--mantine-color-dimmed)",
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: 1.55,
                textAlign: "right",
                userSelect: "none",
              }}
            >
              {line.lineNumber ?? ""}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                padding: "2px 8px",
                color: diffLineTextColor(line.kind),
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {diffLineMarker(line.kind)}
              {line.content || " "}
            </span>
          </div>
        ))}
      </Paper>
    </Stack>
  );
}

type HighlightedDiffLineKind = "context" | "added" | "removed" | "omitted";

type HighlightedDiffLine = {
  id: string;
  kind: HighlightedDiffLineKind;
  content: string;
  lineNumber: number | null;
};

function buildHighlightedDiffPreview(
  beforeContent: string,
  afterContent: string,
): { before: HighlightedDiffLine[]; after: HighlightedDiffLine[] } {
  const beforeLines = splitLines(beforeContent);
  const afterLines = splitLines(afterContent);
  const context = 4;

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  if (prefix === beforeLines.length && prefix === afterLines.length) {
    return {
      before: toContextLines(beforeLines, "before", 0),
      after: toContextLines(afterLines, "after", 0),
    };
  }

  const beforeEnd = beforeLines.length - suffix;
  const afterEnd = afterLines.length - suffix;
  const beforeStart = Math.max(0, prefix - context);
  const afterStart = Math.max(0, prefix - context);
  const beforeVisibleEnd = Math.min(beforeLines.length, beforeEnd + context);
  const afterVisibleEnd = Math.min(afterLines.length, afterEnd + context);
  const beforeVisible = beforeLines.slice(beforeStart, beforeVisibleEnd);
  const afterVisible = afterLines.slice(afterStart, afterVisibleEnd);

  const highlighted = buildVisibleLineDiff({
    beforeLines: beforeVisible,
    afterLines: afterVisible,
    beforeOffset: beforeStart,
    afterOffset: afterStart,
    beforeChangeStart: prefix,
    beforeChangeEnd: beforeEnd,
    afterChangeStart: prefix,
    afterChangeEnd: afterEnd,
  });

  return {
    before: withOmittedLines(
      highlighted.before,
      beforeStart,
      beforeVisibleEnd,
      beforeLines.length,
      "before",
    ),
    after: withOmittedLines(
      highlighted.after,
      afterStart,
      afterVisibleEnd,
      afterLines.length,
      "after",
    ),
  };
}

function splitLines(content: string): string[] {
  if (!content) return [];
  return content.replace(/\r\n/g, "\n").split("\n");
}

function buildVisibleLineDiff(input: {
  beforeLines: string[];
  afterLines: string[];
  beforeOffset: number;
  afterOffset: number;
  beforeChangeStart: number;
  beforeChangeEnd: number;
  afterChangeStart: number;
  afterChangeEnd: number;
}): { before: HighlightedDiffLine[]; after: HighlightedDiffLine[] } {
  const matrixSize = input.beforeLines.length * input.afterLines.length;
  if (matrixSize > 200_000) {
    return {
      before: toRangeMarkedLines(
        input.beforeLines,
        "before",
        input.beforeOffset,
        input.beforeChangeStart,
        input.beforeChangeEnd,
        "removed",
      ),
      after: toRangeMarkedLines(
        input.afterLines,
        "after",
        input.afterOffset,
        input.afterChangeStart,
        input.afterChangeEnd,
        "added",
      ),
    };
  }

  const beforeCount = input.beforeLines.length;
  const afterCount = input.afterLines.length;
  const lcs = Array.from({ length: beforeCount + 1 }, () =>
    Array(afterCount + 1).fill(0),
  );

  for (let beforeIndex = beforeCount - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterCount - 1; afterIndex >= 0; afterIndex -= 1) {
      lcs[beforeIndex][afterIndex] =
        input.beforeLines[beforeIndex] === input.afterLines[afterIndex]
          ? lcs[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(
              lcs[beforeIndex + 1][afterIndex],
              lcs[beforeIndex][afterIndex + 1],
            );
    }
  }

  const before: HighlightedDiffLine[] = [];
  const after: HighlightedDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeCount && afterIndex < afterCount) {
    if (input.beforeLines[beforeIndex] === input.afterLines[afterIndex]) {
      before.push(
        makeHighlightedLine(
          "before",
          "context",
          input.beforeLines[beforeIndex],
          input.beforeOffset + beforeIndex,
        ),
      );
      after.push(
        makeHighlightedLine(
          "after",
          "context",
          input.afterLines[afterIndex],
          input.afterOffset + afterIndex,
        ),
      );
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    if (lcs[beforeIndex + 1][afterIndex] >= lcs[beforeIndex][afterIndex + 1]) {
      before.push(
        makeHighlightedLine(
          "before",
          "removed",
          input.beforeLines[beforeIndex],
          input.beforeOffset + beforeIndex,
        ),
      );
      beforeIndex += 1;
    } else {
      after.push(
        makeHighlightedLine(
          "after",
          "added",
          input.afterLines[afterIndex],
          input.afterOffset + afterIndex,
        ),
      );
      afterIndex += 1;
    }
  }

  while (beforeIndex < beforeCount) {
    before.push(
      makeHighlightedLine(
        "before",
        "removed",
        input.beforeLines[beforeIndex],
        input.beforeOffset + beforeIndex,
      ),
    );
    beforeIndex += 1;
  }

  while (afterIndex < afterCount) {
    after.push(
      makeHighlightedLine(
        "after",
        "added",
        input.afterLines[afterIndex],
        input.afterOffset + afterIndex,
      ),
    );
    afterIndex += 1;
  }

  return { before, after };
}

function toContextLines(
  lines: string[],
  side: "before" | "after",
  offset: number,
): HighlightedDiffLine[] {
  return lines.map((line, index) =>
    makeHighlightedLine(side, "context", line, offset + index),
  );
}

function toRangeMarkedLines(
  lines: string[],
  side: "before" | "after",
  offset: number,
  changeStart: number,
  changeEnd: number,
  changedKind: "added" | "removed",
): HighlightedDiffLine[] {
  return lines.map((line, index) => {
    const absoluteIndex = offset + index;
    const kind =
      absoluteIndex >= changeStart && absoluteIndex < changeEnd
        ? changedKind
        : "context";
    return makeHighlightedLine(side, kind, line, absoluteIndex);
  });
}

function withOmittedLines(
  lines: HighlightedDiffLine[],
  start: number,
  end: number,
  total: number,
  side: "before" | "after",
): HighlightedDiffLine[] {
  const result = [...lines];
  if (start > 0) {
    result.unshift({
      id: `${side}-omitted-start`,
      kind: "omitted",
      content: "...",
      lineNumber: null,
    });
  }
  if (end < total) {
    result.push({
      id: `${side}-omitted-end`,
      kind: "omitted",
      content: "...",
      lineNumber: null,
    });
  }
  return result;
}

function makeHighlightedLine(
  side: "before" | "after",
  kind: HighlightedDiffLineKind,
  content: string,
  zeroBasedLineNumber: number,
): HighlightedDiffLine {
  return {
    id: `${side}-${zeroBasedLineNumber}-${kind}`,
    kind,
    content,
    lineNumber: zeroBasedLineNumber + 1,
  };
}

function diffLineMarker(kind: HighlightedDiffLineKind): string {
  if (kind === "added") return "+ ";
  if (kind === "removed") return "- ";
  return "  ";
}

function diffLineBackground(kind: HighlightedDiffLineKind): string {
  if (kind === "added") return "var(--mantine-color-green-0)";
  if (kind === "removed") return "var(--mantine-color-red-0)";
  if (kind === "omitted") return "var(--mantine-color-gray-1)";
  return "transparent";
}

function diffLineBorder(kind: HighlightedDiffLineKind): string {
  if (kind === "added") return "var(--mantine-color-green-6)";
  if (kind === "removed") return "var(--mantine-color-red-6)";
  return "transparent";
}

function diffLineTextColor(kind: HighlightedDiffLineKind): string {
  if (kind === "added") return "var(--mantine-color-green-9)";
  if (kind === "removed") return "var(--mantine-color-red-9)";
  if (kind === "omitted") return "var(--mantine-color-dimmed)";
  return "inherit";
}

function fallbackDraftApplyOperation(
  approach: DraftApproach,
): DraftApplyOperation {
  switch (approach) {
    case "new-page":
    case "clarify":
      return "create-page";
    case "section":
      return "append-section";
    case "rewrite":
    case "merge":
      return "replace-page";
  }
}

const DRAFT_OPERATION_LABEL: Record<DraftApplyOperation, string> = {
  "create-page": "Create page",
  "append-section": "Append section",
  "replace-page": "Replace page",
  "rename-page": "Rename page",
};

const OPERATION_LABEL: Record<ReviewApplication["operation"], string> = {
  create_page: "Create page",
  insert_under_heading: "Insert under heading",
  replace_section: "Replace section",
  append_section: "Append section",
  replace_page: "Replace page",
  rename_page: "Rename page",
  rewrite_page: "Rewrite page",
  merge_pages: "Merge pages",
};

const APPLICATION_STATUS_LABEL: Record<ReviewApplication["status"], string> = {
  draft: "Application draft",
  applied: "Applied",
  reverted: "Reverted",
  conflicted: "Conflicted",
  failed: "Failed",
};

const APPLICATION_STATUS_COLOR: Record<ReviewApplication["status"], string> = {
  draft: "blue",
  applied: "teal",
  reverted: "gray",
  conflicted: "yellow",
  failed: "red",
};
