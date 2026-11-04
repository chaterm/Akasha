import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  ICreateShare,
  IShare,
  ISharedItem,
  ISharedPage,
  ISharedPageTree,
  IShareForPage,
  IShareInfoInput,
  IUpdateShare,
} from "@/features/share/types/share.types.ts";
import {
  createShare,
  deleteShare,
  getSharedPageTree,
  getShareForPage,
  getShareInfo,
  getSharePageInfo,
  getShares,
  updateShare,
} from "@/features/share/services/share-service.ts";
import { IPagination, QueryParams } from "@/lib/types.ts";
import { notifyError } from "@/lib/errors";

export function useGetSharesQuery(
  params?: QueryParams,
): UseQueryResult<IPagination<ISharedItem>, Error> {
  return useQuery({
    queryKey: ["share-list", params],
    queryFn: () => getShares(params),
    placeholderData: keepPreviousData,
  });
}

export function useGetShareByIdQuery(
  shareId: string,
): UseQueryResult<IShare, Error> {
  const query = useQuery({
    queryKey: ["share-by-id", shareId],
    queryFn: () => getShareInfo(shareId),
    enabled: !!shareId,
  });

  return query;
}

export function useSharePageQuery(
  shareInput: Partial<IShareInfoInput>,
): UseQueryResult<ISharedPage, Error> {
  const query = useQuery({
    queryKey: ["shares", shareInput],
    queryFn: () => getSharePageInfo(shareInput),
    enabled: !!shareInput.pageId,
  });

  return query;
}

export function useShareForPageQuery(
  pageId: string,
): UseQueryResult<IShareForPage | null, Error> {
  const query = useQuery({
    queryKey: ["share-for-page", pageId],
    queryFn: () => getShareForPage(pageId),
    enabled: !!pageId,
    staleTime: 60 * 1000,
    retry: false,
  });

  return query;
}

export function useCreateShareMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<any, Error, ICreateShare>({
    mutationFn: (data) => createShare(data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        predicate: (item) =>
          ["share-for-page", "share-list"].includes(item.queryKey[0] as string),
      });
    },
    onError: (error) => notifyError(error, "Failed to share page"),
  });
}

export function useUpdateShareMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<any, Error, IUpdateShare>({
    mutationFn: (data) => updateShare(data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        predicate: (item) =>
          ["share-for-page", "share-list"].includes(item.queryKey[0] as string),
      });
    },
    onError: (error, params) => {
      if (error?.["status"] === 404) {
        queryClient.removeQueries({
          predicate: (item) =>
            ["share-for-page"].includes(item.queryKey[0] as string),
        });

        notifications.show({
          message: t("Share not found"),
          color: "red",
        });
        return;
      }

      notifyError(error, "Failed to update share");
    },
  });
}

export function useDeleteShareMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (shareId: string) => deleteShare(shareId),
    onSuccess: (data) => {
      queryClient.removeQueries({
        predicate: (item) =>
          ["share-for-page"].includes(item.queryKey[0] as string),
      });

      queryClient.invalidateQueries({
        predicate: (item) =>
          ["share-list"].includes(item.queryKey[0] as string),
      });

      notifications.show({ message: t("Share deleted successfully") });
    },
    onError: (error) => {
      if (error?.["status"] === 404) {
        queryClient.removeQueries({
          predicate: (item) =>
            ["share-for-page"].includes(item.queryKey[0] as string),
        });
      }

      notifyError(error, "Failed to delete share");
    },
  });
}

export function useGetSharedPageTreeQuery(
  shareId: string,
): UseQueryResult<ISharedPageTree, Error> {
  return useQuery({
    queryKey: ["shared-page-tree", shareId],
    queryFn: () => getSharedPageTree(shareId),
    enabled: !!shareId,
    placeholderData: keepPreviousData,
    staleTime: 60 * 60 * 1000,
  });
}
