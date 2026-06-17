import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  getAiSettings,
  updateAiSettings,
  testAiConnection,
  reindexAiEmbeddings,
  IAiSettings,
  IAiSettingsUpdate,
  IAiTestResult,
} from "@/features/workspace/services/ai-settings-service.ts";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";

const aiSettingsKey = ["ai-settings"];

export function useAiSettingsQuery(
  enabled: boolean = true,
): UseQueryResult<IAiSettings, Error> {
  return useQuery({
    queryKey: aiSettingsKey,
    queryFn: () => getAiSettings(),
    enabled,
  });
}

export function useUpdateAiSettingsMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<IAiSettings, Error, IAiSettingsUpdate>({
    mutationFn: (data) => updateAiSettings(data),
    onSuccess: () => {
      notifications.show({ message: t("Updated successfully") });
      queryClient.invalidateQueries({ queryKey: aiSettingsKey });
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

export function useTestAiConnectionMutation() {
  return useMutation<IAiTestResult, Error, void>({
    mutationFn: () => testAiConnection(),
  });
}

export function useReindexAiEmbeddingsMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<IAiSettings, Error, void>({
    mutationFn: () => reindexAiEmbeddings(),
    onSuccess: () => {
      notifications.show({ message: t("Reindexing started") });
      queryClient.invalidateQueries({ queryKey: aiSettingsKey });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({
        message: errorMessage ?? t("Failed to start reindexing"),
        color: "red",
      });
    },
  });
}
