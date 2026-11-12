import { Spotlight, useSpotlight } from "@mantine/spotlight";
import { IconFilter, IconSearch } from "@tabler/icons-react";
import {
  Button,
  Center,
  Group,
  Loader,
  Text,
  VisuallyHidden,
} from "@mantine/core";
import React, { useState, useMemo, useEffect } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { searchSpotlightStore } from "../constants.ts";
import {
  SearchSpotlightFilters,
  SearchSpotlightFilterValues,
} from "./search-spotlight-filters.tsx";
import {
  usePageSearchInfinite,
  useUnifiedSearch,
} from "../hooks/use-unified-search.ts";
import { SearchResultItem } from "./search-result-item.tsx";
import { useRecentPageVisitsQuery } from "@/features/page-visit/queries/page-visit-query";
import { RecentPageVisits } from "@/features/page-visit/components/recent-page-visits";

interface SearchSpotlightProps {
  spaceId?: string;
}
export function SearchSpotlight({ spaceId }: SearchSpotlightProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [recentSpaceOnly, setRecentSpaceOnly] = useState(false);
  const { opened } = useSpotlight(searchSpotlightStore);
  const isRecentMode = query.trim().length === 0;
  const recentSpaceId = recentSpaceOnly ? spaceId : undefined;
  const [debouncedSearchQuery] = useDebouncedValue(query, 300);
  const [filters, setFilters] = useState<SearchSpotlightFilterValues>({
    contentType: "page",
  });

  // Build unified search params
  const searchParams = useMemo(() => {
    const params: any = {
      query: debouncedSearchQuery,
      contentType: filters.contentType || "page", // Only used for frontend routing
    };

    if (filters.spaceId) {
      params.spaceId = filters.spaceId;
    }
    if (filters.creatorId) {
      params.creatorId = filters.creatorId;
    }
    if (filters.labelIds?.length) {
      params.labelIds = filters.labelIds;
    }
    if (filters.titleOnly && filters.contentType === "page") {
      params.titleOnly = true;
    }
    if (filters.modifiedFrom) {
      params.modifiedFrom = filters.modifiedFrom;
    }
    if (filters.modifiedTo) {
      params.modifiedTo = filters.modifiedTo;
    }

    return params;
  }, [debouncedSearchQuery, filters]);

  // Determine result type for rendering
  const isAttachmentSearch = filters.contentType === "attachment";

  const attachmentQuery = useUnifiedSearch(searchParams);
  const pageQuery = usePageSearchInfinite(searchParams);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pageQuery;

  const searchResults = isAttachmentSearch
    ? attachmentQuery.data
    : pageQuery.data?.pages.flatMap((page) => page.items);
  const totalCount = isAttachmentSearch
    ? (attachmentQuery.data?.length ?? 0)
    : (pageQuery.data?.pages[0]?.total ?? 0);
  const isLoading = isAttachmentSearch
    ? attachmentQuery.isLoading
    : pageQuery.isLoading;

  const {
    data: recentVisitPages,
    isLoading: isRecentLoading,
    isError: isRecentError,
    hasNextPage: hasMoreRecentVisits,
    isFetchingNextPage: isFetchingMoreRecentVisits,
    fetchNextPage: fetchMoreRecentVisits,
  } = useRecentPageVisitsQuery(recentSpaceId, opened && isRecentMode);
  const recentVisits =
    recentVisitPages?.pages.flatMap((page) => page.items) ?? [];

  // 滚动到列表底部时，按当前模式加载下一页。
  const handleBottomReached = () => {
    if (isRecentMode) {
      if (hasMoreRecentVisits && !isFetchingMoreRecentVisits) {
        fetchMoreRecentVisits();
      }
    } else if (!isAttachmentSearch && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  };

  useEffect(() => {
    setRecentSpaceOnly(false);
    if (!opened) setQuery("");
  }, [opened, spaceId]);

  const resultItems = (searchResults || []).map((result) => (
    <SearchResultItem
      key={result.id}
      result={result}
      isAttachmentResult={isAttachmentSearch}
      showSpace={!filters.spaceId}
    />
  ));

  const handleFiltersChange = (newFilters: SearchSpotlightFilterValues) => {
    setFilters(newFilters);
  };

  return (
    <>
      <Spotlight.Root
        size="xl"
        maxHeight={600}
        store={searchSpotlightStore}
        query={query}
        onQueryChange={setQuery}
        scrollable
        overlayProps={{
          backgroundOpacity: 0.55,
        }}
      >
        <Group gap="xs" px="sm" pt="sm" pb="xs">
          <Spotlight.Search
            placeholder={t("Search...")}
            aria-label={t("Search")}
            leftSection={<IconSearch size={20} stroke={1.5} />}
            style={{ flex: 1 }}
          />
        </Group>

        {isRecentMode && spaceId && (
          <Group px="md" pb="xs">
            <Button
              size="xs"
              variant={recentSpaceOnly ? "light" : "subtle"}
              color={recentSpaceOnly ? undefined : "gray"}
              leftSection={<IconFilter size={14} />}
              aria-pressed={recentSpaceOnly}
              onClick={() => setRecentSpaceOnly((value) => !value)}
            >
              {t("Only current space")}
            </Button>
          </Group>
        )}

        {!isRecentMode && (
          <div style={{ padding: "4px 16px" }}>
            <SearchSpotlightFilters
              onFiltersChange={handleFiltersChange}
              spaceId={spaceId}
            />
          </div>
        )}

        <VisuallyHidden role="status" aria-live="polite">
          {!isRecentMode && !isLoading
            ? resultItems.length === 0
              ? t("No results found")
              : t("{{count}} results found", { count: totalCount })
            : ""}
        </VisuallyHidden>

        {!isRecentMode && !isLoading && totalCount > 0 && (
          <Text size="sm" c="dimmed" px="md" pb={4}>
            {t("{{count}} results found", { count: totalCount })}
          </Text>
        )}

        {/* 默认 max-height 只预留了搜索框高度，上方还有筛选栏和结果数时
            列表底部会被外层 overflow:hidden 裁掉，导致滚不到底；改为占满剩余空间 */}
        <Spotlight.ActionsList
          style={{ maxHeight: "none", minHeight: 0 }}
          // 运行时会透传给内部的 ScrollArea.Autosize，类型定义未声明
          {...({ onBottomReached: handleBottomReached } as object)}
        >
          {isRecentMode ? (
            <>
              <RecentPageVisits
                items={recentVisits}
                isLoading={isRecentLoading}
                isError={isRecentError && recentVisits.length === 0}
                showSpace={!recentSpaceId}
              />
              {isFetchingMoreRecentVisits && (
                <Center py="sm">
                  <Loader size="sm" />
                </Center>
              )}
            </>
          ) : (
            <>
              {!isLoading && resultItems.length === 0 && (
                <Spotlight.Empty>{t("No results found...")}</Spotlight.Empty>
              )}
              {resultItems.length > 0 && <>{resultItems}</>}
              {!isAttachmentSearch && isFetchingNextPage && (
                <Center py="sm">
                  <Loader size="sm" />
                </Center>
              )}
            </>
          )}
        </Spotlight.ActionsList>
      </Spotlight.Root>
    </>
  );
}
