import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  getAiMcpServers,
  createAiMcpServer,
  updateAiMcpServer,
  deleteAiMcpServer,
  testAiMcpServer,
  IAiMcpServer,
  IAiMcpServerCreate,
  IAiMcpServerUpdate,
  IAiMcpServerTestResult,
} from "@/features/workspace/services/ai-mcp-server-service.ts";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";

const aiMcpServersKey = ["ai-mcp-servers"];

export function useAiMcpServersQuery(
  enabled: boolean = true,
): UseQueryResult<IAiMcpServer[], Error> {
  return useQuery({
    queryKey: aiMcpServersKey,
    queryFn: () => getAiMcpServers(),
    enabled,
  });
}

export function useCreateAiMcpServerMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<IAiMcpServer, Error, IAiMcpServerCreate>({
    mutationFn: (data) => createAiMcpServer(data),
    onSuccess: () => {
      notifications.show({ message: t("Created successfully") });
      queryClient.invalidateQueries({ queryKey: aiMcpServersKey });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({
        message: errorMessage ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

export function useUpdateAiMcpServerMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<IAiMcpServer, Error, IAiMcpServerUpdate>({
    mutationFn: (data) => updateAiMcpServer(data),
    onSuccess: () => {
      notifications.show({ message: t("Updated successfully") });
      queryClient.invalidateQueries({ queryKey: aiMcpServersKey });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({
        message: errorMessage ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

export function useDeleteAiMcpServerMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<{ success: true }, Error, string>({
    mutationFn: (id) => deleteAiMcpServer(id),
    onSuccess: () => {
      notifications.show({ message: t("Deleted successfully") });
      queryClient.invalidateQueries({ queryKey: aiMcpServersKey });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({
        message: errorMessage ?? t("Failed to update data"),
        color: "red",
      });
    },
  });
}

// Tests a saved server by id. The result ({ ok, tools } | { ok, error }) is
// rendered inline by the caller, so this mutation has no notifications.
export function useTestAiMcpServerMutation() {
  return useMutation<IAiMcpServerTestResult, Error, string>({
    mutationFn: (id) => testAiMcpServer(id),
  });
}
