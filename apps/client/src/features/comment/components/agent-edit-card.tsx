import React, { useMemo } from "react";
import {
  Badge,
  Box,
  Button,
  Group,
  Stack,
  Text,
  useMantineColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { AgentAvatarStack } from "@/components/ui/agent-avatar-stack.tsx";
import CommentContentView from "@/features/comment/components/comment-content-view";
import { IComment } from "@/features/comment/types/comment.types";
import {
  canShowApply,
  canShowDismiss,
  computeSuggestionDiff,
  Segment,
} from "@/features/comment/utils/suggestion";
import { commentContentToText } from "@/features/comment/utils/comment-content-to-text";
import {
  isSignificant,
  parseSeverity,
  Severity,
} from "@/features/comment/utils/severity";
import {
  useApplySuggestionMutation,
  useDismissSuggestionMutation,
} from "@/features/comment/queries/comment-query";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useTimeAgo } from "@/hooks/use-time-ago";

// Scroll the document to this comment's inline mark and flash it — the same
// anchor navigation the old panel used (handleCommentClick). Used both by a card
// click and by an explicit "Go to text" affordance.
function scrollToCommentMark(commentId: string) {
  const el = document.querySelector(
    `.comment-mark[data-comment-id="${commentId}"]`,
  );
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("comment-highlight");
    setTimeout(() => el.classList.remove("comment-highlight"), 3000);
  }
}

// Make otherwise-invisible edited whitespace legible inside a highlighted diff
// fragment (a pure-space insertion/deletion would otherwise look like nothing
// changed).
function visibleWhitespace(s: string): string {
  return s.replace(/ /g, "␣").replace(/\t/g, "⇥");
}

