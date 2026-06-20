import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowsMaximize,
  IconDots,
  IconExternalLink,
  IconEyeOff,
  IconInfoCircle,
  IconRefresh,
  IconRepeat,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ErrorBoundary } from "react-error-boundary";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import classes from "../transclusion/transclusion.module.css";
import { usePageEmbedLookup } from "./page-embed-lookup-context";
import {
  PageEmbedAncestryProvider,
  usePageEmbedAncestry,
} from "./page-embed-ancestry-context";
import { decideEmbedState } from "./decide-embed-state";
import PageEmbedContent from "./page-embed-content";

function Placeholder({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className={classes.placeholder}>
      <span className={classes.placeholderIcon}>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

export default function PageEmbedView(props: NodeViewProps) {
  const isEditable = props.editor.isEditable;
  const sourcePageId: string | null = props.node.attrs.sourcePageId ?? null;
  const [openMenus, setOpenMenus] = useState(0);
  const trackOpen = (open: boolean) =>
    setOpenMenus((n) => Math.max(0, n + (open ? 1 : -1)));

  return (
    <NodeViewWrapper
      className={classes.includeWrap}
      data-editable={isEditable ? "true" : "false"}
      data-focused={isEditable && props.selected ? "true" : "false"}
      data-menu-open={openMenus > 0 ? "true" : "false"}
      contentEditable={false}
    >
      <ErrorBoundary
        resetKeys={[sourcePageId]}
        onError={(err) =>
          // Never swallow: log the full error with the offending source id.
          console.error("[pageEmbed] render error", { sourcePageId, err })
        }
        fallback={
          <Placeholder
            icon={<IconAlertTriangle size={18} stroke={1.6} />}
            label="Failed to load this embedded page"
          />
        }
      >
        <PageEmbedBody {...props} trackOpen={trackOpen} />
      </ErrorBoundary>
    </NodeViewWrapper>
  );
}

function PageEmbedBody({
  editor,
  node,
  deleteNode,
  trackOpen,
}: NodeViewProps & { trackOpen: (open: boolean) => void }) {
  const { t } = useTranslation();
  const sourcePageId: string | null = node.attrs.sourcePageId ?? null;
  const isEditable = editor.isEditable;
  const ancestry = usePageEmbedAncestry();

  // @ts-ignore - editor.storage.pageId is set by the host editor
  const hostPageId: string | undefined = editor.storage?.pageId;

  const { result, refresh, available } = usePageEmbedLookup(sourcePageId);
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  // --- Cycle / depth / availability decision (pure, unit-tested) ------------
  // Evaluated before any nested editor is rendered.
  const embedState = decideEmbedState({
    sourcePageId,
    chain: ancestry.chain,
    hostPageId: ancestry.hostPageId,
    available,
    result,
  });

  const sourceTitle =
    result && !("status" in result) ? result.title : null;
  const sourceIcon = result && !("status" in result) ? result.icon : null;
  // The app routes pages by slugId, not the raw UUID. Build the link from the
  // resolved slugId (the `/p/:pageSlug` route redirects to the full URL).
  const sourceSlugId =
    result && !("status" in result) ? result.slugId : null;
  const sourceHref = sourceSlugId
    ? buildPageUrl(undefined, sourceSlugId, sourceTitle ?? undefined)
    : null;

  const controls = isEditable ? (
    <div
      className={classes.includeControls}
      contentEditable={false}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Tooltip label={t("Refresh")}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={handleRefresh}
          loading={refreshing}
          disabled={!sourcePageId}
        >
          <IconRefresh size={14} />
        </ActionIcon>
      </Tooltip>
      {sourceHref && (
        <Tooltip label={t("Open source page")}>
          <ActionIcon
            component={Link}
            to={sourceHref}
            variant="subtle"
            color="gray"
            size="sm"
            style={{ textDecoration: "none", borderBottom: "none" }}
          >
            <IconExternalLink size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      <Menu position="bottom-end" withinPortal onChange={trackOpen}>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" size="sm">
            <IconDots size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => deleteNode()}
          >
            {t("Remove from page")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  ) : null;

  const header =
    sourceTitle || sourceIcon ? (
      <div className={classes.transclusionBadge}>
        {sourceIcon ? `${sourceIcon} ` : <IconArrowsMaximize size={12} />}
        {sourceHref ? (
          <Link
            to={sourceHref}
            style={{ borderBottom: "none", textDecoration: "none" }}
          >
            {sourceTitle || t("Untitled")}
          </Link>
        ) : (
          sourceTitle || t("Untitled")
        )}
      </div>
    ) : null;

  let body: React.ReactNode;
  if (embedState === "no_source") {
    body = (
      <Placeholder
        icon={<IconInfoCircle size={18} stroke={1.6} />}
        label={t("No page selected")}
      />
    );
  } else if (embedState === "cycle") {
    body = (
      <Placeholder
        icon={<IconRepeat size={18} stroke={1.6} />}
        label={t("Circular embed: this page is already shown above")}
      />
    );
  } else if (embedState === "too_deep") {
    body = (
      <Placeholder
        icon={<IconRepeat size={18} stroke={1.6} />}
        label={t("Embed nesting limit reached")}
      />
    );
  } else if (embedState === "unavailable") {
    // No lookup context (e.g. public share) → placeholder, no fetch in MVP.
    body = (
      <Placeholder
        icon={<IconEyeOff size={18} stroke={1.6} />}
        label={t("Embedded page is not available here")}
      />
    );
  } else if (embedState === "loading") {
    body = <div style={{ minHeight: 24 }} />;
  } else if (embedState === "ok" && result && !("status" in result)) {
    body = (
      <PageEmbedAncestryProvider
        sourcePageId={sourcePageId}
        hostPageId={hostPageId}
      >
        <PageEmbedContent content={result.content} />
      </PageEmbedAncestryProvider>
    );
  } else if (embedState === "no_access") {
    body = (
      <Placeholder
        icon={<IconEyeOff size={18} stroke={1.6} />}
        label={t("You don't have access to this page")}
      />
    );
  } else {
    body = (
      <Placeholder
        icon={<IconInfoCircle size={18} stroke={1.6} />}
        label={t("The embedded page no longer exists")}
      />
    );
  }

  return (
    <>
      {controls}
      {header}
      {body}
    </>
  );
}
