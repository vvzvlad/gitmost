import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import {
  toggleTemplate,
  toggleTemporary,
} from "@/features/page-embed/services/page-embed-api";
import type {
  ToggleTemplateResponse,
  ToggleTemporaryResponse,
} from "@/features/page-embed/types/page-embed.types";

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

export function useToggleTemporaryMutation() {
  return useMutation<
    ToggleTemporaryResponse,
    Error,
    { pageId: string; temporary?: boolean }
  >({
    mutationFn: (data) => toggleTemporary(data),
    onError: (err: any) => {
      notifications.show({
        message:
          err?.response?.data?.message || "Failed to update temporary note",
        color: "red",
      });
    },
  });
}
