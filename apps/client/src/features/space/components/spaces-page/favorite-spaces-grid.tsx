import {
  Anchor,
  Text,
  SimpleGrid,
  Card,
  rem,
  Group,
  Box,
  Button,
  Title,
} from "@mantine/core";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useFavoritesQuery } from "@/features/favorite/queries/favorite-query";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { AvatarIconType } from "@/features/attachments/types/attachment.types";
import { getSpaceUrl } from "@/lib/config";
import { prefetchSpace } from "@/features/space/queries/space-query";
import StarButton from "@/features/favorite/components/star-button";
import { IconChevronDown } from "@tabler/icons-react";
import spaceClasses from "../space-grid.module.css";

const INITIAL_COUNT = 8;

export default function FavoriteSpacesGrid() {
  const { t } = useTranslation();
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useFavoritesQuery("space");
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();

  const allSpaces = (data?.pages.flatMap((p) => p.items) ?? [])
    .flatMap((favorite) => (favorite.space ? [favorite.space] : []))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (allSpaces.length === 0 && !hasNextPage) return null;

  const visibleSpaces = expanded
    ? allSpaces
    : allSpaces.slice(0, INITIAL_COUNT);
  const hasHiddenSpaces = !expanded && allSpaces.length > INITIAL_COUNT;

  return (
    <Box component="section" aria-labelledby={titleId} mb="xl">
      <Title id={titleId} order={2} size="h6" fw={500} mb="md">
        {t("Favorite spaces")}
      </Title>

      <SimpleGrid cols={{ base: 1, xs: 2, sm: 4 }}>
        {visibleSpaces.map((space) => (
          <Card
            key={space.id}
            p="xs"
            radius="md"
            onMouseEnter={() => prefetchSpace(space.slug, space.id)}
            className={spaceClasses.card}
            withBorder
          >
            <Card.Section className={spaceClasses.cardSection} h={40}>
              <Box
                className={spaceClasses.starButton}
                data-favorited="true"
                style={{ zIndex: 1 }}
              >
                <StarButton
                  type="space"
                  spaceId={space.id}
                  name={space.name}
                  size={16}
                  isFavorited
                />
              </Box>
            </Card.Section>
            <CustomAvatar
              name={space.name}
              avatarUrl={space.logo}
              type={AvatarIconType.SPACE_ICON}
              color="initials"
              variant="filled"
              size="md"
              mt={rem(-20)}
            />
            <Text fz="md" fw={500} mt="xs" className={spaceClasses.title}>
              <Anchor
                component={Link}
                to={getSpaceUrl(space.slug)}
                inherit
                c="inherit"
                underline="never"
                className={spaceClasses.cardLink}
              >
                {space.name}
              </Anchor>
            </Text>
          </Card>
        ))}
      </SimpleGrid>

      {(hasHiddenSpaces || hasNextPage) && (
        <Group justify="center" mt="sm">
          <Button
            variant="subtle"
            size="xs"
            rightSection={<IconChevronDown size={14} />}
            loading={isFetchingNextPage}
            onClick={() => {
              setExpanded(true);
              if (!hasHiddenSpaces) void fetchNextPage();
            }}
          >
            {t("Show more")}
          </Button>
        </Group>
      )}
    </Box>
  );
}
