import { IUser } from "@/features/user/types/user.types";
import { QueryParams } from "@/lib/types.ts";

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

export interface ICommentParams extends QueryParams {
  pageId: string;
}
