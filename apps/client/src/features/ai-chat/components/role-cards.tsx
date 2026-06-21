import { UnstyledButton, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { IAiRole } from "@/features/ai-chat/types/ai-chat.types.ts";
import { roleCardColor } from "@/features/ai-chat/utils/role-card-color.ts";
import classes from "@/features/ai-chat/components/role-cards.module.css";

interface RoleCardsProps {
  /** The enabled roles to render (one card each), after the Universal card. */
  roles: IAiRole[];
  /** The currently selected role id; null = Universal assistant (the default). */
  selectedRoleId: string | null;
  /** Called with the picked role id, or null for the Universal assistant card. */
  onSelect: (id: string | null) => void;
}

/**
 * One role card. Colors are injected inline via theme-aware Mantine CSS vars so
 * they render correctly in both light and dark themes; the CSS module owns only
 * the layout. The selected card gets a brighter ring (`--role-card-border`) plus
 * a small check badge, and carries `aria-pressed` for a11y/testing.
 */
function RoleCard({
  color,
  label,
  emoji,
  title,
  selected,
  onClick,
}: {
  color: string;
  label: string;
  emoji?: string | null;
  title?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      className={`${classes.card}${selected ? ` ${classes.selected}` : ""}`}
      style={{
        backgroundColor: `var(--mantine-color-${color}-light)`,
        color: `var(--mantine-color-${color}-light-color)`,
        // The selected-ring color (used by the CSS module).
        ["--role-card-border" as string]: `var(--mantine-color-${color}-filled)`,
      }}
      title={title}
      aria-pressed={selected}
      onClick={onClick}
    >
      {selected && (
        <span className={classes.checkBadge}>
          <IconCheck size={11} />
        </span>
      )}
      {emoji && <span className={classes.emoji}>{emoji}</span>}
      <Text size="sm" fw={500} lineClamp={2}>
        {label}
      </Text>
    </UnstyledButton>
  );
}

/**
 * Colored role cards rendered as the empty-state of a brand-new chat. Clicking a
 * card selects that identity; the first (gray) card returns to the default
 * Universal assistant. Selection state lives in the parent atom, so when the
 * chat is no longer empty these cards are simply not rendered and the existing
 * server wiring is unchanged.
 */
export default function RoleCards({
  roles,
  selectedRoleId,
  onSelect,
}: RoleCardsProps) {
  const { t } = useTranslation();

  return (
    <div className={classes.container}>
      {/* Universal assistant: neutral gray, value null, highlighted by default. */}
      <RoleCard
        color="gray"
        label={t("Universal assistant")}
        selected={selectedRoleId === null}
        onClick={() => onSelect(null)}
      />
      {roles.map((role, index) => (
        <RoleCard
          key={role.id}
          color={roleCardColor(index)}
          label={role.name}
          emoji={role.emoji}
          title={role.description ?? role.name}
          selected={selectedRoleId === role.id}
          onClick={() => onSelect(role.id)}
        />
      ))}
    </div>
  );
}
