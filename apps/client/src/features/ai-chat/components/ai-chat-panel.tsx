import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Box,
  Collapse,
  Divider,
  Group,
  Loader,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconChevronDown, IconPlus, IconX } from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import { activeAiChatIdAtom } from "@/features/ai-chat/atoms/ai-chat-atom.ts";
import {
  AI_CHATS_RQ_KEY,
  useAiChatMessagesQuery,
  useAiChatsQuery,
} from "@/features/ai-chat/queries/ai-chat-query.ts";
import ConversationList from "@/features/ai-chat/components/conversation-list.tsx";
import ChatThread from "@/features/ai-chat/components/chat-thread.tsx";

/**
 * Right-aside AI chat container (§7.1): a header (title + new-chat + close), a
 * collapsible conversation switcher, the active chat thread (message list +
 * input), all driven by `useChat` inside ChatThread.
 */
export default function AiChatPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [, setAsideState] = useAtom(asideStateAtom);
  const [activeChatId, setActiveChatId] = useAtom(activeAiChatIdAtom);
  const [listOpen, { toggle: toggleList, close: closeList }] =
    useDisclosure(false);

  // Track whether we are awaiting the id of a just-created (new) chat, so we can
  // adopt it once the chat list refreshes after the first turn finishes.
  const adoptNewChat = useRef(false);

  const { data: chats } = useAiChatsQuery();
  const { data: messageRows, isLoading: messagesLoading } =
    useAiChatMessagesQuery(activeChatId ?? undefined);

  const closeAside = (): void =>
    setAsideState((s) => ({ ...s, isAsideOpen: false }));

  const startNewChat = (): void => {
    setActiveChatId(null);
    closeList();
  };

  const selectChat = (chatId: string): void => {
    setActiveChatId(chatId);
    closeList();
  };

  // After a turn finishes, refresh the chat list. For a brand-new chat (no id
  // yet), the server has just created the row; adopt the newest chat id so the
  // thread switches from "new" to the persisted chat (and loads its history on
  // later opens).
  const onTurnFinished = useCallback(() => {
    if (activeChatId === null) adoptNewChat.current = true;
    queryClient.invalidateQueries({ queryKey: AI_CHATS_RQ_KEY });
  }, [activeChatId, queryClient]);

  // When awaiting a new chat's id, adopt the most-recent chat (the list is
  // ordered newest-first) once it appears.
  useEffect(() => {
    if (!adoptNewChat.current) return;
    const newest = chats?.items?.[0];
    if (newest) {
      adoptNewChat.current = false;
      setActiveChatId(newest.id);
    }
  }, [chats, setActiveChatId]);

  // The thread is remounted when the active chat changes so initial messages
  // re-seed. For a new chat we key on "new"; adopting the id remounts the thread
  // with the persisted history loaded.
  const threadKey = activeChatId ?? "new";
  const waitingForHistory = activeChatId !== null && messagesLoading;

  return (
    <Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Group justify="space-between" wrap="nowrap" mb="xs">
        <Title order={2} size="h6" fw={500}>
          {t("AI chat")}
        </Title>
        <Group gap={4} wrap="nowrap">
          <Tooltip label={t("New chat")} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={startNewChat}
              aria-label={t("New chat")}
            >
              <IconPlus size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("Close")} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={closeAside}
              aria-label={t("Close")}
            >
              <IconX size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <Box
        onClick={toggleList}
        style={{ cursor: "pointer" }}
        mb={listOpen ? "xs" : 0}
      >
        <Group gap={4} wrap="nowrap">
          <IconChevronDown
            size={14}
            style={{
              transform: listOpen ? "none" : "rotate(-90deg)",
              transition: "transform 150ms ease",
            }}
          />
          <Text size="xs" c="dimmed">
            {t("Chat history")}
          </Text>
        </Group>
      </Box>
      <Collapse in={listOpen}>
        <ConversationList activeChatId={activeChatId} onSelect={selectChat} />
        <Divider my="xs" />
      </Collapse>

      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {waitingForHistory ? (
          <Group justify="center" py="md">
            <Loader size="sm" />
          </Group>
        ) : (
          <ChatThread
            key={threadKey}
            chatId={activeChatId}
            initialRows={activeChatId ? messageRows : []}
            onTurnFinished={onTurnFinished}
          />
        )}
      </Box>
    </Box>
  );
}
