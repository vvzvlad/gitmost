import { useMutation, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import api from "@/lib/api-client";
import { ISpace } from "@/features/space/types/space.types";

export function useSetSpaceHome(space: ISpace | undefined) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const { mutate, isPending } = useMutation({
    scope: { id: `space-home:${space?.id}` },
    mutationFn: async ({
      spaceId,
      pageId,
    }: {
      spaceId: string;
      slug: string;
      pageId: string | null;
    }) => {
      const response = await api.post<{ pageId: string | null }>(
        "/pages/preferences/space-home",
        { spaceId, pageId },
      );
      return response.data.pageId;
    },
    onSuccess: (pageId, { spaceId, slug }) => {
      for (const key of [spaceId, slug]) {
        queryClient.setQueryData<ISpace>(["space", key], (cached) =>
          cached
            ? {
                ...cached,
                settings: { ...cached.settings, homePageId: pageId },
              }
            : cached,
        );
      }
      notifications.show({
        message: pageId
          ? t("Space home page set")
          : t("Space home page cleared"),
      });
    },
    onError: () =>
      notifications.show({
        color: "red",
        message: t("Could not update the space home page"),
      }),
  });

  return {
    isPending,
    mutate: (pageId: string | null) => {
      if (space) mutate({ spaceId: space.id, slug: space.slug, pageId });
    },
  };
}
