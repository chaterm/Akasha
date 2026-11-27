import { Button, Group } from "@mantine/core";
import { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface PagePaginationProps {
  hasPrevPage: boolean;
  hasNextPage: boolean;
  onPrev: () => void;
  onNext: () => void;
  label?: ReactNode;
}

export default function Paginate({
  hasPrevPage,
  hasNextPage,
  onPrev,
  onNext,
  label,
}: PagePaginationProps) {
  const { t } = useTranslation();

  if (!hasPrevPage && !hasNextPage && !label) {
    return null;
  }

  return (
    <Group
      mt="md"
      justify={label ? "space-between" : "flex-end"}
      align="center"
    >
      {label}

      {(hasPrevPage || hasNextPage) && (
        <Group gap="sm">
          <Button
            variant="default"
            size="compact-sm"
            onClick={onPrev}
            disabled={!hasPrevPage}
          >
            {t("Prev")}
          </Button>

          <Button
            variant="default"
            size="compact-sm"
            onClick={onNext}
            disabled={!hasNextPage}
          >
            {t("Next page")}
          </Button>
        </Group>
      )}
    </Group>
  );
}
