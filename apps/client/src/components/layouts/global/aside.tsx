import { ActionIcon, Box, Group, ScrollArea, Title, Tooltip } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import CommentListWithTabs from "@/features/comment/components/comment-list-with-tabs.tsx";
import { useAtom } from "jotai";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import React, { ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { TableOfContents } from "@/features/editor/components/table-of-contents/table-of-contents.tsx";
import { useAtomValue } from "jotai";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms.ts";
import { PageDetailsAside } from "@/features/page-details/components/page-details-aside.tsx";
import { ASIDE_PANEL_ID } from "@/hooks/use-toggle-aside.tsx";

export default function Aside() {
  const [{ tab, isAsideOpen }, setAsideState] = useAtom(asideStateAtom);
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const closeAside = () => setAsideState((s) => ({ ...s, isAsideOpen: false }));

  // Focus the panel ONLY on a user-driven open/tab change, never on the mount of
  // a restored-open panel (which would steal focus from the page on every reload,
  // racing use-title-autofocus). Snapshot the tab the panel was ALREADY showing
  // at mount: while it still matches, the open was a restore, so don't focus.
  // Resetting to null on close (and on the first user change) is required — a
  // "skip the first run" counter would misfire when the panel is restored CLOSED
  // (the early return never spends the flag) or on restore→toc→back-to-comments.
  const restoredTabRef = useRef(isAsideOpen ? tab : null);
  useEffect(() => {
    if (!isAsideOpen) {
      restoredTabRef.current = null;
      return;
    }
    if (restoredTabRef.current === tab) return; // still exactly as restored
    restoredTabRef.current = null; // any change from here on is user-driven
    document.getElementById(ASIDE_PANEL_ID)?.focus();
  }, [isAsideOpen, tab]);

  // Latch for the comment list: mount it on the panel's FIRST open within this
  // mount and keep it mounted afterwards. A plain `isAsideOpen` gate would
  // unmount it on close and discard a half-typed reply (reply editors keep their
  // drafts in local state). Set in the render body — not an effect — so a
  // restored-open panel mounts the list on the first render with no extra pass.
  // On reload there is no in-session draft to preserve, so gating comments here
  // costs nothing and avoids useCommentsQuery's full infinite-page fetch for a
  // closed panel.
  const commentsOpenedOnce = useRef(false);
  if (isAsideOpen) commentsOpenedOnce.current = true;

  let title: string;
  let component: ReactNode;

  switch (tab) {
    case "comments":
      component = commentsOpenedOnce.current ? (
        <CommentListWithTabs onClose={closeAside} />
      ) : null;
      title = "Comments";
      break;
    case "toc":
      // No draft to lose: gate purely on the open state so a closed panel does
      // not keep a live TableOfContents subscribed to editor `update` (a
      // debounced all-headings scan per keystroke) + an IntersectionObserver.
      component =
        isAsideOpen && tab === "toc" ? (
          <TableOfContents editor={pageEditor} />
        ) : null;
      title = "Table of contents";
      break;
    case "details":
      component = <PageDetailsAside />;
      title = "Details";
      break;
    default:
      component = null;
      title = null;
  }

  return (
    <Box p={0} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {component &&
        (tab === "comments" ? (
          component
        ) : (
          <>
            <Group justify="space-between" wrap="nowrap" mb="sm">
              <Title order={2} size="h6" fw={500}>
                {t(title)}
              </Title>
              <Tooltip label={t("Close")} withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={closeAside}
                  aria-label={t("Close")}
                >
                  <IconX size={18} />
                </ActionIcon>
              </Tooltip>
            </Group>
            <ScrollArea
              style={{ height: "85vh" }}
              scrollbarSize={5}
              type="scroll"
            >
              <div style={{ paddingBottom: "200px" }}>{component}</div>
            </ScrollArea>
          </>
        ))}
    </Box>
  );
}
