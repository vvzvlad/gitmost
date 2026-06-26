import { UnstyledButton, Text } from "@mantine/core";
import { IAiRole } from "@/features/ai-chat/types/ai-chat.types.ts";
import { roleCardColor } from "@/features/ai-chat/utils/role-card-color.ts";
import classes from "@/features/ai-chat/components/role-cards.module.css";

interface RoleCardsProps {
  /** The enabled roles to render (one card each). */
  roles: IAiRole[];
  /** Called with the picked role when a card is clicked. The parent starts the
   *  chat with this role (binds it and sends the opening message). */
  onPick: (role: IAiRole) => void;
}

/**
 * One role card. Colors are injected inline via theme-aware Mantine CSS vars so
 * they render correctly in both light and dark themes; the CSS module owns only
 * the layout. The card shows the emoji (if any), the role name, and a small
 * dimmed description line (if any).
 */
function RoleCard({
  color,
  name,
  emoji,
  description,
  onClick,
}: {
  color: string;
  name: string;
  emoji?: string | null;
  description?: string | null;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      className={classes.card}
      style={{
        backgroundColor: `var(--mantine-color-${color}-light)`,
        color: `var(--mantine-color-${color}-light-color)`,
      }}
      title={description ?? name}
      onClick={onClick}
    >
      {emoji && <span className={classes.emoji}>{emoji}</span>}
      <Text size="sm" fw={600} lineClamp={2}>
        {name}
      </Text>
      {description && (
        <Text size="xs" className={classes.description}>
          {description}
        </Text>
      )}
    </UnstyledButton>
  );
}

/**
 * Colored role cards rendered as the empty-state of a brand-new chat. There is
 * no Universal assistant card — the universal assistant is the implicit default
 * the user gets by simply typing into the composer without picking a card.
 * Clicking a card immediately STARTS the chat with that role (the parent binds
 * the role to the new chat and sends the opening message).
 */
export default function RoleCards({ roles, onPick }: RoleCardsProps) {
  return (
    <div className={classes.container}>
      {roles.map((role, index) => (
        <RoleCard
          key={role.id}
          color={roleCardColor(index)}
          name={role.name}
          emoji={role.emoji}
          description={role.description}
          onClick={() => onPick(role)}
        />
      ))}
    </div>
  );
}
