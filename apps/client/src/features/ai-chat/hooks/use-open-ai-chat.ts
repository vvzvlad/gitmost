import { useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useMatch } from "react-router-dom";
import {
  aiChatWindowOpenAtom,
  activeAiChatIdAtom,
  aiChatDraftAtom,
  selectedAiRoleIdAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";
import { getBoundChat } from "@/features/ai-chat/services/ai-chat-service.ts";
import { extractPageSlugId } from "@/lib";

/**
 * The generic "open the AI chat" action, WITH document binding: when invoked
 * while viewing a page, it resolves that page's bound chat and selects it before
 * opening — so the last chat for this document re-opens by itself. With no bound
 * chat (or off a page) it keeps the current selection / opens a fresh chat. Used
 * by the app-header entry point; NOT by the provenance badge (which deep-links).
 */
export function useOpenAiChatForCurrentPage() {
  const [windowOpen, setWindowOpen] = useAtom(aiChatWindowOpenAtom);
  const [activeChatId, setActiveChatId] = useAtom(activeAiChatIdAtom);
  const setDraft = useSetAtom(aiChatDraftAtom);
  const setSelectedRoleId = useSetAtom(selectedAiRoleIdAtom);

  // Same route-match trick the window uses: read :pageSlug from the pathname.
  // AiChatWindow lives in a pathless parent layout route, so useParams() can't
  // see :pageSlug — match the full path against the authenticated page route.
  const match = useMatch("/s/:spaceSlug/p/:pageSlug");
  const pageId = extractPageSlugId(match?.params?.pageSlug);

  return useCallback(async () => {
    // Re-clicks while the window is already open (incl. minimized) must NOT
    // re-resolve and yank the user to another chat: resolve only on a genuine
    // closed -> open transition.
    if (windowOpen) {
      setWindowOpen(true);
      return;
    }
    let resolved: string | null = activeChatId; // off-a-page: keep current
    if (pageId) {
      try {
        resolved = await getBoundChat(pageId); // null => fresh chat
      } catch {
        resolved = null; // fail-soft: a fresh chat is always a safe fallback
      }
    }
    // Clear the composer draft / picked role ONLY on an actual switch, so
    // reopening the same chat does not wipe an in-progress draft.
    if (resolved !== activeChatId) {
      setActiveChatId(resolved);
      setDraft("");
      setSelectedRoleId(null);
    }
    setWindowOpen(true);
  }, [
    windowOpen,
    activeChatId,
    pageId,
    setWindowOpen,
    setActiveChatId,
    setDraft,
    setSelectedRoleId,
  ]);
}
