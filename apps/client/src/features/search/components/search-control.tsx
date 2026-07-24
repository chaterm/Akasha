import { IconSearch } from "@tabler/icons-react";
import cx from "clsx";
import {
  ActionIcon,
  BoxProps,
  ElementProps,
  Group,
  rem,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import classes from "./search-control.module.css";
import React from "react";
import { useTranslation } from "react-i18next";
import { platformModifierLabel } from "@/lib";

interface SearchControlProps extends BoxProps, ElementProps<"button"> {
  compact?: boolean;
}

export function SearchControl({
  className,
  compact = false,
  ...others
}: SearchControlProps) {
  const { t } = useTranslation();

  if (compact) {
    return (
      <Tooltip
        label={`${t("Search")} (${platformModifierLabel} + K)`}
        openDelay={250}
        withArrow
      >
        <UnstyledButton
          {...others}
          className={cx(classes.compactRoot, className)}
          aria-label={t("Search")}
        >
          <Group gap={6} wrap="nowrap">
            <IconSearch
              style={{ width: rem(16), height: rem(16) }}
              stroke={1.75}
            />
            <Text fz="sm" fw={500} inherit>
              {t("Search")}
            </Text>
          </Group>
        </UnstyledButton>
      </Tooltip>
    );
  }

  return (
    <UnstyledButton {...others} className={cx(classes.root, className)}>
      <Group gap="xs" wrap="nowrap">
        <IconSearch style={{ width: rem(15), height: rem(15) }} stroke={1.5} />
        <Text fz="sm" c="dimmed" pr={80}>
          {t("Search")}
        </Text>
        <Text fw={700} className={classes.shortcut}>
          {platformModifierLabel} + K
        </Text>
      </Group>
    </UnstyledButton>
  );
}

interface SearchMobileControlProps {
  onSearch: () => void;
}

export function SearchMobileControl({ onSearch }: SearchMobileControlProps) {
  const { t } = useTranslation();

  return (
    <Tooltip label={t("Search")} withArrow>
      <ActionIcon
        variant="subtle"
        color="dark"
        aria-label={t("Search")}
        onClick={onSearch}
        size="sm"
      >
        <IconSearch size={20} stroke={2} />
      </ActionIcon>
    </Tooltip>
  );
}
