interface IPageHistoryUser {
  id: string;
  name: string;
  avatarUrl: string;
}

export interface IPageHistory {
  id: string;
  pageId: string;
  title: string;
  content?: any;
  slug: string;
  icon: string;
  coverPhoto: string;
  version: number;
  lastUpdatedById: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  lastUpdatedBy: IPageHistoryUser;
  contributors?: IPageHistoryUser[];
  // Provenance markers copied off the page row when the snapshot was saved.
  // `'agent'` marks a version written by the AI agent; `lastUpdatedAiChatId`
  // (when present) deep-links to the chat that produced the edit.
  lastUpdatedSource?: string;
  lastUpdatedAiChatId?: string | null;
}
