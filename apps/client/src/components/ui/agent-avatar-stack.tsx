import { Box, Group, Text, Tooltip } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSetAtom } from "jotai";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { LucideGlyph } from "@/components/ui/lucide/lucide-glyph.tsx";
import { parseIconRef } from "@/lib/icon-ref.ts";
import { avatarStyle, avatarBackgroundCss } from "@/lib/avatar-palette";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";

// The FRONT identity (the acting agent) and the BEHIND identity (the human who
// launched it). Both are computed server-side (#300) so the client never branches
// on the internal-vs-MCP provenance — it just renders whatever it is handed.
export interface AgentInfo {
  name: string;
  // The role glyph. Holds a serialized IconRef (a Lucide icon; see
  // lib/icon-ref.ts), NOT a native emoji — the column keeps its `emoji` name.
  emoji?: string | null;
  avatarUrl?: string | null;
}
export interface LauncherInfo {
  name: string;
  avatarUrl?: string | null;
}

const GLYPH_SIZE = 38;
const LAUNCHER_SIZE = 22;
// How far the launcher avatar sticks out past the agent's top-right corner — it
// sits as a small badge over that corner (above the glyph) and stays fully visible.
const LAUNCHER_OVERHANG = 8;

/**
 * The front avatar. Image-source priority (#300):
 *   1. agent.avatarUrl -> a real avatar image (external MCP agent account).
 *   2. agent.emoji     -> the role's Lucide icon on a per-agent gradient circle.
 *   3. otherwise       -> the IconSparkles glyph on a per-agent gradient circle.
 */
