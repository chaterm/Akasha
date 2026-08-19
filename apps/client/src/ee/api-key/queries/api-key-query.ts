import { IPagination, QueryParams } from "@/lib/types.ts";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  createApiKey,
  createPublicApiKey,
  getPublicApiKeys,
  getPublicApiKeySpaces,
  getApiKeys,
  IApiKey,
  ICreateApiKeyRequest,
  IUpdateApiKeyRequest,
  IUpdatePublicApiKeyRequest,
  revokeApiKey,
  updatePublicApiKey,
  updateApiKey,
} from "@/ee/api-key";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";

export function useGetApiKeysQuery(
  params?: QueryParams,
  enabled = true,
): UseQueryResult<IPagination<IApiKey>, Error> {
  return useQuery({
    queryKey: ["api-key-list", params],
    queryFn: () => getApiKeys(params),
    enabled,
    staleTime: 0,
    gcTime: 0,
    placeholderData: keepPreviousData,
  });
}

export function useGetPublicApiKeysQuery(
  params?: QueryParams,
  enabled = true,
): UseQueryResult<IPagination<IApiKey>, Error> {
  return useQuery({
    queryKey: ["api-key-list", "public", params],
    queryFn: () => getPublicApiKeys(params),
    enabled,
    staleTime: 0,
    gcTime: 0,
    placeholderData: keepPreviousData,
  });
}

export function useGetPublicApiKeySpacesQuery() {
  return useQuery({
    queryKey: ["public-api-key-spaces"],
    queryFn: getPublicApiKeySpaces,
  });
}

export function useRevokeApiKeyMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<
    void,
    Error,
    {
      apiKeyId: string;
    }
  >({
    mutationFn: (data) => revokeApiKey(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Revoked successfully") });
      queryClient.invalidateQueries({
        predicate: (item) =>
          ["api-key-list"].includes(item.queryKey[0] as string),
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useCreateApiKeyMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IApiKey, Error, ICreateApiKeyRequest>({
    mutationFn: (data) => createApiKey(data),
    onSuccess: () => {
      notifications.show({
        message: t("{{credential}} created successfully", {
          credential: t("API key"),
        }),
      });
      queryClient.invalidateQueries({
        predicate: (item) =>
          ["api-key-list"].includes(item.queryKey[0] as string),
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useCreatePublicApiKeyMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IApiKey, Error, Parameters<typeof createPublicApiKey>[0]>({
    mutationFn: createPublicApiKey,
    onSuccess: () => {
      notifications.show({
        message: t("{{credential}} created successfully", {
          credential: t("Public API key"),
        }),
      });
      queryClient.invalidateQueries({ queryKey: ["api-key-list"] });
    },
    onError: (error) => {
      notifications.show({
        message: error["response"]?.data?.message,
        color: "red",
      });
    },
  });
}

export function useUpdateApiKeyMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IApiKey, Error, IUpdateApiKeyRequest>({
    mutationFn: (data) => updateApiKey(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Updated successfully") });
      queryClient.invalidateQueries({
        predicate: (item) =>
          ["api-key-list"].includes(item.queryKey[0] as string),
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useUpdatePublicApiKeyMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IApiKey, Error, IUpdatePublicApiKeyRequest>({
    mutationFn: (data) => updatePublicApiKey(data),
    onSuccess: () => {
      notifications.show({ message: t("Updated successfully") });
      queryClient.invalidateQueries({ queryKey: ["api-key-list"] });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}
