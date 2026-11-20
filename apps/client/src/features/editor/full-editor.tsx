import classes from "@/features/editor/styles/editor.module.css";
import React, { useEffect, useLayoutEffect, useRef } from "react";
import { TitleEditor } from "@/features/editor/title-editor";
import PageEditor from "@/features/editor/page-editor";
import { Alert, Container, Group } from "@mantine/core";
import { IconWifiOff } from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import {
  userAtom,
  workspaceAtom,
} from "@/features/user/atoms/current-user-atom.ts";
import { useTranslation } from "react-i18next";
import { FixedToolbar } from "@/features/editor/components/fixed-toolbar/fixed-toolbar";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import { MAIN_CONTENT_ID } from "@/components/ui/skip-to-main.tsx";
import { computeColumnLayout } from "@/features/editor/utils/compute-column-layout.ts";
import { DeletedPageBanner } from "@/features/page/trash/components/deleted-page-banner.tsx";
import { TemporaryNoteBanner } from "@/features/page/components/temporary-note-banner.tsx";
import clsx from "clsx";
import {
  bodyLocalOnlyAtom,
  currentPageEditModeAtom,
  pageEditorAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import { DictationGroup } from "@/features/editor/components/fixed-toolbar/groups/dictation-group";
import { GenerateTitleGroup } from "@/features/editor/components/fixed-toolbar/groups/generate-title-group";

const MemoizedTitleEditor = React.memo(TitleEditor);
const MemoizedPageEditor = React.memo(PageEditor);
const MemoizedFixedToolbar = React.memo(FixedToolbar);
const MemoizedDeletedPageBanner = React.memo(DeletedPageBanner);
const MemoizedTemporaryNoteBanner = React.memo(TemporaryNoteBanner);

// Module-level flag: survives component unmount/remount on page navigation,
// reset only on full page reload (i.e. a new app session).
let defaultEditModeApplied = false;

// Max width of the non-fluid editor column. Single source of truth used for BOTH
// the Container `size` and the left-edge-pinning layout math below (#570).
const COL_MAX = 936;
// Gutter kept between the column's right edge and the aside panel when it opens.
const ASIDE_GAP = 16;

// Resolve Main's `--app-shell-aside-offset` (the px the open aside removes from
// Main's content box) to real px. We must NOT read the raw var with
// getComputedStyle + parseFloat: Mantine authors it as
// `calc(26.25rem * var(--mantine-scale))`, and getComputedStyle does NOT
// evaluate calc() for an unregistered custom property — it returns the literal
// string "calc(26.25rem * 1)", whose parseFloat is NaN → a silent 0 that makes
// the left-edge compensation a no-op on desktop-open. Instead we append a
// hidden probe whose width IS the variable and read its laid-out box, forcing
// the browser to evaluate calc/rem/scale for us. This yields ~420 on
// desktop-open and 0 when the aside reserves no space (closed, or the below-`md`
// overlay where Main is not narrowed). Browser-only: jsdom does no layout, so
// this path cannot be unit-tested — verified in real Chromium.
function resolveAsideOffsetPx(mainEl: HTMLElement): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;height:0;width:var(--app-shell-aside-offset);";
  mainEl.appendChild(probe);
  const px = probe.getBoundingClientRect().width; // laid-out, calc resolved
  mainEl.removeChild(probe);
  return Number.isFinite(px) ? px : 0;
}

export interface FullEditorProps {
  pageId: string;
  slugId: string;
  // Ф7 (#643) — loosened for the local-first mount on cached meta: the title may
  // be `null` (a titleless page) and the body `content` absent until the LIVE
  // `/pages/info` resolves (`content` comes ONLY from the live page — never the
  // possibly-previous `page` under keepPreviousData).
  title: string | null;
  content?: string;
  spaceSlug: string;
  editable: boolean;
  canComment?: boolean;
  // Ф7 (#643) — the live REST body has not resolved for THIS page yet
  // (`isLoading || !livePage`). Owns the body's SKELETON vs static/live decision
  // inside PageEditor, and gates the title-editor's canonicalizing navigate /
  // force-save. Absent ⇒ resolved.
  bodyContentPending?: boolean;
}

