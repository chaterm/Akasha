import { Button } from "@mantine/core";
import {
  IconActivityHeartbeat,
  IconBuilding,
  IconChevronDown,
  IconTopologyStar3,
} from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role";
import { SpaceFilterMenu } from "@/features/space/components/space-filter-menu";
import classes from "../styles/ai-chat.module.css";

type Props = {
  options: Array<{ value: string; label: string }>;
  selectedSpaceId: string | null;
  onChange: (spaceId: string | null) => void;
  isLoading?: boolean;
  compact?: boolean;
  showManagementLinks?: boolean;
};

export default function KnowledgeScopeBar({
  options,
  selectedSpaceId,
  onChange,
  isLoading,
  compact,
  showManagementLinks,
}: Props) {
  const { t } = useTranslation();
  const { isAdmin } = useUserRole();
  const selectedSpace = selectedSpaceId
    ? options.find((option) => option.value === selectedSpaceId)
    : undefined;
  const selectionLabel = selectedSpaceId
    ? `${t("Space")}: ${selectedSpace?.label ?? t("Unknown")}`
    : `${t("Space")}: ${t("All spaces")}`;

  return (
    <div
      className={classes.knowledgeScopeBar}
      data-compact={compact || undefined}
    >
      <SpaceFilterMenu
        value={selectedSpaceId}
        onChange={onChange}
        position="bottom-start"
        width={300}
      >
        <Button
          variant="subtle"
          color="gray"
          size="sm"
          className={classes.knowledgeScopeSelect}
          leftSection={<IconBuilding size={16} />}
          rightSection={<IconChevronDown size={14} />}
          disabled={isLoading}
          aria-label={t("Knowledge spaces")}
        >
          {isLoading ? t("Loading knowledge spaces...") : selectionLabel}
        </Button>
      </SpaceFilterMenu>

      {!compact && (
        <div className={classes.knowledgeScopeHint}>
          {t("Answers are limited to readable content in the selected spaces.")}
        </div>
      )}

      {showManagementLinks && (
        <div className={classes.knowledgeManagementLinks}>
          <Button
            component={Link}
            to="/knowledge/graph"
            variant="subtle"
            color="gray"
            size="compact-sm"
            leftSection={<IconTopologyStar3 size={15} />}
          >
            {t("Knowledge graph")}
          </Button>
          {isAdmin && (
            <Button
              component={Link}
              to="/knowledge/admin"
              variant="subtle"
              color="gray"
              size="compact-sm"
              leftSection={<IconActivityHeartbeat size={15} />}
            >
              {t("Diagnostics")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