// One line of the intraline diff. `kind==="del"` is the old ("было") line drawn
// red with a strike-through; `kind==="ins"` is the new ("стало") line drawn
// green. Only the `changed` segments carry the emphasised mark background — the
// common segments read as plain context (git/GitHub-style, #331).
function DiffLine({
  segments,
  kind,
}: {
  segments: Segment[];
  kind: "del" | "ins";
}) {
  const theme = useMantineTheme();
  const { colorScheme } = useMantineColorScheme();
  const dark = colorScheme === "dark";
  const isDel = kind === "del";
  const sign = isDel ? "−" : "+";
  const signColor = isDel
    ? theme.colors.red[dark ? 5 : 6]
    : theme.colors.green[dark ? 5 : 6];
  const baseColor = isDel
    ? dark
      ? theme.colors.gray[5]
      : theme.colors.gray[6]
    : dark
      ? theme.colors.gray[1]
      : theme.colors.dark[9];
  const markBg = isDel
    ? dark
      ? "rgba(224,49,49,.22)"
      : "#ffe3e3"
    : dark
      ? "rgba(47,158,68,.22)"
      : "#d3f9d8";
  const markFg = isDel
    ? dark
      ? theme.colors.red[3]
      : theme.colors.red[8]
    : dark
      ? theme.colors.green[3]
      : theme.colors.green[9];

  return (
    <Group gap={7} wrap="nowrap" align="flex-start">
      <Text
        ff="monospace"
        fw={600}
        fz={12}
        c={signColor}
        w={11}
        ta="center"
        aria-hidden
        style={{ flex: "none", lineHeight: 1.5 }}
      >
        {sign}
      </Text>
      <Text
        fz={13.5}
        c={baseColor}
        style={{
          lineHeight: 1.45,
          // Let this flex child shrink below its content width (default
          // min-width:auto would keep the row as wide as the text) and break
          // long runs at the card edge. Needed because visibleWhitespace()
          // turns a long insertion into one unbreakable "word" (spaces become
          // ␣), which otherwise overflows the card to the right.
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {segments.map((seg, i) =>
          seg.changed ? (
            <Box
              key={i}
              component="mark"
              fw={600}
              style={{
                background: markBg,
                color: markFg,
                borderRadius: 2,
                // Snug intra-word highlight: a hair of horizontal padding keeps
                // the mark background slightly wider than the glyph, canceled by
                // an equal negative margin so neighbouring letters are NOT pushed
                // apart. The old px={3} padding made single-letter edits (е→ё,
                // х→е) look like they had spaces around the changed character.
                padding: "0 1px",
                margin: "0 -1px",
                textDecoration: isDel ? "line-through" : "none",
              }}
            >
              {visibleWhitespace(seg.text)}
            </Box>
          ) : (
            <Box
              key={i}
              component="span"
              style={{ textDecoration: isDel ? "line-through" : "none" }}
            >
              {seg.text}
            </Box>
          ),
        )}
      </Text>
    </Group>
  );
}

// The "было → стало" block. A pure insertion (empty `before`) hides the old
// line; a pure deletion (empty `after`) hides the new line.
function DiffBlock({ before, after }: { before: Segment[]; after: Segment[] }) {
  const pureInsert = before.length === 0;
  const pureDelete = after.length === 0;
  return (
    <Stack gap={1}>
      {!pureInsert && <DiffLine segments={before} kind="del" />}
      {!pureDelete && <DiffLine segments={after} kind="ins" />}
    </Stack>
  );
}

const SEV_DOT: Record<Severity, { color: string; shade: number }> = {
  critical: { color: "red", shade: 6 },
  major: { color: "orange", shade: 6 },
  minor: { color: "gray", shade: 5 },
  // A neutral, deliberately faint dot — NOT the minor grey — so an untagged or
  // verdict-only edit never reads as a graded severity.
  unknown: { color: "gray", shade: 3 },
};

function SeverityDot({ severity }: { severity: Severity }) {
  return (
    <Box
      w={8}
      h={8}
      aria-hidden
      style={(t) => ({
        flex: "none",
        borderRadius: "50%",
        background: t.colors[SEV_DOT[severity].color][SEV_DOT[severity].shade],
      })}
    />
  );
}

interface AgentEditCardProps {
  comment: IComment;
  canComment: boolean;
  canEdit?: boolean;
  userSpaceRole?: string;
  // Whether to render the per-card agent avatar + timestamp. A card inside a
  // collapsed run omits it (the RunHeader carries the one provenance line);
  // a standalone card shows it (#300 provenance must be visible on the card).
  showProvenance?: boolean;
}

// Type A — the diff-first agent suggested-edit card. It carries NO TipTap editor
// (a perf win vs. the old row, #340); the body renders through the static
// CommentContentView. Apply/Dismiss reuse the existing mutations and gates
// verbatim — the reskin changes presentation only, not the 409/404/400 toast
// semantics or the authz gating.
function AgentEditCard({
  comment,
  canComment,
  canEdit,
  userSpaceRole,
  showProvenance = true,
}: AgentEditCardProps) {
  const { t } = useTranslation();
  const [currentUser] = useAtom(currentUserAtom);
  const applySuggestionMutation = useApplySuggestionMutation();
  const dismissSuggestionMutation = useDismissSuggestionMutation();
  const createdAtAgo = useTimeAgo(comment.createdAt);

  const diff = useMemo(
    () =>
      computeSuggestionDiff(comment.selection ?? "", comment.suggestedText ?? ""),
    [comment.selection, comment.suggestedText],
  );

  const severity = useMemo(
    () => parseSeverity(commentContentToText(comment.content)),
    [comment.content],
  );

  // Owner-or-space-admin gate (#338), mirrored from the old row so we never
  // render a Dismiss the server would 403.
  const isOwnerOrAdmin =
    currentUser?.user?.id === comment.creatorId || userSpaceRole === "admin";

  const isApplied = comment.suggestionAppliedAt != null;
  const showApply = canShowApply(comment, canEdit);
  const showDismiss = canShowDismiss(comment, canComment, isOwnerOrAdmin);
  const pending =
    applySuggestionMutation.isPending || dismissSuggestionMutation.isPending;

  const handleApply = async () => {
    try {
      await applySuggestionMutation.mutateAsync({
        commentId: comment.id,
        pageId: comment.pageId,
      });
    } catch (error) {
      // Errors (incl. 409 "text changed") surface via the mutation's onError.
      console.error("Failed to apply suggestion:", error);
    }
  };

  const handleDismiss = async () => {
    try {
      await dismissSuggestionMutation.mutateAsync({
        commentId: comment.id,
        pageId: comment.pageId,
      });
    } catch (error) {
      // Idempotent 404 is reconciled to success in the mutation's onError.
      console.error("Failed to dismiss suggestion:", error);
    }
  };

  const sevLabel =
    severity === "critical"
      ? t("Critical")
      : severity === "major"
        ? t("Major")
        : null;

  return (
    <Box
      p="10px 12px"
      role="button"
      tabIndex={0}
      aria-label={t("Jump to comment selection")}
      onClick={() => scrollToCommentMark(comment.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          scrollToCommentMark(comment.id);
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <Stack gap={8}>
        {showProvenance && comment.agent && (
          <Group
            gap={8}
            wrap="nowrap"
            justify="space-between"
            onClick={(e) => e.stopPropagation()}
          >
            <AgentAvatarStack
              agent={comment.agent}
              launcher={comment.launcher}
              aiChatId={comment.aiChatId}
            />
            <Text size="xs" c="dimmed" style={{ flex: "none" }}>
              {createdAtAgo}
            </Text>
          </Group>
        )}

        <DiffBlock before={diff.old} after={diff.new} />

        {/* Agent rationale — rendered through the static ProseMirror view, not
            restructured into a flat string. */}
        <Box fz="xs" c="dimmed">
          <CommentContentView content={comment.content} />
        </Box>

        <Group gap={8} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
          <SeverityDot severity={severity} />
          {sevLabel && (
            <Text
              fz={10}
              fw={600}
              tt="uppercase"
              c="dimmed"
              style={{ letterSpacing: ".06em", flex: 1 }}
            >
              {sevLabel}
            </Text>
          )}
          <Box style={{ flex: 1 }} />
          {/* Applied state (#315): a suggestion that was applied but kept alive by
              its replies (so #329 resolved instead of hard-deleting it) still
              shows it was applied — the badge the pre-redesign card carried. A
              childless applied suggestion is gone from the list entirely, so this
              only renders in the Resolved tab. */}
          {isApplied && (
            <Badge
              size="sm"
              color="green"
              variant="light"
              aria-label={t("Applied")}
            >
              {t("Applied")}
            </Badge>
          )}
          {showDismiss && (
            <Button
              size="compact-sm"
              variant="default"
              color="gray"
              loading={dismissSuggestionMutation.isPending}
              disabled={pending}
              onClick={handleDismiss}
            >
              {t("Dismiss")}
            </Button>
          )}
          {showApply && (
            <Button
              size="compact-sm"
              color="green"
              loading={applySuggestionMutation.isPending}
              disabled={pending}
              onClick={handleApply}
            >
              {t("Apply")}
            </Button>
          )}
        </Group>
      </Stack>
    </Box>
  );
}

// Series header for a collapsed agent run: ONE provenance line for N edits,
// with a "N edits · M major" tally. There is intentionally NO "Accept all"
// button / progress / Stop (rejected by product) and NO "K applied" counter
// (uncomputable after the #329 hard-delete). Purely visual.
export function RunHeader({ comments }: { comments: IComment[] }) {
  const { t } = useTranslation();
  const head = comments[0];
  const createdAtAgo = useTimeAgo(head?.createdAt);

  const majors = useMemo(
    () =>
      comments.filter((c) =>
        isSignificant(parseSeverity(commentContentToText(c.content))),
      ).length,
    [comments],
  );

  if (!head) return null;

  return (
    <Box
      p="11px 13px"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <Group gap={10} wrap="nowrap" justify="space-between">
        {head.agent ? (
          <AgentAvatarStack
            agent={head.agent}
            launcher={head.launcher}
            aiChatId={head.aiChatId}
          />
        ) : (
          <Text size="sm" fw={600}>
            {head.creator?.name}
          </Text>
        )}
        <Text size="xs" c="dimmed" style={{ flex: "none" }}>
          {createdAtAgo}
        </Text>
      </Group>
      <Text fz={11.5} c="dimmed" mt={4}>
        {t("{{count}} edits", { count: comments.length })}
        {majors > 0 && (
          <>
            {" · "}
            <Text span c="orange.7" fw={600} inherit>
              {t("{{count}} major", { count: majors })}
            </Text>
          </>
        )}
      </Text>
    </Box>
  );
}

export default React.memo(AgentEditCard);
