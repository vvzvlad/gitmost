import { Badge, Tooltip } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSetAtom } from "jotai";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";

interface AiAgentBadgeProps {
  authorName?: string;
  aiChatId?: string | null;
  // Fired after the badge deep-links into its chat. The caller handles its own
  // context (e.g. the page-history row closes the history modal) so this generic
  // ui/ primitive stays free of cross-feature coupling (#143 review Arch B).
  onActivate?: () => void;
}

/**
 * Badge marking content written by the AI agent (provenance C3 / §7.4). It is
 * ADDITIVE — shown next to the human author, never replacing them. Reused by the
 * page-history list and the comments sidebar.
 *
 * When the item carries an `aiChatId` (an internal AI-chat edit), clicking the
 * badge deep-links into that chat: it sets the active-chat atom and opens the
 * floating AI-chat window, then invokes `onActivate` so the caller can react
 * (e.g. the history modal closes itself). When `aiChatId` is null/absent (an
 * external MCP write with no internal ai_chats row), the badge is a plain
 * non-clickable label. The click is contained (stopPropagation) so it does not
 * also trigger an enclosing row's click handler.
 */
export function AiAgentBadge({
  authorName,
  aiChatId,
  onActivate,
}: AiAgentBadgeProps) {
  const { t } = useTranslation();
  const setAiChatWindowOpen = useSetAtom(aiChatWindowOpenAtom);
  const setActiveChatId = useSetAtom(activeAiChatIdAtom);
  const setDraft = useSetAtom(aiChatDraftAtom);

  const tooltip = t("Edited by AI agent on behalf of {{name}}", {
    name: authorName ?? "",
  });

  const openChat = useCallback(
    (event: React.SyntheticEvent) => {
      event.stopPropagation();
      if (!aiChatId) return;
      setActiveChatId(aiChatId);
      // Switching to another chat must start with a clean composer — clear any
      // unsent draft so it does not leak from the previously open chat.
      setDraft("");
      setAiChatWindowOpen(true);
      onActivate?.();
    },
    [aiChatId, setActiveChatId, setDraft, setAiChatWindowOpen, onActivate],
  );

  const badge = (
    <Badge
      size="sm"
      variant="light"
      color="violet"
      radius="sm"
      leftSection={<IconSparkles size={12} stroke={2} />}
      style={aiChatId ? { cursor: "pointer" } : undefined}
      {...(aiChatId
        ? {
            // Keep the default Badge root element (not a <button>) to avoid an
            // invalid <button>-in-<button> nesting inside a row's
            // UnstyledButton; expose it as an accessible button via
            // role/keyboard.
            role: "button",
            tabIndex: 0,
            onClick: openChat,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openChat(event);
              }
            },
          }
        : {})}
    >
      {t("AI-agent")}
    </Badge>
  );

  return (
    <Tooltip label={tooltip} withArrow>
      {badge}
    </Tooltip>
  );
}

export default AiAgentBadge;
