import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  matchPath,
  Params,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  autoUpdate,
  computePosition,
  flip,
  hide,
  offset,
  shift,
} from "@floating-ui/dom";
import {
  IconFileDescription,
  IconCopy,
  IconExternalLink,
  IconLinkOff,
  IconPencil,
  IconWorld,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import {
  Divider,
  getDefaultZIndex,
  Group,
  Paper,
  Text,
  TextInput,
  ActionIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import classes from "./link.module.css";
import { useTranslation } from "react-i18next";
import { INTERNAL_LINK_REGEX } from "@/lib/constants";
import { LinkEditorPanel } from "@/features/editor/components/link/link-editor-panel.tsx";
import { usePageMetaQuery } from "@/features/page/queries/page-query.ts";
import { useSharePageQuery } from "@/features/share/queries/share-query.ts";
import { buildSharedPageUrl } from "@/features/page/page.utils.ts";
import { extractPageSlugId } from "@/lib";
// Client-local helpers, not @docmost/editor-ext: this host is mounted on every
// route, and the editor-ext barrel would pull the whole TipTap engine into the
// startup graph.
import { sanitizeUrl } from "@/lib/sanitize-url";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { normalizeUrl } from "@/lib/utils";
import { EDITOR_AUTO_UPDATE_OPTIONS } from "@/features/editor/utils/floating-auto-update";
import {
  LINK_CLICK_EVENT,
  LinkClickDetail,
} from "@/features/editor/components/link/link-click-event.ts";

// The host is mounted outside <Routes>, so useParams() is empty here; the
// route params are matched from the pathname instead.
const ROUTE_PATTERNS = [
  "/share/:shareId/p/:pageSlug",
  "/share/p/:pageSlug",
  "/s/:spaceSlug/p/:pageSlug",
];

const parseInternalLink = (
  href: string,
  internalAttr?: boolean,
): { isInternal: boolean; slugId: string | null; label: string } => {
  if (!href) return { isInternal: !!internalAttr, slugId: null, label: "" };

  const match = INTERNAL_LINK_REGEX.exec(href);
  if (!match) {
    if (internalAttr) return { isInternal: true, slugId: null, label: href };
    return { isInternal: false, slugId: null, label: href };
  }

  const isExternal = match[2] && match[2] !== window.location.host;
  const slug = match[5];
  const slugId = extractPageSlugId(slug);
  const namePart = slug.split("-").slice(0, -1).join("-");

  return {
    isInternal: !isExternal,
    slugId,
    label: namePart || slug,
  };
};

type NavigateToLink = (
  href: string,
  internal: boolean,
  pageTitle?: string,
) => void;

type LinkPopoverProps = {
  link: LinkClickDetail;
  isShareRoute: boolean;
  shareId: string | undefined;
  spaceSlug: string | undefined;
  onNavigate: NavigateToLink;
  onClose: () => void;
};

function LinkPopover({
  link,
  isShareRoute,
  shareId,
  spaceSlug,
  onNavigate,
  onClose,
}: LinkPopoverProps) {
  const { editor, anchor, href } = link;
  const { t } = useTranslation();

  const [popoverState, setPopoverState] = useState<"preview" | "edit">(
    "preview",
  );
  const [linkTitle, setLinkTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const {
    isInternal,
    slugId,
    label: linkLabel,
  } = parseInternalLink(href, link.internal);

  const { data: linkedPage } = usePageMetaQuery({
    pageId: slugId && !isShareRoute ? slugId : null,
  });

  const { data: sharedPageData } = useSharePageQuery({
    pageId: slugId && isShareRoute ? slugId : null,
  });

  const pageTitle = isShareRoute
    ? sharedPageData?.page?.title
    : linkedPage?.title;

  const pendingTitleRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const getLinkPos = useCallback((): number | null => {
    try {
      return editor.view.posAtDOM(anchor, 0);
    } catch {
      return null;
    }
  }, [editor, anchor]);

  const handleUpdateLinkTitle = useCallback(
    (newTitle: string) => {
      if (!newTitle) return;

      const pos = getLinkPos();
      if (pos === null) return;

      const { state } = editor;
      const resolved = state.doc.resolve(pos);
      const node = resolved.nodeAfter;
      if (!node?.isText) return;

      const linkMark = node.marks.find(
        (m) => m.type.name === "link" && m.attrs.href === href,
      );
      if (!linkMark || node.text === newTitle) return;

      const from = pos;
      const to = pos + node.nodeSize;
      const { tr } = state;
      tr.insertText(newTitle, from, to);
      tr.addMark(from, from + newTitle.length, linkMark);
      editor.view.dispatch(tr);
    },
    [editor, href, getLinkPos],
  );

  const handleEditLink = useCallback(
    (url: string, internal?: boolean) => {
      const normalizedUrl = internal ? url : normalizeUrl(url);

      const pos = getLinkPos();
      if (pos === null) {
        onClose();
        return;
      }

      const { state } = editor;
      const resolved = state.doc.resolve(pos);
      const node = resolved.nodeAfter;
      if (!node?.isText) {
        onClose();
        return;
      }

      const linkMark = node.marks.find(
        (m) => m.type.name === "link" && m.attrs.href === href,
      );
      if (linkMark) {
        const from = pos;
        const to = pos + node.nodeSize;
        const { tr } = state;
        tr.removeMark(from, to, linkMark.type);
        tr.addMark(
          from,
          to,
          linkMark.type.create({ href: normalizedUrl, internal: !!internal }),
        );
        editor.view.dispatch(tr);
      }

      onClose();
    },
    [editor, href, getLinkPos, onClose],
  );

  const handleOpenEdit = () => {
    setLinkTitle(anchor.textContent || "");
    setLinkUrl(href);
    pendingTitleRef.current = null;
    setShowSearch(false);
    setPopoverState("edit");
    requestAnimationFrame(() => titleInputRef.current?.focus());
  };

  // Commit a title that was typed but not yet saved when the popover closes.
  useEffect(() => {
    return () => {
      if (pendingTitleRef.current !== null) {
        handleUpdateLinkTitle(pendingTitleRef.current);
        pendingTitleRef.current = null;
      }
    };
  }, []);

  // Layout effect: the first position lands before paint, so the popover never
  // flashes at its initial top-left placement.
  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!popup) return;

    const update = () => {
      if (!anchor.isConnected) {
        onClose();
        return;
      }
      computePosition(anchor, popup, {
        placement: "bottom",
        middleware: [offset(8), flip(), shift({ padding: 8 }), hide()],
      }).then(({ x, y, middlewareData }) => {
        popup.style.left = `${x}px`;
        popup.style.top = `${y}px`;
        // Hide while the link is scrolled out of a clipping container, as the
        // Mantine Popover did (hideDetached).
        popup.style.visibility = middlewareData.hide?.referenceHidden
          ? "hidden"
          : "visible";
      });
    };

    // `layoutShift: false` — see EDITOR_AUTO_UPDATE_OPTIONS (Safari CPU burn).
    return autoUpdate(anchor, popup, update, EDITOR_AUTO_UPDATE_OPTIONS);
  }, [anchor, onClose]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchor.contains(target) || popupRef.current?.contains(target)) {
        return;
      }
      // Blur the focused input while it is still mounted so its onBlur commits
      // a pending URL/title edit; unmounting a focused input fires no usable
      // blur, so the edit would otherwise be lost.
      const active = document.activeElement;
      if (active instanceof HTMLElement && popupRef.current?.contains(active)) {
        active.blur();
      }
      onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside, true);
    document.addEventListener("keydown", handleEscape, true);
    editor.on("destroy", onClose);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside, true);
      document.removeEventListener("keydown", handleEscape, true);
      editor.off("destroy", onClose);
    };
  }, [anchor, editor, onClose]);

  const handleNavigate = useCallback(() => {
    onNavigate(href, link.internal, pageTitle);
  }, [onNavigate, href, link.internal, pageTitle]);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const fullUrl = sanitizeUrl(
      isInternal ? `${window.location.origin}${href}` : href,
    );
    void copyToClipboard(fullUrl);
    notifications.show({
      message: t("Link copied"),
    });
    onClose();
  };

  const handleRemoveLink = useCallback(() => {
    const pos = getLinkPos();
    if (pos !== null) {
      editor
        .chain()
        .focus()
        .setTextSelection(pos)
        .extendMarkRange("link")
        .unsetLink()
        .run();
    }
    onClose();
  }, [editor, getLinkPos, onClose]);

  const displayHref = sanitizeUrl(
    isInternal
      ? isShareRoute && slugId
        ? buildSharedPageUrl({ shareId, pageSlugId: slugId, pageTitle })
        : href
      : normalizeUrl(href),
  );

  const linkTitleInput = (
    <>
      <Text size="xs" fw={600} c="dimmed" mt="sm" mb={4}>
        {t("Link title")}
      </Text>
      <TextInput
        ref={titleInputRef}
        classNames={{ input: classes.linkInput }}
        value={linkTitle}
        onChange={(e) => {
          const val = e.currentTarget.value;
          setLinkTitle(val);
          pendingTitleRef.current = val;
          if (val) {
            const walker = document.createTreeWalker(
              anchor,
              NodeFilter.SHOW_TEXT,
            );
            const textNode = walker.nextNode();
            if (textNode) {
              const view = editor.view as any;
              view.domObserver.stop();
              textNode.nodeValue = val;
              view.domObserver.start();
            }
          }
        }}
        onBlur={() => {
          if (pendingTitleRef.current !== null) {
            handleUpdateLinkTitle(pendingTitleRef.current);
            pendingTitleRef.current = null;
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleUpdateLinkTitle(linkTitle);
            pendingTitleRef.current = null;
            onClose();
          }
        }}
        size="sm"
      />
    </>
  );

  return createPortal(
    <Paper
      ref={popupRef}
      shadow="md"
      withBorder
      w={popoverState === "edit" ? 320 : undefined}
      p={popoverState === "edit" ? "sm" : 6}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        zIndex: getDefaultZIndex("popover"),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {popoverState === "edit" ? (
        <>
          <Text size="xs" fw={600} c="dimmed" mb={4}>
            {t("Page or URL")}
          </Text>

          {isInternal ? (
            !showSearch ? (
              <>
                <UnstyledButton
                  className={classes.linkChip}
                  onClick={() => setShowSearch(true)}
                >
                  <IconFileDescription
                    size={16}
                    stroke={1.5}
                    color="var(--mantine-color-dimmed)"
                    style={{ flexShrink: 0 }}
                  />
                  <Text size="sm" fw={500} truncate>
                    {pageTitle || linkTitle}
                  </Text>
                </UnstyledButton>

                {linkTitleInput}

                <Divider my="xs" />

                <UnstyledButton
                  onClick={handleRemoveLink}
                  className={classes.removeLink}
                >
                  <Group gap={8}>
                    <IconLinkOff size={16} stroke={1.5} />
                    <Text size="sm">{t("Remove link")}</Text>
                  </Group>
                </UnstyledButton>
              </>
            ) : (
              <LinkEditorPanel
                onSetLink={handleEditLink}
                onUnsetLink={handleRemoveLink}
                spaceSlug={spaceSlug}
              />
            )
          ) : (
            <>
              <TextInput
                leftSection={
                  <IconWorld
                    size={16}
                    stroke={1.5}
                    color="var(--mantine-color-dimmed)"
                  />
                }
                classNames={{ input: classes.linkInput }}
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.currentTarget.value)}
                onBlur={() => {
                  if (linkUrl && linkUrl !== href) {
                    handleEditLink(linkUrl, false);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (linkUrl && linkUrl !== href) {
                      handleEditLink(linkUrl, false);
                    }
                  }
                }}
                size="sm"
              />

              {linkTitleInput}

              <Divider my="xs" />

              <UnstyledButton
                onClick={handleRemoveLink}
                className={classes.removeLink}
              >
                <Group gap={8}>
                  <IconLinkOff size={16} stroke={1.5} />
                  <Text size="sm">{t("Remove link")}</Text>
                </Group>
              </UnstyledButton>
            </>
          )}
        </>
      ) : (
        <Group gap={4} wrap="nowrap">
          <Group
            component="a"
            //@ts-ignore
            href={displayHref}
            target={isInternal ? undefined : "_blank"}
            rel={isInternal ? undefined : "noopener noreferrer"}
            gap={6}
            wrap="nowrap"
            style={{
              cursor: "pointer",
              maxWidth: 250,
              textDecoration: "none",
              color: "inherit",
              userSelect: "none",
            }}
            onClick={(e: React.MouseEvent) => {
              e.preventDefault();
              handleNavigate();
            }}
          >
            {isInternal ? (
              <IconFileDescription size={18} color="gray" />
            ) : (
              <IconExternalLink size={18} color="gray" />
            )}
            <Text size="sm" truncate fw={500}>
              {isInternal ? pageTitle || linkLabel : href}
            </Text>
          </Group>

          <Divider orientation="vertical" />

          <Tooltip label={t("Edit link")} withArrow withinPortal={false}>
            <ActionIcon
              variant="subtle"
              color="gray"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleOpenEdit();
              }}
            >
              <IconPencil size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label={t("Copy link")} withArrow withinPortal={false}>
            <ActionIcon
              variant="subtle"
              color="gray"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleCopy(e);
              }}
            >
              <IconCopy size={18} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label={t("Remove link")} withArrow withinPortal={false}>
            <ActionIcon
              variant="subtle"
              color="gray"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleRemoveLink();
              }}
            >
              <IconLinkOff size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
    </Paper>,
    document.body,
  );
}

