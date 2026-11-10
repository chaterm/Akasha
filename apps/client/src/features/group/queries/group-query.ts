import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { IGroup, IGroupTreeNode } from "@/features/group/types/group.types";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupMembers,
  getGroups,
  getGroupTree,
  removeGroupMember,
  updateGroup,
} from "@/features/group/services/group-service";
import { notifications } from "@mantine/notifications";
import { IPagination, QueryParams } from "@/lib/types.ts";
import { IUser } from "@/features/user/types/user.types.ts";
import { useEffect } from "react";
import { validate as isValidUuid } from "uuid";
import { queryClient } from "@/main.tsx";
import { useTranslation } from 'react-i18next';
import { notifyError } from "@/lib/errors";

export function useGetGroupsQuery(
  params?: QueryParams,
): UseQueryResult<IPagination<IGroup>, Error> {
  const query = useQuery({
    queryKey: ["groups", params],
    queryFn: () => getGroups(params),
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (query.data) {
      if (query.data.items?.length > 0) {
        query.data.items.forEach((group: IGroup) => {
          queryClient.setQueryData(["group", group.id], group);
        });
      }
    }
  }, [query.data]);

  return query;
}

export function useGroupTreeQuery(): UseQueryResult<IGroupTreeNode[], Error> {
  return useQuery({
    queryKey: ["groupTree"],
    queryFn: () => getGroupTree(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useGroupQuery(groupId: string): UseQueryResult<IGroup, Error> {
  return useQuery({
    queryKey: ["group", groupId],
    queryFn: () => getGroupById(groupId),
    enabled: !!groupId,
  });
}

export function useCreateGroupMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IGroup, Error, Partial<IGroup>>({
    mutationFn: (data) => createGroup(data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["groups"],
      });

      notifications.show({ message: t("Group created successfully") });
    },
    onError: (error) => notifyError(error, "Failed to create group"),
  });
}

export function useUpdateGroupMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IGroup, Error, Partial<IGroup>>({
    mutationFn: (data) => updateGroup(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Group updated successfully") });
      queryClient.invalidateQueries({
        queryKey: ["group", variables.groupId],
      });
    },
    onError: (error) => notifyError(error, "Failed to update group"),
  });
}

export function useDeleteGroupMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (groupId: string) => deleteGroup({ groupId }),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Group deleted successfully") });
      queryClient.refetchQueries({ queryKey: ["groups"] });
    },
    onError: (error) => notifyError(error, "Failed to delete group"),
  });
}

export function useGroupMembersQuery(
  groupId: string,
  params?: QueryParams,
): UseQueryResult<IPagination<IUser>, Error> {
  return useQuery({
    queryKey: ["groupMembers", groupId, params],
    queryFn: () => getGroupMembers(groupId, params),
    enabled: !!groupId,
    placeholderData: keepPreviousData,
  });
}

export function useAddGroupMemberMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<void, Error, { groupId: string; userIds: string[] }>({
    mutationFn: (data) => addGroupMember(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Added successfully") });
      queryClient.invalidateQueries({
        queryKey: ["groupMembers", variables.groupId],
      });
    },
    onError: (error) => notifyError(error, "Failed to add group members"),
  });
}

export function useRemoveGroupMemberMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<
    void,
    Error,
    {
      groupId: string;
      userId: string;
    }
  >({
    mutationFn: (data) => removeGroupMember(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Removed successfully") });
      queryClient.invalidateQueries({
        queryKey: ["groupMembers", variables.groupId],
      });
    },
    onError: (error) => notifyError(error, "Failed to remove group member"),
  });
}
