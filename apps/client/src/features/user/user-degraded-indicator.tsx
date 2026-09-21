import { Badge } from "@mantine/core";
import { IconCloudOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/**
 * The single user-visible signal that the session is DEGRADED (#641, part 3):
 * `/me` failed but a persisted/known user let the app stay mounted. Silent on a
 * healthy connection (rendered only on the degraded gate branch), unobtrusive,
 * and fixed to a corner so it never displaces app content. It is the only thing
 * standing between "app stays usable offline" and "app silently serves stale
 * data with no hint anything is wrong" (AGENTS.md rule #10).
 */
export function UserDegradedIndicator() {
  const { t } = useTranslation();
  return (
    <Badge
      role="status"
      aria-live="polite"
      variant="light"
      color="yellow"
      leftSection={<IconCloudOff size={13} />}
      className="print-hide"
      data-testid="user-degraded-indicator"
      styles={{
        root: {
          position: "fixed",
          bottom: 12,
          right: 12,
          zIndex: 1000,
          textTransform: "none",
        },
      }}
    >
      {/* Neutral wording: the degraded gate covers BOTH an unreachable network
          (reconnecting) AND a server that answered 5xx (not a connection issue),
          so "Reconnecting…" would be inaccurate for the latter. */}
      {t("Limited connectivity")}
    </Badge>
  );
}
