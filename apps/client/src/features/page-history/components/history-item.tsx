import {
  Text,
  Group,
  UnstyledButton,
  Avatar,
  Tooltip,
  Badge,
} from "@mantine/core";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { GitSyncBadge } from "@/components/ui/git-sync-badge.tsx";
import { AgentAvatarStack } from "@/components/ui/agent-avatar-stack.tsx";
import { formattedDate } from "@/lib/time";
import classes from "./css/history.module.css";
import clsx from "clsx";
import { IPageHistory } from "@/features/page-history/types/page.types";
import { memo, useCallback } from "react";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { historyAtoms } from "@/features/page-history/atoms/history-atoms.ts";
// #568 — historyKindMeta moved to a pure module; re-exported here so existing
// importers (history-list, this file) keep their import path unchanged.
import { historyKindMeta } from "@/features/page-history/utils/history-kind-meta";

export { historyKindMeta };

const MAX_VISIBLE_AVATARS = 5;

interface HistoryItemProps {
  historyItem: IPageHistory;
  // The previous snapshot for diff/restore is resolved by id from the FULL list
  // in the parent (resolvePrevSnapshotId), so the item only needs to report its
  // own id — never a list index (which would be the filtered-view index).
  onSelect: (id: string) => void;
  onHover?: (id: string) => void;
  onHoverEnd?: () => void;
  isActive: boolean;
}

const HistoryItem = memo(function HistoryItem({
  historyItem,
  onSelect,
  onHover,
  onHoverEnd,
  isActive,
}: HistoryItemProps) {
  const setHistoryModalOpen = useSetAtom(historyAtoms);
  const { t } = useTranslation();
  const kindMeta = historyKindMeta(historyItem.kind);

  const handleClick = useCallback(() => {
    onSelect(historyItem.id);
  }, [onSelect, historyItem.id]);

  const handleMouseEnter = useCallback(() => {
    onHover?.(historyItem.id);
  }, [onHover, historyItem.id]);

  const contributors = historyItem.contributors;
  const hasContributors = contributors && contributors.length > 0;
  const isAgentEdit = historyItem.lastUpdatedSource === "agent";
  const isGitSyncEdit = historyItem.lastUpdatedSource === "git-sync";

  return (
    <UnstyledButton
      p="xs"
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onHoverEnd}
      className={clsx(classes.history, { [classes.active]: isActive })}
      // #370 — dim autosnapshots so intentional versions stand out.
      style={{ opacity: kindMeta.version ? 1 : 0.55 }}
    >
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Text size="sm">{formattedDate(new Date(historyItem.createdAt))}</Text>
        <Badge
          size="xs"
          radius="sm"
          variant={kindMeta.version ? "filled" : "light"}
          color={kindMeta.color}
        >
          {t(kindMeta.labelKey)}
        </Badge>
      </Group>

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

        {isAgentEdit && historyItem.agent && (
          <AgentAvatarStack
            agent={historyItem.agent}
            launcher={historyItem.launcher}
            aiChatId={historyItem.lastUpdatedAiChatId}
            // The history row owns the modal: close it when the stack deep-links
            // into the chat (the stack no longer reaches into page-history).
            onActivate={() => setHistoryModalOpen(false)}
          />
        )}

        {isGitSyncEdit && (
          <GitSyncBadge authorName={historyItem.lastUpdatedBy?.name} />
        )}
      </Group>
    </UnstyledButton>
  );
});

export default HistoryItem;
