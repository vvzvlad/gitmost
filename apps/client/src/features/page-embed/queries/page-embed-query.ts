import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { toggleTemplate } from "@/features/page-embed/services/page-embed-api";
import type { ToggleTemplateResponse } from "@/features/page-embed/types/page-embed.types";

export function useToggleTemplateMutation() {
  return useMutation<
    ToggleTemplateResponse,
    Error,
    { pageId: string; isTemplate?: boolean }
  >({
    mutationFn: (data) => toggleTemplate(data),
    onError: (err: any) => {
      notifications.show({
        message: err?.response?.data?.message || "Failed to update template",
        color: "red",
      });
    },
  });
}
