import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  createApiKey,
  getApiKeys,
  revealApiKey,
  revokeApiKey,
} from "@/features/api-key/services/api-key-service";
import {
  IApiKey,
  ICreateApiKey,
  ICreateApiKeyResponse,
  IRevealApiKey,
} from "@/features/api-key/types/api-key.types";

export const API_KEYS_QUERY_KEY = ["api-keys"];

export function useApiKeysQuery(): UseQueryResult<IApiKey[], Error> {
  return useQuery({
    queryKey: API_KEYS_QUERY_KEY,
    queryFn: () => getApiKeys(),
  });
}

/**
 * Create mutation.
 *
 * SECURITY: the response contains the token. This hook deliberately does NOT
 * stash it anywhere — the caller reads it from `mutateAsync`'s resolved value
 * and immediately calls `mutation.reset()` to purge react-query's own copy (the
 * create flow discards the token; it is re-obtainable later via the reveal/copy
 * action). `gcTime: 0` is a second belt so nothing lingers in the mutation cache
 * after the observer unmounts. The list is invalidated here (it carries no token).
 */
export function useCreateApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation<ICreateApiKeyResponse, Error, ICreateApiKey>({
    mutationFn: (data) => createApiKey(data),
    gcTime: 0,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
    },
  });
}

/**
 * Reveal (copy) mutation.
 *
 * SECURITY (mirrors useCreateApiKeyMutation): the resolved value is the raw
 * token. This hook deliberately stashes it NOWHERE — the caller reads it from
 * `mutateAsync`, writes it straight to the clipboard, then calls
 * `mutation.reset()` to purge react-query's own copy. `gcTime: 0` is the second
 * belt so nothing lingers in the mutation cache after the observer unmounts.
 * There is no `onSuccess` list invalidation: reveal does not change the list.
 */
export function useRevealApiKeyMutation() {
  return useMutation<string, Error, IRevealApiKey>({
    mutationFn: (data) => revealApiKey(data),
    gcTime: 0,
  });
}

export function useRevokeApiKeyMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => revokeApiKey(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
      notifications.show({ message: t("API key revoked") });
    },
    onError: () => {
      notifications.show({
        message: t("Failed to revoke API key"),
        color: "red",
      });
    },
  });
}
