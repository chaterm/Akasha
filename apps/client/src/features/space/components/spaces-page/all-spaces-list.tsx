import {
  Table,
  Text,
  Group,
  ActionIcon,
  Box,
  Menu,
  Anchor,
  Tooltip,
  VisuallyHidden,
  Badge,
  Card,
  Center,
  Loader,
  SimpleGrid,
  Stack,
} from "@mantine/core";
import {
  IconDots,
  IconSettings,
  IconEye,
  IconEyeOff,
} from "@tabler/icons-react";
import StarButton from "@/features/favorite/components/star-button";
import {
  useWatchedSpaceIds,
  useWatchSpaceMutation,
  useUnwatchSpaceMutation,
} from "@/features/space/queries/space-watcher-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import React, { useState } from "react";
import { useDisclosure } from "@mantine/hooks";
import { formatMemberCount } from "@/lib";
import { getSpaceUrl } from "@/lib/config";
import { prefetchSpace } from "@/features/space/queries/space-query";
import Paginate from "@/components/common/paginate";
import SpaceSettingsModal from "@/features/space/components/settings-modal";
import classes from "./all-spaces-list.module.css";
import rowClasses from "@/components/ui/clickable-table-row.module.css";
import clsx from "clsx";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";
import { AutoTooltipText } from "@/components/ui/auto-tooltip-text.tsx";
import { ISpace, SpaceView } from "@/features/space/types/space.types";

function WatchButton({
  spaceId,
  watchedIds,
  size = 16,
}: {
  spaceId: string;
  watchedIds: Set<string>;
  size?: number;
}) {
  const { t } = useTranslation();
  const watchMutation = useWatchSpaceMutation();
  const unwatchMutation = useUnwatchSpaceMutation();
  const isWatching = watchedIds.has(spaceId);
  const isPending = watchMutation.isPending || unwatchMutation.isPending;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isWatching) {
      unwatchMutation.mutate(spaceId);
    } else {
      watchMutation.mutate(spaceId);
    }
  };

  const label = isWatching ? t("Stop watching space") : t("Watch space");

  return (
    <Tooltip label={label} openDelay={250} withArrow>
      <ActionIcon
        variant="subtle"
        color={isWatching ? "blue" : "gray"}
        aria-label={label}
        aria-pressed={isWatching}
        onClick={handleToggle}
        loading={isPending}
      >
        {isWatching ? (
          <IconEyeOff size={size} stroke={2} />
        ) : (
          <IconEye size={size} stroke={2} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}

function SpaceLink({ space, inTable }: { space: ISpace; inTable?: boolean }) {
  return (
    <Anchor
      size="sm"
      underline="never"
      className={clsx(classes.spaceLink, inTable && rowClasses.link)}
      component={Link}
      to={getSpaceUrl(space.slug)}
      aria-label={space.name}
      onMouseEnter={() => prefetchSpace(space.slug, space.id)}
    >
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
        <CustomAvatar
          name={space.name}
          avatarUrl={space.logo}
          type={AvatarIconType.SPACE_ICON}
          color="initials"
          variant="filled"
          size="md"
        />
        <AutoTooltipText fz="sm" fw={500} lineClamp={1} style={{ minWidth: 0 }}>
          {space.name}
        </AutoTooltipText>
      </Group>
    </Anchor>
  );
}

function SpaceTypeBadge({ space }: { space: ISpace }) {
  const { t } = useTranslation();
  const label = !space.personalOwnerId
    ? t("Public space")
    : space.isDefaultPersonal
      ? t("Default personal space")
      : t("Private space");

  return (
    <Badge
      variant="light"
      color={space.personalOwnerId ? "gray" : "blue"}
      size="sm"
      title={label}
    >
      {label}
    </Badge>
  );
}

interface AllSpacesListProps {
  spaces: ISpace[];
  view: SpaceView;
  isLoading: boolean;
  isError: boolean;
  emptyMessage: string;
  hasPrevPage?: boolean;
  hasNextPage?: boolean;
  total?: number;
  onNext: () => void;
  onPrev: () => void;
}

export default function AllSpacesList({
  spaces,
  view,
  isLoading,
  isError,
  emptyMessage,
  hasPrevPage,
  hasNextPage,
  total,
  onNext,
  onPrev,
}: AllSpacesListProps) {
  const { t } = useTranslation();
  const watchedIds = useWatchedSpaceIds();
  const [settingsOpened, { open: openSettings, close: closeSettings }] =
    useDisclosure(false);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);

  const renderActions = (space: ISpace) => (
    <Group gap={4} justify="flex-end" wrap="nowrap" style={{ flexShrink: 0 }}>
      <StarButton type="space" spaceId={space.id} name={space.name} size={16} />
      <WatchButton spaceId={space.id} watchedIds={watchedIds} />
      <Menu position="bottom-end">
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={t("Space menu")}
          >
            <IconDots size={16} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconSettings size={16} />}
            onClick={() => {
              setSelectedSpaceId(space.id);
              openSettings();
            }}
          >
            {t("Space settings")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );

  if (isLoading) {
    return (
      <Center py="xl" role="status" aria-label={t("Loading spaces")}>
        <Loader size="sm" />
      </Center>
    );
  }

  if (isError) {
    return (
      <Text py="xl" ta="center" role="alert">
        {t("Failed to load spaces")}
      </Text>
    );
  }

  return (
    <Box>
      {spaces.length === 0 ? (
        <Text py="xl" ta="center" c="dimmed">
          {emptyMessage}
        </Text>
      ) : view === "cards" ? (
        <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }}>
          {spaces.map((space) => (
            <Card key={space.id} withBorder radius="md" padding="md">
              <Stack gap="sm" h="100%">
                <SpaceLink space={space} />
                {space.description && (
                  <Text size="sm" c="dimmed" lineClamp={2}>
                    {space.description}
                  </Text>
                )}
                <Group
                  mt="auto"
                  justify="space-between"
                  align="center"
                  gap="xs"
                  wrap="nowrap"
                >
                  <SpaceTypeBadge space={space} />
                  {renderActions(space)}
                </Group>
              </Stack>
            </Card>
          ))}
        </SimpleGrid>
      ) : (
        <Table.ScrollContainer minWidth={530}>
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Caption>
              <VisuallyHidden>
                {t("List of spaces in this workspace")}
              </VisuallyHidden>
            </Table.Caption>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("Space")}</Table.Th>
                <Table.Th>{t("Type")}</Table.Th>
                <Table.Th>{t("Members")}</Table.Th>
                <Table.Th w={116}>
                  <VisuallyHidden>{t("Action")}</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {spaces.map((space) => (
                <Table.Tr key={space.id} className={rowClasses.row}>
                  <Table.Td>
                    <SpaceLink space={space} inTable />
                  </Table.Td>
                  <Table.Td>
                    <SpaceTypeBadge space={space} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" style={{ whiteSpace: "nowrap" }}>
                      {formatMemberCount(space.memberCount, t)}
                    </Text>
                  </Table.Td>
                  <Table.Td>{renderActions(space)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {total !== undefined && (
        <Paginate
          hasPrevPage={hasPrevPage}
          hasNextPage={hasNextPage}
          onNext={onNext}
          onPrev={onPrev}
          label={
            <Text size="sm" c="dimmed">
              {t("Total spaces")}: {total}
            </Text>
          }
        />
      )}

      {selectedSpaceId && (
        <SpaceSettingsModal
          spaceId={selectedSpaceId}
          opened={settingsOpened}
          onClose={closeSettings}
        />
      )}
    </Box>
  );
}
