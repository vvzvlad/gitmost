import { Text, Group, UnstyledButton, Avatar, Tooltip, Badge } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { formattedDate } from "@/lib/time";
import classes from "./css/history.module.css";
import clsx from "clsx";
import { IPageHistory } from "@/features/page-history/types/page.types";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSetAtom } from "jotai";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";
import { historyAtoms } from "@/features/page-history/atoms/history-atoms.ts";

const MAX_VISIBLE_AVATARS = 5;

interface HistoryItemProps {
  historyItem: IPageHistory;
  index: number;
  onSelect: (id: string, index: number) => void;
  onHover?: (id: string, index: number) => void;
  onHoverEnd?: () => void;
  isActive: boolean;
}

/**
 * Badge marking a version written by the AI agent (provenance C3 / §7.4). It is
 * ADDITIVE — shown next to the human author, never replacing them. When the
 * version carries an `aiChatId`, clicking the badge deep-links into that chat:
 * it sets the active-chat atom, opens the floating AI-chat window, and closes
 * the history modal. The click is contained (stopPropagation) so it does not
 * also trigger the row's version-select.
 */
function AiAgentBadge({
  authorName,
  aiChatId,
}: {
  authorName?: string;
  aiChatId?: string | null;
}) {
  const { t } = useTranslation();
  const setAiChatWindowOpen = useSetAtom(aiChatWindowOpenAtom);
  const setActiveChatId = useSetAtom(activeAiChatIdAtom);
  const setDraft = useSetAtom(aiChatDraftAtom);
  const setHistoryModalOpen = useSetAtom(historyAtoms);

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
      setHistoryModalOpen(false);
    },
    [
      aiChatId,
      setActiveChatId,
      setDraft,
      setAiChatWindowOpen,
      setHistoryModalOpen,
    ],
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
            // invalid <button>-in-<button> nesting inside the history row's
            // UnstyledButton; expose it as an accessible button via role/keyboard.
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

const HistoryItem = memo(function HistoryItem({
  historyItem,
  index,
  onSelect,
  onHover,
  onHoverEnd,
  isActive,
}: HistoryItemProps) {
  const handleClick = useCallback(() => {
    onSelect(historyItem.id, index);
  }, [onSelect, historyItem.id, index]);

  const handleMouseEnter = useCallback(() => {
    onHover?.(historyItem.id, index);
  }, [onHover, historyItem.id, index]);

  const contributors = historyItem.contributors;
  const hasContributors = contributors && contributors.length > 0;
  const isAgentEdit = historyItem.lastUpdatedSource === "agent";

  return (
    <UnstyledButton
      p="xs"
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onHoverEnd}
      className={clsx(classes.history, { [classes.active]: isActive })}
    >
      <Text size="sm">{formattedDate(new Date(historyItem.createdAt))}</Text>

      <Group gap={6} wrap="nowrap" mt={4}>
        {hasContributors ? (
          <>
            <Tooltip.Group openDelay={300} closeDelay={100}>
              <Avatar.Group spacing={8}>
                {contributors.slice(0, MAX_VISIBLE_AVATARS).map((contributor) => (
                  <Tooltip key={contributor.id} label={contributor.name} withArrow>
                    <CustomAvatar
                      size="sm"
                      avatarUrl={contributor.avatarUrl}
                      name={contributor.name}
                    />
                  </Tooltip>
                ))}
                {contributors.length > MAX_VISIBLE_AVATARS && (
                  <Tooltip
                    withArrow
                    label={contributors.slice(MAX_VISIBLE_AVATARS).map((c) => (
                      <div key={c.id}>{c.name}</div>
                    ))}
                  >
                    <Avatar size="sm" color="gray">
                      +{contributors.length - MAX_VISIBLE_AVATARS}
                    </Avatar>
                  </Tooltip>
                )}
              </Avatar.Group>
            </Tooltip.Group>
            {contributors.length === 1 && (
              <Text size="sm" c="dimmed" lineClamp={1}>
                {contributors[0].name}
              </Text>
            )}
          </>
        ) : (
          <>
            <CustomAvatar
              size="sm"
              avatarUrl={historyItem.lastUpdatedBy?.avatarUrl}
              name={historyItem.lastUpdatedBy?.name}
            />
            <Text size="sm" c="dimmed" lineClamp={1}>
              {historyItem.lastUpdatedBy?.name}
            </Text>
          </>
        )}

        {isAgentEdit && (
          <AiAgentBadge
            authorName={historyItem.lastUpdatedBy?.name}
            aiChatId={historyItem.lastUpdatedAiChatId}
          />
        )}
      </Group>
    </UnstyledButton>
  );
});

export default HistoryItem;
