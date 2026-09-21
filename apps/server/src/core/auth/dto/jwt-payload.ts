/**
 * Provenance actor for a write: who the action is attributed to. Derived only
 * from the SIGNED token claim (never a request body), so 'agent' is unspoofable.
 * Single source of truth so a typo like 'agnet' can't slip through as a bare
 * string (#143 review). Distinct from `ActorType` (auth principal kind).
 */
export type ProvenanceSource = 'user' | 'agent';

export enum JwtType {
  ACCESS = 'access',
  COLLAB = 'collab',
  EXCHANGE = 'exchange',
  ATTACHMENT = 'attachment',
  MFA_TOKEN = 'mfa_token',
  API_KEY = 'api_key',
  PDF_RENDER = 'pdf_render',
  PDF_EXPORT_DOWNLOAD = 'pdf_export_download',
}
export type JwtPayload = {
  sub: string;
  email: string;
  workspaceId: string;
  type: 'access';
  sessionId?: string;
  // Optional agent-edit provenance, signed into the access token. Absent for a
  // normal user token (treated as 'user'); set only when the internal agent
  // mints a provenance access token so REST writes (create/rename/move page,
  // comment create/resolve) record a non-spoofable 'agent' marker (§6.5 / §15
  // C3 / §14 N2).
  actor?: ProvenanceSource;
  // Nullable: an external MCP agent has no internal ai_chats row, so it carries
  // an 'agent' actor with a null aiChatId.
  aiChatId?: string | null;
};

// The AUTH-PRINCIPAL kind behind a collab token — distinct from `actor`
// (provenance). Stamped into EVERY newly-minted collab token (#501): 'session'
// for a normal user/session (incl. the internal AI agent, which is session-
// backed), 'api_key' when the token was minted by an api-key principal (an
// external MCP agent). The discriminator keys on the token's ORIGIN, so the
// collab seam can re-check a revoked api key on connect and reject a claimless
// token after the rollout grace window. NOT keyed on `actor:'agent'` — the
// internal agent is 'agent' but session-backed, so it must stay on the no-check
// path.
export type CollabPrincipal = 'session' | 'api_key';

export type JwtCollabPayload = {
  sub: string;
  workspaceId: string;
  type: 'collab';
  // Optional agent-edit provenance, signed into the collab token. Absent for
  // the human collab path (treated as 'user'); set only when the internal agent
  // mints a provenance collab token (§6.6 / §15 C2).
  actor?: ProvenanceSource;
  // Nullable: an external MCP agent has no internal ai_chats row, so it carries
  // an 'agent' actor with a null aiChatId.
  aiChatId?: string | null;
  // Auth-principal discriminator (#501). Present on every post-rollout token;
  // its absence on a still-valid token past the grace window is treated as an
  // error, not trust (fail-closed).
  principal?: CollabPrincipal;
  // Only when principal === 'api_key': the minting key's id, so the collab seam
  // can row-check (and reject) a revoked key on connect.
  apiKeyId?: string;
};

export type JwtExchangePayload = {
  sub: string;
  workspaceId: string;
  type: 'exchange';
};

export type JwtAttachmentPayload = {
  attachmentId: string;
  pageId: string;
  workspaceId: string;
  type: 'attachment';
};

export interface JwtMfaTokenPayload {
  sub: string;
  workspaceId: string;
  type: 'mfa_token';
}

export type JwtApiKeyPayload = {
  sub: string;
  workspaceId: string;
  apiKeyId: string;
  type: 'api_key';
};

export type JwtPdfRenderPayload = {
  pageId: string;
  workspaceId: string;
  type: 'pdf_render';
};

export type JwtPdfExportDownloadPayload = {
  fileTaskId: string;
  workspaceId: string;
  type: 'pdf_export_download';
};