function AgentGlyph({ agent }: { agent: AgentInfo }) {
  if (agent.avatarUrl) {
    return (
      <CustomAvatar
        size={GLYPH_SIZE}
        avatarUrl={agent.avatarUrl}
        name={agent.name}
      />
    );
  }

  // Emoji/sparkles glyph on a per-agent gradient circle (color, gradient partner
  // and split angle all hashed from the agent name via avatarStyle — see
  // @/lib/avatar-palette). Rendered as a plain Box, NOT a Mantine
  // `Avatar variant="filled"` — Mantine's `--avatar-bg` overrode the background
  // (every agent fell back to the theme's violet). The foreground (the sparkles
  // icon) uses the ring's WCAG-checked readable text color.
  const style = avatarStyle(agent.name);
  return (
    <Box
      data-testid="agent-glyph"
      style={{
        width: GLYPH_SIZE,
        height: GLYPH_SIZE,
        borderRadius: "50%",
        // Solid base color is the fallback (and the testable value); the gradient
        // paints over it in browsers that support it.
        backgroundColor: style.bg,
        backgroundImage: avatarBackgroundCss(style),
        color:
          style.text === "white"
            ? "var(--mantine-color-white)"
            : "var(--mantine-color-black)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}
    >
      <LucideGlyph
        name={parseIconRef(agent.emoji)?.name}
        size={Math.round(GLYPH_SIZE * 0.55)}
        strokeWidth={2}
        fallback={
          <IconSparkles size={Math.round(GLYPH_SIZE * 0.55)} stroke={2} />
        }
      />
    </Box>
  );
}

export interface AgentAvatarStackProps {
  agent: AgentInfo;
  // null/absent => external MCP (front agent avatar only, no human behind).
  launcher?: LauncherInfo | null;
  // Deep-links into the internal AI chat when present (null for external MCP).
  aiChatId?: string | null;
  // Fired after the stack deep-links into its chat, so the caller can react
  // (e.g. the page-history row closes the history modal). Keeps this ui/ primitive
  // free of cross-feature coupling (inherited from the old AiAgentBadge, #143).
  onActivate?: () => void;
  // Whether to render the inline name label next to the avatars (default true).
  // Set false when the caller renders the name itself (e.g. the comment row).
  showName?: boolean;
}

/**
 * The "agent avatar stack" (#300): the AGENT glyph, and — for an internal AI
 * chat — the HUMAN who launched it as a smaller avatar badge on top, overhanging
 * the glyph's top-right corner in FRONT (zIndex 2 > the glyph's zIndex 1) so the
 * launcher stays fully visible rather than being half-hidden behind the glyph.
 * Replaces the old text `AI-agent` badge. When the item carries an `aiChatId` the
 * whole stack is a deep-link into that chat (the click the old badge owned moved
 * here); the click is contained (stopPropagation) so it does not also trigger an
 * enclosing row handler.
 */
export function AgentAvatarStack({
  agent,
  launcher,
  aiChatId,
  onActivate,
  showName = true,
}: AgentAvatarStackProps) {
  const { t } = useTranslation();
  const setAiChatWindowOpen = useSetAtom(aiChatWindowOpenAtom);
  const setActiveChatId = useSetAtom(activeAiChatIdAtom);
  const setDraft = useSetAtom(aiChatDraftAtom);

  const clickable = !!aiChatId;

  const openChat = useCallback(
    (event: React.SyntheticEvent) => {
      event.stopPropagation();
      if (!aiChatId) return;
      setActiveChatId(aiChatId);
      // Switching chats must start with a clean composer — clear any unsent draft
      // so it does not leak from the previously open chat.
      setDraft("");
      setAiChatWindowOpen(true);
      onActivate?.();
    },
    [aiChatId, setActiveChatId, setDraft, setAiChatWindowOpen, onActivate],
  );

  // Internal chat => "role on behalf of person"; external MCP => just the agent.
  const tooltip = launcher
    ? t("AI agent «{{role}}» on behalf of {{person}}", {
        role: agent.name,
        person: launcher.name,
      })
    : t("AI agent {{name}}", { name: agent.name });

  // The container is only enlarged when there is a launcher to overhang; with no
  // human behind it stays tight at the agent glyph size.
  const stackSize = launcher ? GLYPH_SIZE + LAUNCHER_OVERHANG : GLYPH_SIZE;

  const stack = (
    <Box
      pos="relative"
      style={{
        width: stackSize,
        height: stackSize,
        flexShrink: 0,
        // Center the (in-flow) agent glyph vertically so it lines up with its
        // name label; the absolutely-positioned launcher is unaffected by flex.
        display: "flex",
        alignItems: "center",
        cursor: clickable ? "pointer" : undefined,
      }}
      {...(clickable
        ? {
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
      {launcher && (
        // Launcher badge sits ABOVE the agent glyph (zIndex) at the top-right so
        // it is fully visible, not half-hidden behind the agent circle.
        <Box pos="absolute" top={0} right={0} style={{ zIndex: 2 }}>
          <CustomAvatar
            size={LAUNCHER_SIZE}
            avatarUrl={launcher.avatarUrl}
            name={launcher.name}
            style={{ border: "2px solid var(--mantine-color-body)" }}
          />
        </Box>
      )}
      {/* The agent glyph keeps its own size (flex-centered in the container); the
          launcher overhangs it by LAUNCHER_OVERHANG at the top-right and stays visible. */}
      <Box
        style={{
          position: "relative",
          zIndex: 1,
          width: GLYPH_SIZE,
          height: GLYPH_SIZE,
        }}
      >
        <AgentGlyph agent={agent} />
      </Box>
    </Box>
  );

  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <Tooltip label={tooltip} withArrow>
        {stack}
      </Tooltip>
      {showName && (
        <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="xs" fw={600} lineClamp={1} lh={1.2}>
            {agent.name}
          </Text>
          {launcher && (
            <>
              <Text size="xs" c="dimmed" fw={400} aria-hidden>
                ·
              </Text>
              <Text size="xs" c="dimmed" fw={400} lineClamp={1} lh={1.2}>
                {launcher.name}
              </Text>
            </>
          )}
        </Group>
      )}
    </Group>
  );
}

export default AgentAvatarStack;
