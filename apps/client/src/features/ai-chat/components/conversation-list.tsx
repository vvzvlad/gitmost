import { useState } from "react";
import {
  ActionIcon,
  Box,
  Group,
  Loader,
  Menu,
  Text,
  TextInput,
} from "@mantine/core";
import { IconDots, IconEdit, IconTrash } from "@tabler/icons-react";
import { modals } from "@mantine/modals";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import {
  useAiChatsQuery,
  useDeleteAiChatMutation,
  useRenameAiChatMutation,
} from "@/features/ai-chat/queries/ai-chat-query.ts";
import { IAiChat } from "@/features/ai-chat/types/ai-chat.types.ts";
import { useTimeAgo } from "@/hooks/use-time-ago.tsx";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

/**
 * The dimmed second line of a chat row: how long ago the chat was created and
 * the document it was created in. Its own component so the self-updating
 * `useTimeAgo` hook is called per row legally (hooks cannot run inside `.map()`).
 */
function ChatMetaLine({
  createdAt,
  pageTitle,
}: {
  createdAt: string;
  pageTitle?: string | null;
}) {
  const { t } = useTranslation();
  const ago = useTimeAgo(createdAt);
  // e.g. "2 hours ago · Onboarding guide" / "2 hours ago · No document"
  return (
    <Text size="xs" c="dimmed" lineClamp={1}>
      {ago} · {pageTitle || t("No document")}
    </Text>
  );
}

interface ConversationListProps {
  activeChatId: string | null;
  onSelect: (chatId: string) => void;
}

/**
 * The user's chat history. Selecting a chat opens it; rename is inline; delete
 * is confirmed. A brand-new (unsaved) chat is not in this list until the server
 * persists it on the first message.
 */
export default function ConversationList({
  activeChatId,
  onSelect,
}: ConversationListProps) {
  const { t } = useTranslation();
  const { data, isLoading } = useAiChatsQuery();
  const renameMutation = useRenameAiChatMutation();
  const deleteMutation = useDeleteAiChatMutation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const startRename = (chat: IAiChat): void => {
    setEditingId(chat.id);
    setDraftTitle(chat.title ?? "");
  };

  const commitRename = (chatId: string): void => {
    const title = draftTitle.trim();
    setEditingId(null);
    if (title) renameMutation.mutate({ chatId, title });
  };

  const confirmDelete = (chatId: string): void => {
    modals.openConfirmModal({
      title: t("Delete this chat?"),
      centered: true,
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(chatId),
    });
  };

  if (isLoading) {
    return (
      <Group justify="center" py="sm">
        <Loader size="sm" />
      </Group>
    );
  }

  const chats = data?.items ?? [];
  if (chats.length === 0) {
    return (
      <Text size="sm" c="dimmed" py="xs">
        {t("No chats yet.")}
      </Text>
    );
  }

  return (
    <Box>
      {chats.map((chat) => {
        const isActive = chat.id === activeChatId;
        if (editingId === chat.id) {
          return (
            <Box key={chat.id} px="xs" py={4}>
              <TextInput
                size="xs"
                value={draftTitle}
                autoFocus
                onChange={(e) => setDraftTitle(e.currentTarget.value)}
                onBlur={() => commitRename(chat.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename(chat.id);
                  } else if (e.key === "Escape") {
                    setEditingId(null);
                  }
                }}
              />
            </Box>
          );
        }
        return (
          <Group
            key={chat.id}
            justify="space-between"
            wrap="nowrap"
            px="xs"
            py={6}
            className={clsx(
              classes.conversationItem,
              isActive && classes.conversationItemActive,
            )}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(chat.id)}
            onKeyDown={(e) => {
              // Activate on Enter/Space like a native button; the inner menu
              // button stops propagation so its own keys never reach this row.
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(chat.id);
              }
            }}
          >
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                {chat.roleName && (
                  <Text
                    size="sm"
                    span
                    title={chat.roleName}
                    style={{ flex: "none" }}
                  >
                    {chat.roleEmoji || "🤖"}
                  </Text>
                )}
                <Text size="sm" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
                  {chat.title || t("Untitled chat")}
                </Text>
              </Group>
              <ChatMetaLine createdAt={chat.createdAt} pageTitle={chat.pageTitle} />
            </Box>
            <Menu shadow="md" width={180} position="bottom-end">
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={t("Chat menu")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
                <Menu.Item
                  leftSection={<IconEdit size={14} />}
                  onClick={() => startRename(chat)}
                >
                  {t("Rename")}
                </Menu.Item>
                <Menu.Item
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => confirmDelete(chat.id)}
                >
                  {t("Delete")}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        );
      })}
    </Box>
  );
}
