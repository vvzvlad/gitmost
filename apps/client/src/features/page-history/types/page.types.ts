import type {
  AgentInfo,
  LauncherInfo,
} from "@/components/ui/agent-avatar-stack.tsx";

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
  // #370 — intentionality tier: 'manual'/'agent' are versions (intentional
  // points), 'idle'/'boundary' are autosnapshots; null/undefined = legacy
  // autosave. Derived server-side, drives the history badge + "versions" filter.
  kind?: "manual" | "agent" | "idle" | "boundary" | null;
  // Provenance markers copied off the page row when the snapshot was saved.
  // `'agent'` marks a version written by the AI agent; `lastUpdatedAiChatId`
  // (when present) deep-links to the chat that produced the edit.
  lastUpdatedSource?: string;
  lastUpdatedAiChatId?: string | null;
  // Server-normalized "agent avatar stack" provenance (#300), present only when
  // lastUpdatedSource === "agent": `agent` is the front identity, `launcher` the
  // human behind it (null for an external MCP agent).
  agent?: AgentInfo | null;
  launcher?: LauncherInfo | null;
}
