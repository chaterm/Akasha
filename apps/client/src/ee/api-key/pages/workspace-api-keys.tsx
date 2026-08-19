import React, { useState } from "react";
import { Anchor, Button, Group, Space, Tabs, Text } from "@mantine/core";
import { Helmet } from "react-helmet-async";
import { Trans, useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title";
import { getAppName } from "@/lib/config";
import { ApiKeyTable } from "@/ee/api-key/components/api-key-table";
import { CreateApiKeyModal } from "@/ee/api-key/components/create-api-key-modal";
import { CreatePublicApiKeyModal } from "@/ee/api-key/components/create-public-api-key-modal";
import { ApiKeyCreatedModal } from "@/ee/api-key/components/api-key-created-modal";
import { UpdateApiKeyModal } from "@/ee/api-key/components/update-api-key-modal";
import { UpdatePublicApiKeyModal } from "@/ee/api-key/components/update-public-api-key-modal";
import { RevokeApiKeyModal } from "@/ee/api-key/components/revoke-api-key-modal";
import Paginate from "@/components/common/paginate";
import { useCursorPaginate } from "@/hooks/use-cursor-paginate";
import {
  useGetApiKeysQuery,
  useGetPublicApiKeysQuery,
} from "@/ee/api-key/queries/api-key-query.ts";
import { IApiKey } from "@/ee/api-key";
import useUserRole from "@/hooks/use-user-role.tsx";

type ApiKeyTab = "personal" | "public";

export default function WorkspaceApiKeys() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ApiKeyTab>("personal");
  const personalPagination = useCursorPaginate();
  const publicPagination = useCursorPaginate();
  const [createModalOpened, setCreateModalOpened] = useState(false);
  const [createPublicModalOpened, setCreatePublicModalOpened] = useState(false);
  const [createdApiKey, setCreatedApiKey] = useState<IApiKey | null>(null);
  const [updateModalOpened, setUpdateModalOpened] = useState(false);
  const [revokeModalOpened, setRevokeModalOpened] = useState(false);
  const [selectedApiKey, setSelectedApiKey] = useState<IApiKey | null>(null);
  const personalQuery = useGetApiKeysQuery(
    {
      cursor: personalPagination.cursor,
      adminView: true,
    },
    activeTab === "personal",
  );
  const publicQuery = useGetPublicApiKeysQuery(
    {
      cursor: publicPagination.cursor,
    },
    activeTab === "public",
  );
  const { isAdmin } = useUserRole();
  const currentQuery = activeTab === "personal" ? personalQuery : publicQuery;
  const currentPagination =
    activeTab === "personal" ? personalPagination : publicPagination;

  if (!isAdmin) {
    return null;
  }

  const handleCreateSuccess = (response: IApiKey) => {
    setCreatedApiKey(response);
  };

  const handleUpdate = (apiKey: IApiKey) => {
    setSelectedApiKey(apiKey);
    setUpdateModalOpened(true);
  };

  const handleRevoke = (apiKey: IApiKey) => {
    setSelectedApiKey(apiKey);
    setRevokeModalOpened(true);
  };

  return (
    <>
      <Helmet>
        <title>
          {t("API management")} - {getAppName()}
        </title>
      </Helmet>

      <SettingsTitle title={t("API management")} />

      <Text size="sm" c="dimmed" mb="md">
        <Trans
          i18nKey="Manage API keys for all users in the workspace. View the <anchor>API documentation</anchor> for usage details."
          components={{
            anchor: (
              <Anchor
                href="https://akasha.com/api-docs"
                target="_blank"
                size="sm"
              />
            ),
          }}
        />{" "}
        {t(
          "API keys and Akasha Skills follow the key owner's existing space and page permissions, including public/shared spaces they can edit. Page edits use normal version history and can be rolled back in Akasha.",
        )}
      </Text>

      <Tabs
        value={activeTab}
        onChange={(value) => setActiveTab((value as ApiKeyTab) ?? "personal")}
      >
        <Group justify="space-between" align="flex-end" mb="md">
          <Tabs.List>
            <Tabs.Tab value="personal">{t("Personal API keys")}</Tabs.Tab>
            <Tabs.Tab value="public">{t("Public API keys")}</Tabs.Tab>
          </Tabs.List>

          {activeTab === "personal" ? (
            <Button onClick={() => setCreateModalOpened(true)}>
              {t("Create API Key")}
            </Button>
          ) : (
            <Button onClick={() => setCreatePublicModalOpened(true)}>
              {t("Create Public API key")}
            </Button>
          )}
        </Group>
      </Tabs>

      <ApiKeyTable
        apiKeys={currentQuery.data?.items}
        isLoading={currentQuery.isLoading}
        showUserColumn={activeTab === "personal"}
        showSpacesColumn={activeTab === "public"}
        onUpdate={handleUpdate}
        onRevoke={handleRevoke}
      />

      <Space h="md" />

      {currentQuery.data?.items.length > 0 && (
        <Paginate
          hasPrevPage={currentQuery.data?.meta?.hasPrevPage}
          hasNextPage={currentQuery.data?.meta?.hasNextPage}
          onNext={() =>
            currentPagination.goNext(currentQuery.data?.meta?.nextCursor)
          }
          onPrev={currentPagination.goPrev}
        />
      )}

      <CreateApiKeyModal
        opened={createModalOpened}
        onClose={() => setCreateModalOpened(false)}
        onSuccess={handleCreateSuccess}
      />

      <CreatePublicApiKeyModal
        opened={createPublicModalOpened}
        onClose={() => setCreatePublicModalOpened(false)}
        onSuccess={handleCreateSuccess}
      />

      <ApiKeyCreatedModal
        opened={!!createdApiKey}
        onClose={() => setCreatedApiKey(null)}
        apiKey={createdApiKey}
      />

      {selectedApiKey?.keyType === "public_retrieval" ? (
        <UpdatePublicApiKeyModal
          opened={updateModalOpened}
          onClose={() => {
            setUpdateModalOpened(false);
            setSelectedApiKey(null);
          }}
          apiKey={selectedApiKey}
        />
      ) : (
        <UpdateApiKeyModal
          opened={updateModalOpened}
          onClose={() => {
            setUpdateModalOpened(false);
            setSelectedApiKey(null);
          }}
          apiKey={selectedApiKey}
        />
      )}

      <RevokeApiKeyModal
        opened={revokeModalOpened}
        onClose={() => {
          setRevokeModalOpened(false);
          setSelectedApiKey(null);
        }}
        apiKey={selectedApiKey}
      />
    </>
  );
}