export default function LinkClickHost() {
  const navigate = useNavigate();
  const location = useLocation();
  const isShareRoute = location.pathname.startsWith("/share");
  const { shareId, pageSlug, spaceSlug } = useMemo((): Params => {
    for (const pattern of ROUTE_PATTERNS) {
      const match = matchPath(pattern, location.pathname);
      if (match) return match.params;
    }
    return {};
  }, [location.pathname]);

  const [active, setActive] = useState<{
    id: number;
    link: LinkClickDetail;
    pathname: string;
  } | null>(null);
  const clickCountRef = useRef(0);
  const close = useCallback(() => setActive(null), []);

  const navigateToLink = useCallback<NavigateToLink>(
    (href, internal, pageTitle) => {
      if (!href) return;

      const { isInternal, slugId } = parseInternalLink(href, internal);

      if (isInternal) {
        let targetPath = href;
        let anchor = "";

        try {
          const url = new URL(href);
          targetPath = url.pathname;
          anchor = url.hash.slice(1);
        } catch {
          if (href.includes("#")) {
            [targetPath, anchor] = href.split("#");
          }
        }

        if (anchor) {
          const currentPageSlugId = extractPageSlugId(pageSlug);
          if (!slugId || currentPageSlugId === slugId) {
            const element =
              document.querySelector(`[id="${anchor}"]`) ||
              document.querySelector(`[data-id="${anchor}"]`);
            if (element) {
              element.scrollIntoView({ behavior: "smooth", block: "start" });
              navigate(`${location.pathname}#${anchor}`, { replace: true });
              return;
            }
          }
        }

        if (isShareRoute && slugId) {
          const sharedUrl = buildSharedPageUrl({
            shareId,
            pageSlugId: slugId,
            pageTitle: pageTitle,
            anchorId: anchor || undefined,
          });
          navigate(sharedUrl);
        } else {
          navigate(anchor ? `${targetPath}#${anchor}` : targetPath);
        }
      } else {
        window.open(
          sanitizeUrl(normalizeUrl(href)),
          "_blank",
          "noopener,noreferrer",
        );
      }
    },
    [navigate, location.pathname, isShareRoute, shareId, pageSlug],
  );

  useEffect(() => {
    const handleLinkClick = (event: Event) => {
      const link = (event as CustomEvent<LinkClickDetail>).detail;
      if (!link.editor.isEditable) {
        navigateToLink(link.href, link.internal);
        return;
      }
      // A new id per click remounts the popover, so a click on another link
      // (or the same one again) starts from a fresh preview.
      clickCountRef.current += 1;
      setActive({
        id: clickCountRef.current,
        link,
        pathname: location.pathname,
      });
    };
    document.addEventListener(LINK_CLICK_EVENT, handleLinkClick);
    return () => {
      document.removeEventListener(LINK_CLICK_EVENT, handleLinkClick);
    };
  }, [navigateToLink, location.pathname]);

  // Close on route change.
  if (active && active.pathname !== location.pathname) {
    setActive(null);
  }

  if (!active) return null;

  return (
    <LinkPopover
      key={active.id}
      link={active.link}
      isShareRoute={isShareRoute}
      shareId={shareId}
      spaceSlug={spaceSlug}
      onNavigate={navigateToLink}
      onClose={close}
    />
  );
}