export function FullEditor({
  pageId,
  title,
  slugId,
  content,
  spaceSlug,
  editable,
  canComment,
  bodyContentPending,
}: FullEditorProps) {
  const { t } = useTranslation();
  const [user] = useAtom(userAtom);
  const workspace = useAtomValue(workspaceAtom);
  const isDictationEnabled = workspace?.settings?.ai?.dictation === true;
  // AI title generation is gated by the general AI chat flag (the same toggle
  // that enables the chat agent); the server enforces it too (#199).
  const isTitleGenEnabled = workspace?.settings?.ai?.chat === true;
  const fullPageWidth = user.settings?.preferences?.fullPageWidth;
  const { isAsideOpen } = useAtomValue(asideStateAtom);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorToolbarEnabled =
    user.settings?.preferences?.editorToolbar ?? false;
  const [currentPageEditMode, setCurrentPageEditMode] = useAtom(
    currentPageEditModeAtom,
  );
  // #564 — the body is showing an un-reconciled LOCAL copy while the collab room
  // is Disconnected. The banner sits above the title on purpose: chrome (title /
  // icon, from #563's page-meta boot cache) and body (from the ydoc) are
  // different points in time, so the whole page — chrome included — must be
  // marked stale.
  const { isOffline: isBodyOffline } = useAtomValue(bodyLocalOnlyAtom);
  const userPageEditMode =
    user.settings?.preferences?.pageEditMode ?? PageEditMode.Edit;
  const isEditMode = currentPageEditMode === PageEditMode.Edit;
  // Ф7 (#643) — the LIVE page resolved (drives the title-editor's navigate /
  // force-save gates). Absent prop ⇒ resolved.
  const pageResolved =
    bodyContentPending === undefined ? true : !bodyContentPending;

  // Apply the user's saved preference only once on initial load, not on every
  // page navigation — so the mode sticks across navigations within a session.
  useEffect(() => {
    if (!defaultEditModeApplied) {
      setCurrentPageEditMode(userPageEditMode as PageEditMode);
      defaultEditModeApplied = true;
    }
  }, [userPageEditMode, setCurrentPageEditMode]);

  // Pin the editor column's LEFT edge when the right aside opens (#570). Mantine
  // narrows AppShell.Main via `padding-inline-end` (not an animated width), so a
  // single synchronous re-measure in a layout effect is enough. In fluid mode we
  // hand control back to the CSS class and do nothing.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const clearInlineLayout = () => {
      el.style.marginInline = "";
      el.style.marginLeft = "";
      el.style.width = "";
      el.style.maxWidth = "";
    };

    if (fullPageWidth) {
      clearInlineLayout();
      return;
    }

    // Resolve Main by id and confirm it is an ancestor of the column. We do NOT
    // use `el.offsetParent`: in the default AppShell layout Main is statically
    // positioned, so offsetParent skips past it to the app-shell root.
    const mainEl = el.closest<HTMLElement>(`#${MAIN_CONTENT_ID}`);

    const recompute = () => {
      // Degrade to the current CSS centering when Main can't be measured — never
      // worse than today's behavior.
      if (!mainEl || mainEl.clientWidth === 0) {
        clearInlineLayout();
        return;
      }
      const cs = getComputedStyle(mainEl);
      // clientWidth is the padding box (INCLUDES padding-inline-end), so it does
      // NOT shrink when the aside opens — subtract the paddings to get the real
      // content-box width the column is centered within.
      const padInline =
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const W = mainEl.clientWidth - padInline;

      // Space the aside actually reserves in Main, resolved to real px via a
      // layout probe (see resolveAsideOffsetPx). The `isAsideOpen` guard just
      // skips the probe when closed; the probe would return 0 there anyway (as
      // it does for the below-`md` overlay, where Main is not narrowed).
      const asideOffset = isAsideOpen ? resolveAsideOffsetPx(mainEl) : 0;

      const { left, width } = computeColumnLayout(
        W,
        asideOffset,
        COL_MAX,
        ASIDE_GAP,
      );

      // Inline styles override the `.editor` class centering; vertical margin
      // (48px) still comes from the class. marginInline:0 first, then marginLeft.
      el.style.marginInline = "0";
      el.style.marginLeft = `${left}px`;
      el.style.width = `${width}px`;
      el.style.maxWidth = "none";
    };

    recompute();

    // Re-measure on any Main content-box change: window resize, left sidebar
    // toggle, and the aside open/close itself (padding-box content shrinks).
    let observer: ResizeObserver | undefined;
    if (mainEl && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => recompute());
      observer.observe(mainEl);
    }

    return () => {
      observer?.disconnect();
      // Restore CSS-class control before the next run / on unmount so switching
      // to fluid mode never leaves stale inline styles behind.
      clearInlineLayout();
    };
  }, [isAsideOpen, fullPageWidth]);

  return (
    <Container
      ref={containerRef}
      fluid={fullPageWidth}
      size={!fullPageWidth && COL_MAX}
      className={classes.editor}
    >
      {editorToolbarEnabled && editable && isEditMode && (
        <MemoizedFixedToolbar />
      )}
      {isBodyOffline && (
        <Alert
          role="status"
          aria-live="polite"
          variant="light"
          color="yellow"
          icon={<IconWifiOff size={18} />}
          mb="md"
          className="print-hide"
          data-testid="page-offline-banner"
        >
          {t(
            "You're offline — showing the last copy saved on this device. Editing is disabled until the connection is restored.",
          )}
        </Alert>
      )}
      <MemoizedDeletedPageBanner slugId={slugId} />
      <MemoizedTemporaryNoteBanner slugId={slugId} />
      <MemoizedTitleEditor
        pageId={pageId}
        slugId={slugId}
        title={title}
        spaceSlug={spaceSlug}
        editable={editable}
        pageResolved={pageResolved}
      />
      <PageWritingActions
        pageId={pageId}
        editable={editable}
        isEditMode={isEditMode}
        isDictationEnabled={isDictationEnabled}
        isTitleGenEnabled={isTitleGenEnabled}
      />
      <MemoizedPageEditor
        pageId={pageId}
        editable={editable}
        content={content}
        canComment={canComment}
        bodyContentPending={bodyContentPending ?? false}
      />
    </Container>
  );
}

type PageWritingActionsProps = {
  pageId: string;
  editable?: boolean;
  isEditMode?: boolean;
  isDictationEnabled?: boolean;
  isTitleGenEnabled?: boolean;
};

function PageWritingActions({
  pageId,
  editable,
  isEditMode,
  isDictationEnabled,
  isTitleGenEnabled,
}: PageWritingActionsProps) {
  const editor = useAtomValue(pageEditorAtom);
  const showDictation = Boolean(
    isDictationEnabled && editable && isEditMode && editor,
  );
  const showTitleGen = Boolean(
    isTitleGenEnabled && editable && isEditMode && editor,
  );

  if (!showDictation && !showTitleGen) return null;

  return (
    <Group
      gap={4}
      wrap="nowrap"
      mb="md"
      className={clsx("print-hide", classes.byline)}
    >
      {showDictation && editor && (
        <DictationGroup editor={editor} color="gray" iconSize={20} />
      )}
      {showTitleGen && (
        <GenerateTitleGroup pageId={pageId} color="gray" iconSize={20} />
      )}
    </Group>
  );
}
