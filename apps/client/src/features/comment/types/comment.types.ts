import { IUser } from "@/features/user/types/user.types";
import { QueryParams } from "@/lib/types.ts";
import type {
  AgentInfo,
  LauncherInfo,
} from "@/components/ui/agent-avatar-stack.tsx";

export interface IComment {
  id: string;
  content: string;
  selection?: string;
  type?: string;
  creatorId: string;
  pageId: string;
  parentCommentId?: string;
  resolvedById?: string;
  resolvedAt?: Date;
  workspaceId: string;
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
  creator: IUser;
  resolvedBy?: IUser;
  // Agent-edit provenance (returned by the backend via selectAll('comments')).
  // createdSource === "agent" marks a comment authored via an AI agent (MCP /
  // internal AI chat); aiChatId deep-links to the internal chat when present
  // (null for an external MCP agent); resolvedSource marks an AI-resolved thread.
  createdSource?: string;
  aiChatId?: string | null;
  resolvedSource?: string | null;
  // Suggested-edit (#315): when an agent proposes a replacement for the
  // commented `selection`, `suggestedText` holds the "стало" text. Once a user
  // applies it server-side the backend stamps `suggestionAppliedAt` /
  // `suggestionAppliedById` and auto-resolves the thread.
  suggestedText?: string | null;
  suggestionAppliedAt?: Date | string | null;
  suggestionAppliedById?: string | null;
  // Server-normalized "agent avatar stack" provenance (#300), present only when
  // createdSource === "agent": `agent` is the front identity, `launcher` the
  // human behind it (null for an external MCP agent).
  agent?: AgentInfo | null;
  launcher?: LauncherInfo | null;
  yjsSelection?: {
    anchor: any;
    head: any;
  };
}

export interface ICommentData {
  id: string;
  pageId: string;
  parentCommentId?: string;
  content: any;
  selection?: string;
}

export interface IResolveComment {
  commentId: string;
  pageId: string;
  resolved: boolean;
}

// Result of applying or dismissing an ephemeral suggested edit (#329). The
// server hard-deletes the comment (`deleted`) unless the thread has replies, in
// which case it is resolved (`resolved`). The returned comment fields carry the
// resolved-branch state; `outcome` tells the client which optimistic action to
// take (drop the comment vs. move it to the resolved tab).
export type ISuggestionOutcome = IComment & {
  outcome?: "deleted" | "resolved";
};

export interface ICommentParams extends QueryParams {
  pageId: string;
}
