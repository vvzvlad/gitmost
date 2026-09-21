import api from "@/lib/api-client";
import {
  ICommentParams,
  IComment,
  IResolveComment,
  ISuggestionOutcome,
} from "@/features/comment/types/comment.types";
import { IPagination } from "@/lib/types.ts";

export async function createComment(
  data: Partial<IComment>,
): Promise<IComment> {
  const req = await api.post<IComment>("/comments/create", data);
  return req.data;
}

export async function resolveComment(data: IResolveComment): Promise<IComment> {
  const req = await api.post<IComment>(`/comments/resolve`, data);
  return req.data;
}

export async function applySuggestion(
  commentId: string,
): Promise<ISuggestionOutcome> {
  // Mirrors resolveComment: let axios reject on non-2xx so the mutation can read
  // the 409 body (`{ message, currentText }`) off err.response.data.
  const req = await api.post("/comments/apply-suggestion", { commentId });
  return req.data.data ?? req.data;
}

export async function dismissSuggestion(
  commentId: string,
): Promise<ISuggestionOutcome> {
  // Dismiss ("Не применять") a suggested edit (#329): the server hard-deletes
  // the comment (or resolves it when it has replies) and returns the outcome.
  const req = await api.post("/comments/dismiss-suggestion", { commentId });
  return req.data.data ?? req.data;
}

export async function updateComment(
  data: Partial<IComment>,
): Promise<IComment> {
  const req = await api.post<IComment>(`/comments/update`, data);
  return req.data;
}

export async function getCommentById(commentId: string): Promise<IComment> {
  const req = await api.post<IComment>("/comments/info", { commentId });
  return req.data;
}

export async function getPageComments(
  data: ICommentParams,
): Promise<IPagination<IComment>> {
  const req = await api.post("/comments", data);
  return req.data;
}

export async function deleteComment(commentId: string): Promise<void> {
  await api.post("/comments/delete", { commentId });
}
