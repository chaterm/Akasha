import React, { useState, useEffect } from "react";
import {
  Avatar,
  Button,
  Menu,
  ScrollArea,
  TextInput,
  Text,
  Badge,
  Group,
  getDefaultZIndex,
} from "@mantine/core";
import {
  IconChevronDown,
  IconBuilding,
  IconFileDescription,
  IconCheck,
  IconUser,
  IconTag,
  IconCalendar,
  IconHeading,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { SpaceFilterMenu } from "@/features/space/components/space-filter-menu";
import { useSearchSuggestionsQuery } from "@/features/search/queries/search-query";
import { getWorkspaceLabels } from "@/features/label/services/label-service";
import { IUser } from "@/features/user/types/user.types";
import { ILabel } from "@/features/label/types/label.types";
import classes from "./search-spotlight-filters.module.css";

export interface SearchSpotlightFilterValues {
  spaceId?: string | null;
  contentType?: "page" | "attachment";
  creatorId?: string | null;
  labelIds?: string[];
  titleOnly?: boolean;
  modifiedFrom?: string;
  modifiedTo?: string;
}

interface SearchSpotlightFiltersProps {
  onFiltersChange?: (filters: SearchSpotlightFilterValues) => void;
  spaceId?: string;
}

export function SearchSpotlightFilters({
  onFiltersChange,
  spaceId,
}: SearchSpotlightFiltersProps) {
  const { t } = useTranslation();
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(
    spaceId || null,
  );
  const [contentType, setContentType] =
    useState<SearchSpotlightFilterValues["contentType"]>("page");
  const [selectedCreator, setSelectedCreator] = useState<Partial<IUser> | null>(
    null,
  );
  const [creatorQuery, setCreatorQuery] = useState("");
  const [debouncedCreatorQuery] = useDebouncedValue(creatorQuery, 300);
  const [selectedLabels, setSelectedLabels] = useState<ILabel[]>([]);
  const [labelQuery, setLabelQuery] = useState("");
  const [debouncedLabelQuery] = useDebouncedValue(labelQuery, 300);
  const [titleOnly, setTitleOnly] = useState(false);
  const [modifiedFrom, setModifiedFrom] = useState("");
  const [modifiedTo, setModifiedTo] = useState("");

  const { data: spacesData } = useGetSpacesQuery({ limit: 100 });
  const { data: creatorSuggestions } = useSearchSuggestionsQuery({
    query: debouncedCreatorQuery,
    includeUsers: true,
    includeGroups: false,
    includePages: false,
    limit: 20,
    preload: true,
  });
  const { data: labelsData } = useQuery({
    queryKey: ["search-filter-labels", debouncedLabelQuery],
    queryFn: () =>
      getWorkspaceLabels({
        type: "page",
        query: debouncedLabelQuery,
        limit: 20,
      }),
  });

  const selectedSpaceData = selectedSpaceId
    ? spacesData?.items.find((space) => space.id === selectedSpaceId)
    : null;
  const creatorOptions = (creatorSuggestions?.users ?? []).filter(
    Boolean,
  ) as Partial<IUser>[];
  const labelOptions = labelsData?.items ?? [];

  const contentTypeOptions = [
    { value: "page", label: t("Pages") },
    {
      value: "attachment",
      label: t("Attachments"),
      disabled: false,
    },
  ];

  const emitFilters = (
    overrides: Partial<SearchSpotlightFilterValues> = {},
  ) => {
    onFiltersChange?.({
      spaceId: selectedSpaceId,
      contentType,
      creatorId: selectedCreator?.id ?? null,
      labelIds: selectedLabels.map((label) => label.id),
      titleOnly,
      modifiedFrom: modifiedFrom || undefined,
      modifiedTo: modifiedTo || undefined,
      ...overrides,
    });
  };

  useEffect(() => {
    emitFilters();
  }, []);

  const handleSpaceSelect = (spaceId: string | null) => {
    setSelectedSpaceId(spaceId);
    emitFilters({ spaceId });
  };

  const handleContentTypeChange = (
    value: SearchSpotlightFilterValues["contentType"],
  ) => {
    setContentType(value);
    emitFilters({ contentType: value });
  };

  const handleCreatorSelect = (creator: Partial<IUser> | null) => {
    setSelectedCreator(creator);
    emitFilters({ creatorId: creator?.id ?? null });
  };

  const handleLabelToggle = (label: ILabel) => {
    const nextLabels = selectedLabels.some((item) => item.id === label.id)
      ? selectedLabels.filter((item) => item.id !== label.id)
      : [...selectedLabels, label];
    setSelectedLabels(nextLabels);
    emitFilters({ labelIds: nextLabels.map((item) => item.id) });
  };

  const handleTitleOnlyToggle = () => {
    const nextValue = !titleOnly;
    setTitleOnly(nextValue);
    emitFilters({ titleOnly: nextValue });
  };

  const handleModifiedFromChange = (value: string) => {
    setModifiedFrom(value);
    emitFilters({ modifiedFrom: value || undefined });
  };

  const handleModifiedToChange = (value: string) => {
    setModifiedTo(value);
    emitFilters({ modifiedTo: value || undefined });
  };

  return (
    <div className={classes.filtersContainer}>
      <SpaceFilterMenu
        value={selectedSpaceId}
        onChange={handleSpaceSelect}
        position="bottom-start"
        width={250}
        zIndex={getDefaultZIndex("max")}
      >
        <Button
          variant="subtle"
          color="gray"
          size="sm"
          rightSection={<IconChevronDown size={14} />}
          leftSection={<IconBuilding size={16} />}
          className={classes.filterButton}
          fw={500}
        >
          {selectedSpaceId
            ? `${t("Space")}: ${selectedSpaceData?.name || t("Unknown")}`
            : `${t("Space")}: ${t("All spaces")}`}
        </Button>
      </SpaceFilterMenu>

      <Menu
        shadow="md"
        width={220}
        position="bottom-start"
        zIndex={getDefaultZIndex("max")}
      >
        <Menu.Target>
          <Button
            variant="subtle"
            color="gray"
            size="sm"
            rightSection={<IconChevronDown size={14} />}
            leftSection={<IconFileDescription size={16} />}
            className={classes.filterButton}
            fw={500}
          >
            {contentType
              ? `${t("Type")}: ${contentTypeOptions.find((opt) => opt.value === contentType)?.label || t(contentType === "page" ? "Pages" : "Attachments")}`
              : t("Type")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {contentTypeOptions.map((option) => (
            <Menu.Item
              key={option.value}
              role="menuitemradio"
              aria-checked={contentType === option.value}
              onClick={() =>
                !option.disabled &&
                contentType !== option.value &&
                handleContentTypeChange(option.value as "page" | "attachment")
              }
              disabled={option.disabled}
            >
              <Group flex="1" gap="xs">
                <div>
                  <Text size="sm">{option.label}</Text>
                  {option.disabled && (
                    <Badge size="xs" mt={4}>
                      {t("Enterprise")}
                    </Badge>
                  )}
                </div>
                {contentType === option.value && (
                  <IconCheck size={20} aria-hidden />
                )}
              </Group>
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>

      <Menu
        shadow="md"
        width={280}
        position="bottom-start"
        zIndex={getDefaultZIndex("max")}
      >
        <Menu.Target>
          <Button
            variant="subtle"
            color="gray"
            size="sm"
            rightSection={<IconChevronDown size={14} />}
            leftSection={<IconUser size={16} />}
            className={classes.filterButton}
            fw={500}
          >
            {selectedCreator?.name
              ? `${t("Creator")}: ${selectedCreator.name}`
              : t("Creator")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <TextInput
            placeholder={t("Find a creator")}
            data-autofocus
            leftSection={<IconSearch size={16} />}
            value={creatorQuery}
            onChange={(event) => setCreatorQuery(event.currentTarget.value)}
            size="sm"
            variant="filled"
            radius="sm"
            styles={{ input: { marginBottom: 8 } }}
          />
          <ScrollArea.Autosize mah={260}>
            <Menu.Item onClick={() => handleCreatorSelect(null)}>
              <Group flex="1" gap="xs">
                <Avatar color="gray" variant="light" size={20}>
                  <IconX size={14} />
                </Avatar>
                <Text size="sm" fw={500} style={{ flex: 1 }}>
                  {t("Any creator")}
                </Text>
                {!selectedCreator && <IconCheck size={20} aria-hidden />}
              </Group>
            </Menu.Item>
            {creatorOptions.map((user) => (
              <Menu.Item
                key={user.id}
                role="menuitemradio"
                aria-checked={selectedCreator?.id === user.id}
                onClick={() => handleCreatorSelect(user)}
              >
                <Group flex="1" gap="xs">
                  <Avatar
                    color="initials"
                    variant="filled"
                    name={user.name || user.email}
                    size={20}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={500} truncate>
                      {user.name || user.email}
                    </Text>
                    {user.email && (
                      <Text size="xs" c="dimmed" truncate>
                        {user.email}
                      </Text>
                    )}
                  </div>
                  {selectedCreator?.id === user.id && (
                    <IconCheck size={20} aria-hidden />
                  )}
                </Group>
              </Menu.Item>
            ))}
          </ScrollArea.Autosize>
        </Menu.Dropdown>
      </Menu>

      <Menu
        shadow="md"
        width={280}
        position="bottom-start"
        zIndex={getDefaultZIndex("max")}
      >
        <Menu.Target>
          <Button
            variant="subtle"
            color="gray"
            size="sm"
            rightSection={<IconChevronDown size={14} />}
            leftSection={<IconTag size={16} />}
            className={classes.filterButton}
            fw={500}
          >
            {selectedLabels.length
              ? `${t("Labels")}: ${selectedLabels.length}`
              : t("Labels")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <TextInput
            placeholder={t("Find a label")}
            data-autofocus
            leftSection={<IconSearch size={16} />}
            value={labelQuery}
            onChange={(event) => setLabelQuery(event.currentTarget.value)}
            size="sm"
            variant="filled"
            radius="sm"
            styles={{ input: { marginBottom: 8 } }}
          />
          <ScrollArea.Autosize mah={260}>
            <Menu.Item
              disabled={selectedLabels.length === 0}
              onClick={() => {
                setSelectedLabels([]);
                emitFilters({ labelIds: [] });
              }}
            >
              <Group flex="1" gap="xs">
                <IconX size={16} />
                <Text size="sm" fw={500}>
                  {t("Clear labels")}
                </Text>
              </Group>
            </Menu.Item>
            {labelOptions.map((label) => {
              const selected = selectedLabels.some(
                (item) => item.id === label.id,
              );
              return (
                <Menu.Item
                  key={label.id}
                  role="menuitemcheckbox"
                  aria-checked={selected}
                  onClick={() => handleLabelToggle(label)}
                >
                  <Group flex="1" gap="xs">
                    <Badge variant="light" color="gray" size="sm">
                      {label.name}
                    </Badge>
                    <div style={{ flex: 1 }} />
                    {selected && <IconCheck size={20} aria-hidden />}
                  </Group>
                </Menu.Item>
              );
            })}
          </ScrollArea.Autosize>
        </Menu.Dropdown>
      </Menu>

      <Menu
        shadow="md"
        width={260}
        position="bottom-start"
        zIndex={getDefaultZIndex("max")}
      >
        <Menu.Target>
          <Button
            variant="subtle"
            color="gray"
            size="sm"
            rightSection={<IconChevronDown size={14} />}
            leftSection={<IconCalendar size={16} />}
            className={classes.filterButton}
            fw={500}
          >
            {modifiedFrom || modifiedTo
              ? t("Modified date: set")
              : t("Modified date")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown p="sm">
          <TextInput
            type="date"
            label={t("From")}
            value={modifiedFrom}
            onChange={(event) =>
              handleModifiedFromChange(event.currentTarget.value)
            }
            size="sm"
            mb="xs"
          />
          <TextInput
            type="date"
            label={t("To")}
            value={modifiedTo}
            onChange={(event) =>
              handleModifiedToChange(event.currentTarget.value)
            }
            size="sm"
            mb="xs"
          />
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            leftSection={<IconX size={14} />}
            disabled={!modifiedFrom && !modifiedTo}
            onClick={() => {
              setModifiedFrom("");
              setModifiedTo("");
              emitFilters({ modifiedFrom: undefined, modifiedTo: undefined });
            }}
          >
            {t("Clear")}
          </Button>
        </Menu.Dropdown>
      </Menu>

      {contentType === "page" && (
        <Button
          variant={titleOnly ? "light" : "subtle"}
          color={titleOnly ? "blue" : "gray"}
          size="sm"
          leftSection={<IconHeading size={16} />}
          className={classes.filterButton}
          fw={500}
          aria-pressed={titleOnly}
          onClick={handleTitleOnlyToggle}
        >
          {t("Title only")}
        </Button>
      )}
    </div>
  );
}
