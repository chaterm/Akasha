import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  changeMemberRole,
  getInvitationById,
  getPendingInvitations,
  getWorkspaceMembers,
  createInvitation,
  resendInvitation,
  revokeInvitation,
  getWorkspace,
  getWorkspacePublicData,
  getAppVersion,
  deleteWorkspaceMember,
  deactivateWorkspaceMember,
  activateWorkspaceMember,
  GetWorkspaceMember,
} from "@/features/workspace/services/workspace-service";
import { IPagination, QueryParams } from "@/lib/types.ts";
import { notifications } from "@mantine/notifications";
import {
  ICreateInvite,
  IInvitation,
  IPublicWorkspace,
  IVersion,
  IWorkspace,
  IWorkspaceMemberDetail,
} from "@/features/workspace/types/workspace.types.ts";
import { IUser } from "@/features/user/types/user.types.ts";
import { useTranslation } from "react-i18next";
import { notifyError } from "@/lib/errors";

export function useWorkspaceQuery(): UseQueryResult<IWorkspace, Error> {
  return useQuery({
    queryKey: ["workspace"],
    queryFn: () => getWorkspace(),
  });
}

export function useWorkspacePublicDataQuery(): UseQueryResult<
  IPublicWorkspace,
  Error
> {
  return useQuery({
    queryKey: ["workspace-public"],
    queryFn: () => getWorkspacePublicData(),
  });
}

export function useWorkspaceMembersQuery(
  params?: QueryParams,
): UseQueryResult<IPagination<IUser>, Error> {
  return useQuery({
    queryKey: ["workspaceMembers", params],
    queryFn: () => getWorkspaceMembers(params),
    placeholderData: keepPreviousData,
  });
}

export function useWorkspaceMemberQuery(
  userId: string,
  enabled = true,
): UseQueryResult<IWorkspaceMemberDetail, Error> {
  return useQuery({
    queryKey: ["workspaceMember", userId],
    queryFn: () => GetWorkspaceMember(userId),
    enabled: enabled && !!userId,
  });
}

export function useDeleteWorkspaceMemberMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<
    void,
    Error,
    {
      userId: string;
    }
  >({
    mutationFn: (data) => deleteWorkspaceMember(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Member deleted successfully") });
      queryClient.invalidateQueries({
        queryKey: ["workspaceMembers"],
      });
      queryClient.removeQueries({
        queryKey: ["workspaceMember", variables.userId],
        exact: true,
      });
    },
    onError: (error) => notifyError(error, "Failed to delete member"),
  });
}

export function useDeactivateWorkspaceMemberMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    void,
    Error,
    {
      userId: string;
    }
  >({
    mutationFn: (data) => deactivateWorkspaceMember(data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["workspaceMembers"],
      });
      queryClient.invalidateQueries({
        queryKey: ["workspaceMember"],
      });
    },
    onError: (error) => notifyError(error, "Failed to deactivate member"),
  });
}

export function useActivateWorkspaceMemberMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    void,
    Error,
    {
      userId: string;
    }
  >({
    mutationFn: (data) => activateWorkspaceMember(data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["workspaceMembers"],
      });
      queryClient.invalidateQueries({
        queryKey: ["workspaceMember"],
      });
    },
    onError: (error) => notifyError(error, "Failed to activate member"),
  });
}

export function useChangeMemberRoleMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<any, Error, any>({
    mutationFn: (data) => changeMemberRole(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Member role updated successfully") });
      queryClient.refetchQueries({
        queryKey: ["workspaceMembers"],
      });
      queryClient.invalidateQueries({
        queryKey: ["workspaceMember"],
      });
    },
    onError: (error) => notifyError(error, "Failed to update member role"),
  });
}

export function useWorkspaceInvitationsQuery(
  params?: QueryParams,
): UseQueryResult<IPagination<IInvitation>, Error> {
  return useQuery({
    queryKey: ["invitations", params],
    queryFn: () => getPendingInvitations(params),
    placeholderData: keepPreviousData,
  });
}

export function useCreateInvitationMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<void, Error, ICreateInvite>({
    mutationFn: (data) => createInvitation(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Invitation sent") });
      queryClient.refetchQueries({
        queryKey: ["invitations"],
      });
    },
    onError: (error) => notifyError(error, "Failed to send invitation"),
  });
}

export function useResendInvitationMutation() {
  const { t } = useTranslation();
  return useMutation<
    void,
    Error,
    {
      invitationId: string;
    }
  >({
    mutationFn: (data) => resendInvitation(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Invitation resent") });
    },
    onError: (error) => notifyError(error, "Failed to resend invitation"),
  });
}

export function useRevokeInvitationMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<
    void,
    Error,
    {
      invitationId: string;
    }
  >({
    mutationFn: (data) => revokeInvitation(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Invitation revoked") });
      queryClient.invalidateQueries({
        queryKey: ["invitations"],
      });
    },
    onError: (error) => notifyError(error, "Failed to revoke invitation"),
  });
}

export function useGetInvitationQuery(
  invitationId: string,
): UseQueryResult<IInvitation, Error> {
  return useQuery({
    queryKey: ["invitations", invitationId],
    queryFn: () => getInvitationById({ invitationId }),
    enabled: !!invitationId,
  });
}

export function useAppVersion(
  isEnabled: boolean,
): UseQueryResult<IVersion, Error> {
  return useQuery({
    queryKey: ["version"],
    queryFn: () => getAppVersion(),
    staleTime: 60 * 60 * 1000, // 1 hr
    enabled: isEnabled,
    refetchOnMount: true,
  });
}
