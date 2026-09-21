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
  AiTestCapability,
} from "@/features/workspace/services/ai-settings-service.ts";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";

const aiSettingsKey = ["ai-settings"];

export function useAiSettingsQuery(
  enabled: boolean = true,
  // While reindexing runs as an async background job, the counter only climbs
  // if the client keeps refetching. The component passes a refetchInterval
  // function (`nextReindexPollInterval`) that keeps polling while the server
  // reports an active run (reindexing === true) OR we are still within the
  // bounded deadline and not yet fully indexed; it returns false to stop only
  // once the run has finished AND indexed >= total, or the deadline cap is hit
  // (the cap always wins). Note: a transient indexed === total during an active
  // run does NOT stop polling. See AiProviderSettings.
  refetchInterval?:
    | number
    | false
    | ((query: { state: { data?: IAiSettings } }) => number | false),
): UseQueryResult<IAiSettings, Error> {
  return useQuery({
    queryKey: aiSettingsKey,
    queryFn: () => getAiSettings(),
    enabled,
    refetchInterval: refetchInterval as any,
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
  return useMutation<IAiTestResult, Error, AiTestCapability>({
    mutationFn: (capability) => testAiConnection(capability),
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
