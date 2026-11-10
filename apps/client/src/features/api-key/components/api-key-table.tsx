import { ActionIcon, Group, Menu, Table, Text } from "@mantine/core";
import { IconDots, IconEdit, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { IApiKey } from "@/features/api-key";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import React from "react";
import NoTableResults from "@/components/common/no-table-results";
import { formatLocalized, useDateFnsLocale } from "@/lib/date-locale.ts";

interface ApiKeyTableProps {
  apiKeys: IApiKey[];
  isLoading?: boolean;
  showUserColumn?: boolean;
  userColumnLabel?: string;
  keyNameLabel?: string;
  isAgentTable?: boolean;
  showSpacesColumn?: boolean;
  onUpdate?: (apiKey: IApiKey) => void;
  onRevoke?: (apiKey: IApiKey) => void;
  onRotate?: (apiKey: IApiKey) => void;
}

export function ApiKeyTable({
  apiKeys,
  isLoading,
  showUserColumn = false,
  userColumnLabel,
  keyNameLabel,
  isAgentTable = false,
  showSpacesColumn = false,
  onUpdate,
  onRevoke,
  onRotate,
}: ApiKeyTableProps) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();

  const formatDate = (date: Date | string | null) => {
    if (!date) return t("Never");
    return formatLocalized(date, "MMM dd, yyyy", "PP", locale);
  };

  const isExpired = (expiresAt: string | null) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  return (
    <Table.ScrollContainer minWidth={isAgentTable ? 1120 : 500}>
      <Table highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={isAgentTable ? 220 : undefined}>{keyNameLabel ?? t("Name")}</Table.Th>
            {showUserColumn && <Table.Th w={isAgentTable ? 300 : undefined}>{userColumnLabel ?? t("User")}</Table.Th>}
            {showSpacesColumn && <Table.Th w={320}>{t("Spaces")}</Table.Th>}
            <Table.Th w={isAgentTable ? 140 : undefined}>{t("Last used")}</Table.Th>
            <Table.Th w={isAgentTable ? 120 : undefined}>{t("Expires")}</Table.Th>
            <Table.Th w={isAgentTable ? 140 : undefined}>{t("Created")}</Table.Th>
            <Table.Th aria-label={t("Action")} />
          </Table.Tr>
        </Table.Thead>

        <Table.Tbody>
          {apiKeys && apiKeys.length > 0 ? (
            apiKeys.map((apiKey: IApiKey, index: number) => (
              <Table.Tr key={index}>
                <Table.Td w={isAgentTable ? 220 : undefined}>
                  <Text fz="sm" fw={500}>
                    {apiKey.name}
                  </Text>
                </Table.Td>

                {showUserColumn && (apiKey.agentUser || apiKey.creator) && (
                  <Table.Td w={isAgentTable ? 300 : undefined}>
                    {isAgentTable ? (
                      <Text fz="sm" lineClamp={1}>
                        {apiKey.agentUser?.email || "-"}
                      </Text>
                    ) : (
                      <Group gap="4" wrap="nowrap">
                        <CustomAvatar
                          avatarUrl={apiKey.creator?.avatarUrl}
                          name={apiKey.creator?.name}
                          size="sm"
                        />
                        <Text fz="sm" lineClamp={1}>
                          {apiKey.creator?.name || "-"}
                        </Text>
                      </Group>
                    )}
                  </Table.Td>
                )}

                {showSpacesColumn && (
                  <Table.Td w={isAgentTable ? 360 : 320} maw={isAgentTable ? 360 : 320}>
                    <Text fz="sm" lineClamp={2}>
                      {(apiKey.spaces ?? [])
                        .map((space) => space.name ?? space.id)
                        .join(", ") || "-"}
                    </Text>
                  </Table.Td>
                )}

                <Table.Td>
                  <Text fz="sm" style={{ whiteSpace: "nowrap" }}>
                    {formatDate(apiKey.lastUsedAt)}
                  </Text>
                </Table.Td>

                <Table.Td>
                  {apiKey.expiresAt ? (
                    isExpired(apiKey.expiresAt) ? (
                      <Text fz="sm" style={{ whiteSpace: "nowrap" }}>
                        {t("Expired")}
                      </Text>
                    ) : (
                      <Text fz="sm" style={{ whiteSpace: "nowrap" }}>
                        {formatDate(apiKey.expiresAt)}
                      </Text>
                    )
                  ) : (
                    <Text fz="sm" style={{ whiteSpace: "nowrap" }}>
                      {t("Never")}
                    </Text>
                  )}
                </Table.Td>

                <Table.Td>
                  <Text fz="sm" style={{ whiteSpace: "nowrap" }}>
                    {formatDate(apiKey.createdAt)}
                  </Text>
                </Table.Td>

                <Table.Td>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={t("API key menu")}
                      >
                        <IconDots size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      {onUpdate && (
                        <Menu.Item
                          leftSection={<IconEdit size={16} />}
                          onClick={() => onUpdate(apiKey)}
                        >
                          {apiKey.keyType === "agent" ? t("Edit Agent") : t("Edit")}
                        </Menu.Item>
                      )}
                      {onRevoke && (
                        <Menu.Item
                          leftSection={<IconTrash size={16} />}
                          color="red"
                          onClick={() => onRevoke(apiKey)}
                        >
                          {apiKey.keyType === "agent" ? t("Delete Agent") : t("Revoke")}
                        </Menu.Item>
                      )}
                      {isAgentTable && onRotate && (
                        <Menu.Item
                          leftSection={<IconRefresh size={16} />}
                          onClick={() => onRotate(apiKey)}
                        >
                          {t("Rotate key")}
                        </Menu.Item>
                      )}
                    </Menu.Dropdown>
                  </Menu>
                </Table.Td>
              </Table.Tr>
            ))
          ) : (
            <NoTableResults
              colSpan={5 + Number(showUserColumn) + Number(showSpacesColumn)}
            />
          )}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
