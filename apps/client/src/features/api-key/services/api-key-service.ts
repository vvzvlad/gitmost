import api from "@/lib/api-client";
import {
  IApiKey,
  ICreateApiKey,
  ICreateApiKeyResponse,
  IRevealApiKey,
} from "@/features/api-key/types/api-key.types";

// Mint a new key. The response carries the token, but the create flow now
// DISCARDS it (the user copies the key later via the per-row reveal action, so
// there is no show-once modal) — the caller must never cache or persist it. See
// queries/api-key-query.ts (gcTime: 0 + query invalidation) and
// components/api-keys-manager.tsx `handleCreate` (createMutation.reset() right
// after the mint) for the reset()-after-read discipline the reveal path mirrors.
export async function createApiKey(
  data: ICreateApiKey,
): Promise<ICreateApiKeyResponse> {
  const res = await api.post<ICreateApiKeyResponse>("/api-keys/create", data);
  return res.data as ICreateApiKeyResponse;
}

// List the caller's keys (or, for an admin, every key in the workspace with
// creator attribution). Never returns token material.
export async function getApiKeys(): Promise<IApiKey[]> {
  const res = await api.post<IApiKey[]>("/api-keys/list");
  return res.data as IApiKey[];
}

// Revocation is server-side immediate; the caller drops the row on success.
export async function revokeApiKey(id: string): Promise<void> {
  await api.post("/api-keys/revoke", { id });
}

// Reveal (re-mint) an existing key's token under a password step-up. Returns the
// bare token string — the SECURITY contract (mirrors create): the caller must
// write it straight to the clipboard and never stash it in state, the query
// cache or localStorage. See useRevealApiKeyMutation (gcTime: 0 + reset-after-
// read) and api-keys-manager.tsx `handleCopy`.
export async function revealApiKey(data: IRevealApiKey): Promise<string> {
  const res = await api.post<{ token: string }>("/api-keys/reveal", data);
  return (res.data as { token: string }).token;
}
