import { Badge, Box, Group, Text } from "@mantine/core";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { LucideGlyph } from "@/components/ui/lucide/lucide-glyph.tsx";
import { parseIconRef } from "@/lib/icon-ref.ts";
import { useTranslation } from "react-i18next";
import { memo } from "react";
import { RevisionRowData } from "@/features/page-history/utils/revision-row";
import classes from "./css/history.module.css";
import clsx from "clsx";

interface Props {
  row: RevisionRowData;
  selected: boolean;
  onSelect: (id: string) => void;
  onHover?: (id: string) => void;
  onHoverEnd?: () => void;
}

/**
 * #568 — one revision = one dense row: `glyph · time · author · [SAVED]`.
 *  - Agent identity (`row.isAgent`) → a SQUARE role glyph (emoji or initial) +
 *    "via <launcher>"; a human → the round CustomAvatar. (Multi-contributor
 *    stacks are deliberately dropped in the dense list — one glyph per row.)
 *  - SAVED badge only when `row.saved` (kind === 'manual'); agent versions rely
 *    on the glyph, autosaves are dimmed (`!row.version`), neither gets a badge.
 */
const RevisionRow = memo(function RevisionRow({
  row,
  selected,
  onSelect,
  onHover,
  onHoverEnd,
}: Props) {
  const { t } = useTranslation();

  return (
    <Group
      gap={8}
      wrap="nowrap"
      h={30}
      px={12}
      data-testid="revision-row"
      data-day={row.dayISO}
      // Keyboard-accessible (F3 a11y): a focusable button-role row activated by
      // Enter/Space, not just a mouse onClick.
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(row.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(row.id);
        }
      }}
      onMouseEnter={() => onHover?.(row.id)}
      onMouseLeave={onHoverEnd}
      className={clsx(classes.revisionRow, {
        [classes.revisionRowActive]: selected,
      })}
      // #370 — dim autosnapshots so intentional versions stand out.
      style={{ opacity: row.version ? 1 : 0.55, cursor: "pointer" }}
    >
      {row.isAgent ? (
        <Box
          data-testid="revision-agent-glyph"
          style={{
            flex: "none",
            width: 18,
            height: 18,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            fontWeight: 700,
            lineHeight: 1,
            background: "var(--mantine-color-violet-light)",
            color: "var(--mantine-color-violet-filled)",
          }}
          aria-label={row.agentName}
        >
          <LucideGlyph
            name={parseIconRef(row.agentEmoji)?.name}
            size={12}
            fallback={
              <>{row.agentName?.[0]?.toUpperCase() ?? "A"}</>
            }
          />
        </Box>
      ) : (
        <CustomAvatar
          size={18}
          avatarUrl={row.authorAvatarUrl}
          name={row.authorName}
        />
      )}

      <Text
        fz={12.5}
        c="dimmed"
        style={{ flex: "none", minWidth: 62 }}
        data-testid="revision-time"
      >
        {row.atLabel}
      </Text>

      <Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <Text fz={12} fw={row.isAgent ? 600 : 400} truncate>
          {row.isAgent ? row.agentName : row.authorName}
        </Text>
        {row.isAgent && row.launcherName && (
          <Text fz={11} c="dimmed" truncate>
            · {t("via")} {row.launcherName}
          </Text>
        )}
      </Group>

      {row.saved && (
        <Badge
          size="sm"
          radius="sm"
          variant="light"
          color="blue"
          tt="uppercase"
        >
          {t("Saved")}
        </Badge>
      )}
    </Group>
  );
});

export default RevisionRow;
