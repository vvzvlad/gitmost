import { Badge, Tooltip } from "@mantine/core";
import { IconGitMerge } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

interface GitSyncBadgeProps {
  authorName?: string;
}

/**
 * Badge marking a version produced by git-sync (provenance §8.1). The history
 * version is created on the PUSH path — when an incoming git body is written back
 * into the Docmost doc — not by the pull itself. Like {@link AiAgentBadge} it is
 * ADDITIVE — shown next to the human author, never replacing them — but a git-sync
 * edit is NOT an agent edit and has no chat to deep-link into, so it is a small,
 * neutral, non-clickable label.
 */
export function GitSyncBadge({ authorName }: GitSyncBadgeProps) {
  const { t } = useTranslation();

  const tooltip = t("Synced from Git on behalf of {{name}}", {
    name: authorName ?? "",
  });

  return (
    <Tooltip label={tooltip} withArrow>
      <Badge
        size="sm"
        variant="light"
        color="gray"
        radius="sm"
        leftSection={<IconGitMerge size={12} stroke={2} />}
      >
        {t("Git sync")}
      </Badge>
    </Tooltip>
  );
}
