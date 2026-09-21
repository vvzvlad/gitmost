// Compact creator attribution embedded in the admin (workspace-wide) list. A
// normal member's list only ever contains their own keys, so the field is
// present but redundant; the author column is only rendered for admins.
export interface IApiKeyCreator {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

// A single api-key row as returned by `POST /api/api-keys/list`. Note: the list
// NEVER carries token material — only metadata.
export interface IApiKey {
  id: string;
  name: string;
  // ISO string, or null for an unlimited ("never expires") key.
  expiresAt: string | null;
  // ISO string, or null if the key was never used. Throttled to ~1h server-side
  // (#501), so the UI must not promise sub-hour precision.
  lastUsedAt: string | null;
  createdAt: string;
  creator?: IApiKeyCreator | null;
}

// Payload for `POST /api/api-keys/create`. `expiresAt`: an ISO date string for a
// bounded lifetime, or null for an unlimited key. (undefined would let the
// server apply its 1-year default, but the form always sends an explicit value.)
export interface ICreateApiKey {
  name: string;
  expiresAt: string | null;
}

// The metadata half of the create response. The token itself is carried
// separately (see ICreateApiKeyResponse); it is re-obtainable later by its owner
// via a deterministic re-mint under a step-up (POST /api-keys/reveal).
export interface ICreatedApiKey {
  id: string;
  name: string;
  expiresAt: string | null;
  createdAt: string;
}

// Response of `POST /api/api-keys/create`. `token` is returned on create; it is
// ALSO retrievable later via reveal (deterministic re-mint under a step-up), so
// it is no longer "show once". It must never be cached, persisted or logged —
// the create flow discards it (the user copies via the per-row Copy action).
export interface ICreateApiKeyResponse {
  token: string;
  apiKey: ICreatedApiKey;
}

// Payload for `POST /api/api-keys/reveal`: the key id + the caller's current
// password (step-up). The response is `{ token }` — a re-minted, byte-identical
// copy of the key's token, which must be written straight to the clipboard and
// never held in state, cache or storage.
export interface IRevealApiKey {
  id: string;
  password: string;
}
