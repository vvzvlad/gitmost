import { Text, Group, UnstyledButton, Avatar, Tooltip } from "@mantine/core";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { AiAgentBadge } from "@/components/ui/ai-agent-badge.tsx";
import { formattedDate } from "@/lib/time";
import classes from "./css/history.module.css";
import clsx from "clsx";
import { IPageHistory } from "@/features/page-history/types/page.types";
import { memo, useCallback } from "react";
import { useSetAtom } from "jotai";
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

const HistoryItem = memo(function HistoryItem({
  historyItem,
  index,
  onSelect,
  onHover,
  onHoverEnd,
  isActive,
}: HistoryItemProps) {
  const setHistoryModalOpen = useSetAtom(historyAtoms);

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
            // The history row owns the modal: close it when the badge deep-links
            // into the chat (the badge no longer reaches into page-history).
            onActivate={() => setHistoryModalOpen(false)}
          />
        )}
      </Group>
    </UnstyledButton>
  );
});

export default HistoryItem;
