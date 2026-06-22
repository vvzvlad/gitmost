export interface IWorkspace {
  id: string;
  name: string;
  description: string;
  logo: string;
  hostname: string;
  defaultSpaceId: string;
  customDomain: string;
  enableInvite: boolean;
  settings: IWorkspaceSettings;
  status: string;
  enforceSso: boolean;
  stripeCustomerId: string;
  billingEmail: string;
  trialEndAt: Date;
  createdAt: Date;
  updatedAt: Date;
  emailDomains: string[];
  memberCount?: number;
  plan?: string;
  enforceMfa?: boolean;
  aiSearch?: boolean;
  generativeAi?: boolean;
  disablePublicSharing?: boolean;
  mcpEnabled?: boolean;
  aiChat?: boolean;
  aiDictation?: boolean;
  aiDictationStreaming?: boolean;
  aiPublicShareAssistant?: boolean;
  trashRetentionDays?: number;
  restrictApiToAdmins?: boolean;
  allowMemberTemplates?: boolean;
  isScimEnabled?: boolean;
  // Write-only field for updateWorkspace({ htmlEmbed }). Read state lives at
  // settings.htmlEmbed.
  htmlEmbed?: boolean;
  // Write-only field for updateWorkspace({ trackerHead }). Read state lives at
  // settings.trackerHead.
  trackerHead?: string;
}

export interface IWorkspaceSettings {
  ai?: IWorkspaceAiSettings;
  sharing?: IWorkspaceSharingSettings;
  api?: IWorkspaceApiSettings;
  templates?: IWorkspaceTemplateSettings;
  // HTML embed master toggle (enables/disables the block type). The block
  // renders in a sandboxed iframe, so this is a feature switch, not a security
  // gate. ABSENT/false => OFF (default).
  htmlEmbed?: boolean;
  // Admin-only analytics/tracker snippet injected into the <head> of public
  // share pages (same-origin). ABSENT/empty => none.
  trackerHead?: string;
}

export interface IWorkspaceApiSettings {
  restrictToAdmins?: boolean;
}

export interface IWorkspaceAiSettings {
  search?: boolean;
  generative?: boolean;
  mcp?: boolean;
  chat?: boolean;
  dictation?: boolean;
  dictationStreaming?: boolean;
  publicShareAssistant?: boolean;
}

export interface IWorkspaceSharingSettings {
  disabled?: boolean;
}

export interface IWorkspaceTemplateSettings {
  allowMemberTemplates?: boolean;
}

export interface ICreateInvite {
  role: string;
  emails: string[];
  groupIds: string[];
}

export interface IInvitation {
  id: string;
  role: string;
  email: string;
  workspaceId: string;
  invitedById: string;
  createdAt: Date;
  enforceSso: boolean;
}

export interface IInvitationLink {
  inviteLink: string;
}

export interface IAcceptInvite {
  invitationId: string;
  name: string;
  password: string;
  token: string;
}

export interface IPublicWorkspace {
  id: string;
  name: string;
  logo: string;
  hostname: string;
  enforceSso: boolean;
}

export interface IVersion {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}
