import { ActionIcon, Box, Group, ScrollArea, Title, Tooltip } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import CommentListWithTabs from "@/features/comment/components/comment-list-with-tabs.tsx";
import { useAtom } from "jotai";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import React, { ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { TableOfContents } from "@/features/editor/components/table-of-contents/table-of-contents.tsx";
import { useAtomValue } from "jotai";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms.ts";
import { PageDetailsAside } from "@/features/page-details/components/page-details-aside.tsx";
import AiChatPanel from "@/features/ai-chat/components/ai-chat-panel.tsx";
import { ASIDE_PANEL_ID } from "@/hooks/use-toggle-aside.tsx";

export default function Aside() {
  const [{ tab, isAsideOpen }, setAsideState] = useAtom(asideStateAtom);
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const closeAside = () => setAsideState((s) => ({ ...s, isAsideOpen: false }));

  useEffect(() => {
    if (!isAsideOpen) return;
    document.getElementById(ASIDE_PANEL_ID)?.focus();
  }, [isAsideOpen, tab]);

  let title: string;
  let component: ReactNode;

  switch (tab) {
    case "comments":
      component = <CommentListWithTabs />;
      title = "Comments";
      break;
    case "toc":
      component = <TableOfContents editor={pageEditor} />;
      title = "Table of contents";
      break;
    case "details":
      component = <PageDetailsAside />;
      title = "Details";
      break;
    case "ai-chat":
      // The AI chat panel renders its own header (title + new-chat + close) and
      // manages its own scrolling, so it bypasses the shared Aside chrome below.
      component = <AiChatPanel />;
      title = "AI chat";
      break;
    default:
      component = null;
      title = null;
  }

  // The AI chat panel owns the full aside area (its own header + layout).
  if (tab === "ai-chat") {
    return (
      <Box p="md" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {component}
      </Box>
    );
  }

  return (
    <Box p="md" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {component && (
        <>
          <Group justify="space-between" wrap="nowrap" mb="md">
            <Title order={2} size="h6" fw={500}>{t(title)}</Title>
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

          {tab === "comments" ? (
            component
          ) : (
            <ScrollArea
              style={{ height: "85vh" }}
              scrollbarSize={5}
              type="scroll"
            >
              <div style={{ paddingBottom: "200px" }}>{component}</div>
            </ScrollArea>
          )}
        </>
      )}
    </Box>
  );
}
