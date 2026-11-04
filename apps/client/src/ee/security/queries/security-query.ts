import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  createSsoProvider,
  deleteSsoProvider,
  getSsoProviderById,
  getSsoProviders,
  updateSsoProvider,
} from "@/ee/security/services/security-service.ts";
import { notifications } from "@mantine/notifications";
import { IAuthProvider } from "@/ee/security/types/security.types.ts";
import { IPagination } from "@/lib/types.ts";
import { notifyError } from "@/lib/errors";
import { useTranslation } from "react-i18next";

export function useGetSsoProviders(): UseQueryResult<IPagination<IAuthProvider>, Error> {
  return useQuery({
    queryKey: ["sso-providers"],
    queryFn: () => getSsoProviders(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSsoProvider(
  providerId: string,
): UseQueryResult<IAuthProvider, Error> {
  return useQuery({
    queryKey: ["sso-provider", providerId],
    queryFn: () => getSsoProviderById({ providerId }),
    enabled: !!providerId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateSsoProviderMutation() {
  const queryClient = useQueryClient();

  return useMutation<any, Error, Partial<IAuthProvider>>({
    mutationFn: (data: Partial<IAuthProvider>) => createSsoProvider(data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["sso-providers"],
      });
    },
    onError: (error) => notifyError(error, "Failed to create SSO provider"),
  });
}

export function useUpdateSsoProviderMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<any, Error, Partial<IAuthProvider>>({
    mutationFn: (data: Partial<IAuthProvider>) => updateSsoProvider(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Updated successfully") });
      queryClient.invalidateQueries({
        queryKey: ["sso-providers"],
      });
    },
    onError: (error) => notifyError(error, "Failed to update SSO provider"),
  });
}

export function useDeleteSsoProviderMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (providerId: string) => deleteSsoProvider({ providerId }),
    onSuccess: (data, variables) => {
      notifications.show({ message: t("Deleted successfully") });

      queryClient.invalidateQueries({
        queryKey: ["sso-providers"],
      });
    },
    onError: (error) => notifyError(error, "Failed to delete SSO provider"),
  });
}
