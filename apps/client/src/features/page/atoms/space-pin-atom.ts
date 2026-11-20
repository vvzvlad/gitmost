import { useAtom, useAtomValue, useStore } from "jotai";
import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import api from "@/lib/api-client";
import { atomWithUiStorage } from "@/lib/jotai-helper";
import { userAtom } from "@/features/user/atoms/current-user-atom";

const MAX_SPACE_PINS = 100;

const spacePinsAtom = atomWithUiStorage<Record<string, string>>(
  "spacePins:v1",
  {},
  (value): value is Record<string, string> =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).length <= MAX_SPACE_PINS &&
    Object.entries(value).every(
      ([key, id]) =>
        key.length < 100 && typeof id === "string" && id.length < 50,
    ),
);

export function useSpacePin(spaceId?: string) {
  const { t } = useTranslation();
  const store = useStore();
  const user = useAtomValue(userAtom);
  const [legacyPins, setLegacyPins] = useAtom(spacePinsAtom);
  const importAttempt = useRef<string>();
  const userId = user?.id;
  const key = userId && spaceId ? `${userId}:${spaceId}` : undefined;
  const serverPin = spaceId ? user?.settings?.spacePins?.[spaceId] : undefined;
  const legacyPin = key ? legacyPins[key] : undefined;
  const pinnedId = serverPin === undefined ? legacyPin : serverPin;

  const { mutate, isPending } = useMutation({
    scope: { id: key ?? "space-pin" },
    mutationFn: async ({
      spaceId,
      pageId,
      onlyIfUnset,
    }: {
      spaceId: string;
      userId: string;
      key: string;
      pageId: string | null;
      onlyIfUnset?: boolean;
    }) => {
      const response = await api.post<{ pageId: string | null }>(
        "/pages/preferences/space-pin",
        {
          spaceId,
          pageId,
          onlyIfUnset,
        },
      );
      return response.data.pageId;
    },
    onSuccess: (pageId, { spaceId, userId, key }) => {
      const current = store.get(userAtom);
      if (current?.id === userId) {
        store.set(userAtom, {
          ...current,
          settings: {
            ...current.settings,
            spacePins: { ...current.settings?.spacePins, [spaceId]: pageId },
          },
        });
      }
      setLegacyPins((pins) => {
        const next = { ...pins };
        delete next[key];
        return next;
      });
    },
    onError: (_error, { onlyIfUnset }) => {
      if (!onlyIfUnset)
        notifications.show({
          color: "red",
          message: t("Could not update the pinned page"),
        });
    },
  });

  useEffect(() => {
    if (
      key &&
      serverPin === undefined &&
      legacyPin &&
      importAttempt.current !== key
    ) {
      importAttempt.current = key;
      mutate({ key, spaceId, userId, pageId: legacyPin, onlyIfUnset: true });
    }
  }, [key, spaceId, userId, serverPin, legacyPin, mutate]);

  const togglePin = (pageId: string) => {
    if (key)
      mutate({
        key,
        spaceId,
        userId,
        pageId: pinnedId === pageId ? null : pageId,
      });
  };

  return { pinnedId, togglePin, isPinPending: isPending };
}
