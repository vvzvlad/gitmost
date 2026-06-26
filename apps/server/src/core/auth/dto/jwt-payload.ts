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
