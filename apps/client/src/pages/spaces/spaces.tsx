import {
  Box,
  Container,
  Group,
  SegmentedControl,
  Select,
  Tabs,
  Title,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconLayoutGrid, IconList } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Helmet } from "react-helmet-async";
import { getAppName } from "@/lib/config";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import CreateSpaceModal from "@/features/space/components/create-space-modal";
import { AllSpacesList } from "@/features/space/components/spaces-page";
import FavoriteSpacesGrid from "@/features/space/components/spaces-page/favorite-spaces-grid";
import { SearchInput } from "@/components/common/search-input";
import { usePaginateAndSearch } from "@/hooks/use-paginate-and-search";
import useUserRole from "@/hooks/use-user-role";
import { SpaceRole } from "@/lib/types";
import { SpaceView } from "@/features/space/types/space.types";

export default function Spaces() {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  const { search, cursor, goNext, goPrev, handleSearch, resetCursor } =
    usePaginateAndSearch();
  const [role, setRole] = useState<string | null>(null);
  const [spaceKind, setSpaceKind] = useState<string | null>(null);
  const [view, setView] = useLocalStorage<SpaceView>({
    key: "spaces-view",
    defaultValue: "list",
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedType = searchParams.get("type");
  const type =
    selectedType === "public" || selectedType === "created-personal"
      ? selectedType
      : undefined;
  const category = type ?? "all";
  const activeSpaceKind = category === "all" ? spaceKind : null;
  const personalKind =
    activeSpaceKind === "default" || activeSpaceKind === "created"
      ? activeSpaceKind
      : undefined;

  useEffect(() => {
    resetCursor();
  }, [category, resetCursor]);

  const handleTypeChange = (value: string | null) => {
    if (!value || value === category) return;
    const nextSearchParams = new URLSearchParams(searchParams);
    if (value === "all") {
      nextSearchParams.delete("type");
    } else {
      nextSearchParams.set("type", value);
    }
    setSearchParams(nextSearchParams);
    resetCursor();
  };

  const handleRoleChange = (value: string | null) => {
    setRole(value);
    resetCursor();
  };

  const { data, isLoading, isPlaceholderData, isError } = useGetSpacesQuery({
    cursor,
    limit: 30,
    query: search,
    role: role ?? undefined,
    sortByType: category === "all" || undefined,
    type:
      activeSpaceKind === "public"
        ? "public"
        : personalKind
          ? "personal"
          : type,
    personalKind,
  });

  const isFiltering = Boolean(search.trim() || role || activeSpaceKind);
  const emptyMessage = isFiltering
    ? t("No spaces match your filters")
    : t("No spaces to display");

  return (
    <>
      <Helmet>
        <title>
          {t("Spaces")} - {getAppName()}
        </title>
      </Helmet>

      <Container size="800" py="xl">
        <Group justify="space-between" mb="lg">
          <Title order={1} size="h3">
            {t("Spaces")}
          </Title>
          <Group gap="xs">
            {isAdmin && type !== "created-personal" ? (
              <CreateSpaceModal type="public" />
            ) : (
              <CreateSpaceModal type="personal" />
            )}
          </Group>
        </Group>

        <FavoriteSpacesGrid />

        <Tabs value={category} onChange={handleTypeChange}>
          <Box style={{ overflowX: "auto" }}>
            <Tabs.List
              aria-label={t("Space category")}
              style={{ flexWrap: "nowrap" }}
            >
              <Tabs.Tab value="all">{t("All spaces")}</Tabs.Tab>
              <Tabs.Tab value="public">{t("Public spaces")}</Tabs.Tab>
              <Tabs.Tab value="created-personal">{t("My spaces")}</Tabs.Tab>
            </Tabs.List>
          </Box>

          <Tabs.Panel value={category} pt="md">
            <Group justify="space-between" align="center" gap="sm" mb="md">
              <Group gap="sm">
                <SearchInput
                  inline
                  placeholder={t("Search spaces")}
                  onSearch={handleSearch}
                />
                {category === "all" && (
                  <Select
                    clearable
                    w={150}
                    value={spaceKind}
                    placeholder={t("Space type")}
                    aria-label={t("Filter by space type")}
                    clearButtonProps={{
                      "aria-label": t("Clear"),
                      "aria-hidden": false,
                      tabIndex: 0,
                    }}
                    data={[
                      { value: "public", label: t("Public space") },
                      { value: "default", label: t("Default personal space") },
                      { value: "created", label: t("Private space") },
                    ]}
                    onChange={(value) => {
                      setSpaceKind(value);
                      resetCursor();
                    }}
                  />
                )}
                <Select
                  clearable
                  w={130}
                  value={role}
                  onChange={handleRoleChange}
                  placeholder={t("All permissions")}
                  aria-label={t("Filter by permission")}
                  data={[
                    { value: SpaceRole.ADMIN, label: t("Full access") },
                    { value: SpaceRole.WRITER, label: t("Can edit") },
                    { value: SpaceRole.READER, label: t("Can view") },
                  ]}
                />
              </Group>
              <SegmentedControl
                size="sm"
                value={view === "cards" ? "cards" : "list"}
                onChange={(value) =>
                  setView(value === "cards" ? "cards" : "list")
                }
                aria-label={t("Space view")}
                data={[
                  {
                    value: "list",
                    label: (
                      <Group gap={6} wrap="nowrap">
                        <IconList size={16} aria-hidden />
                        {t("List view")}
                      </Group>
                    ),
                  },
                  {
                    value: "cards",
                    label: (
                      <Group gap={6} wrap="nowrap">
                        <IconLayoutGrid size={16} aria-hidden />
                        {t("Card view")}
                      </Group>
                    ),
                  },
                ]}
              />
            </Group>
            <AllSpacesList
              spaces={data?.items ?? []}
              view={view === "cards" ? "cards" : "list"}
              isLoading={isLoading || isPlaceholderData}
              isError={isError}
              emptyMessage={emptyMessage}
              hasPrevPage={Boolean(cursor)}
              hasNextPage={data?.meta?.hasNextPage}
              total={data?.meta?.total}
              onNext={() => goNext(data?.meta?.nextCursor)}
              onPrev={goPrev}
            />
          </Tabs.Panel>
        </Tabs>
      </Container>
    </>
  );
}
