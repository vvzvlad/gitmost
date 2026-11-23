import classes from "./page-header.module.css";
import {
  ActionIcon,
  Group,
  Menu,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowRight,
  IconArrowsHorizontal,
  IconClockHour4,
  IconDeviceFloppy,
  IconDots,
  IconEye,
  IconEyeOff,
  IconFileExport,
  IconHistory,
  IconLink,
  IconList,
  IconMarkdown,
  IconMessageCircle,
  IconCopy,
  IconExternalLink,
  IconPencil,
  IconPin,
  IconVersions,
  IconSettings,
  IconInfoCircle,
  IconPrinter,
  IconStar,
  IconStarFilled,
  IconTrash,
  IconWifiOff,
} from "@tabler/icons-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAsideTriggerProps } from "@/hooks/use-toggle-aside.tsx";
import { useAtom, useAtomValue } from "jotai";
import {
  historyAtoms,
  highlightChangesAtom,
} from "@/features/page-history/atoms/history-atoms.ts";
import { useDisclosure, useHotkeys } from "@mantine/hooks";
import { useClipboard } from "@/hooks/use-clipboard";
import { useParams } from "react-router-dom";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query";
import { useSetSpaceHome } from "@/features/space/queries/space-home-query";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability";
import { SpaceCaslAction, SpaceCaslSubject } from "@/features/space/permissions/permissions.type";
import { usePageMetaQuery } from "@/features/page/queries/page-query.ts";
import {
  useToggleTemporaryMutation,
  syncTemporaryExpiresInCache,
} from "@/features/page-embed/queries/page-embed-query.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { notifications } from "@mantine/notifications";
import { getAppUrl } from "@/lib/config.ts";
import { extractPageSlugId } from "@/lib";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation.ts";
import { PageWidthToggle } from "@/features/user/components/page-width-pref.tsx";
import { Trans, useTranslation } from "react-i18next";
import { ExportFormat } from "@/features/page/types/page.types";
import ExportModal from "@/components/common/export-modal";
import { convertProseMirrorToMarkdown } from "@docmost/prosemirror-markdown/browser";
import {
  collabProviderAtom,
  currentPageEditModeAtom,
  pageEditorAtom,
  yjsConnectionStatusAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import {
  SAVE_VERSION_MESSAGE_TYPE,
  saveVersionPending,
} from "@/features/page-history/version-messages.ts";
import { formattedDate } from "@/lib/time.ts";
import { PageEditMode } from "@/features/user/types/user.types";
import CopyPageModal from "@/features/page/components/copy-page-modal";
import { useSpacePin } from "@/features/page/atoms/space-pin-atom";
import MovePageModal from "@/features/page/components/move-page-modal.tsx";
import { useTimeAgo } from "@/hooks/use-time-ago.tsx";
import {
  useFavoriteIds,
  useAddFavoriteMutation,
  useRemoveFavoriteMutation,
} from "@/features/favorite/queries/favorite-query";
import {
  useWatchStatusQuery,
  useWatchPageMutation,
  useUnwatchPageMutation,
} from "@/features/page/queries/watcher-query";
import ShareModal from "@/features/share/components/share-modal.tsx";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";

interface PageHeaderMenuProps {
  readOnly?: boolean;
}
export default function PageHeaderMenu({ readOnly }: PageHeaderMenuProps) {
  const { t } = useTranslation();
  const { pageSlug } = useParams();
  const pageId = extractPageSlugId(pageSlug);
  const { data } = usePageMetaQuery({ pageId });
  const page =
    data?.slugId === pageId || data?.id === pageId ? data : undefined;
  // #563 — the header is now rendered from the boot cache BEFORE this query
  // resolves, so `page` is legitimately undefined on a reload. Nothing here may
  // dereference it unguarded; the edit-only entry points additionally require the
  // LIVE page (their mutations all need server-confirmed rights anyway).
  const isPageLoaded = !!page;
  const isDeleted = !!page?.deletedAt;
  const [workspace] = useAtom(workspaceAtom);
  const collabProvider = useAtomValue(collabProviderAtom);
  // Community public-sharing entry point (replaces the removed EE PageShareModal)
  const workspaceSharingDisabled =
    workspace?.settings?.sharing?.disabled === true;

  // #370 — explicit "save a version" (Cmd+S / Save button). One path for the
  // human; the server derives the tier from the signed actor. Readers can't save
  // (the button is hidden and the collab connection is read-only server-side).
  const handleSaveVersion = useCallback(() => {
    if (readOnly || !collabProvider) return;
    // Flag this client as the initiator so only it shows the confirmation toast;
    // a safety timeout clears it if no broadcast comes back (e.g. offline).
    saveVersionPending.current = true;
    window.setTimeout(() => {
      saveVersionPending.current = false;
    }, 5000);
    collabProvider.sendStateless(
      JSON.stringify({ type: SAVE_VERSION_MESSAGE_TYPE }),
    );
  }, [readOnly, collabProvider]);

  // mod+S must also block the browser's "Save page" dialog. `triggerOnContent-
  // Editable` + empty ignore-list so it fires while typing in the editor/title.
  useHotkeys(
    [["mod+S", handleSaveVersion, { preventDefault: true }]],
    [],
    true,
  );

  useHotkeys(
    [
      [
        "mod+F",
        () => {
          const event = new CustomEvent("openFindDialogFromEditor", {});
          document.dispatchEvent(event);
        },
      ],
      [
        "Escape",
        () => {
          const event = new CustomEvent("closeFindDialogFromEditor", {});
          document.dispatchEvent(event);
        },
        { preventDefault: false },
      ],
    ],
    [],
  );

  if (isDeleted) {
    return null;
  }

  return (
    <>
      <ConnectionWarning />

      {/* Hide the Share entry point for readers; the toggle inside is inert
          without edit permission, so gate it like other edit-only actions
          (issue #133) */}
      {isPageLoaded && !readOnly && !workspaceSharingDisabled && (
        <ShareModal readOnly={false} />
      )}

      <PageActionMenu
        key={pageSlug}
        readOnly={readOnly}
        onSaveVersion={handleSaveVersion}
      />
    </>
  );
}

interface PageActionMenuProps {
  readOnly?: boolean;
  onSaveVersion?: () => void;
}
function PageActionMenu({ readOnly, onSaveVersion }: PageActionMenuProps) {
  const { t } = useTranslation();
  const [, setHistoryModalOpen] = useAtom(historyAtoms);
  const [, setHighlightChanges] = useAtom(highlightChangesAtom);
  const [editMode, setEditMode] = useAtom(currentPageEditModeAtom);
  const commentsTriggerProps = useAsideTriggerProps("comments");
  const tocTriggerProps = useAsideTriggerProps("toc");
  const detailsTriggerProps = useAsideTriggerProps("details");
  const [copyOpened, { open: openCopy, close: closeCopy }] =
    useDisclosure(false);
  const clipboard = useClipboard({ timeout: 500 });
  const { pageSlug, spaceSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);
  const spaceAbility = useSpaceAbility(space?.membership?.permissions);
  const setSpaceHome = useSetSpaceHome(space);
  const pageId = extractPageSlugId(pageSlug);
  const { data } = usePageMetaQuery({ pageId });
  const page =
    data?.slugId === pageId || data?.id === pageId ? data : undefined;
  const { handleDelete } = useTreeMutation(page?.spaceId ?? "");
  const { pinnedId, togglePin, isPinPending } = useSpacePin(page?.spaceId);
  const [exportFormat, setExportFormat] = useState<ExportFormat | null>(null);
  const [
    movePageModalOpened,
    { open: openMovePageModal, close: closeMoveSpaceModal },
  ] = useDisclosure(false);
  const [pageEditor] = useAtom(pageEditorAtom);
  const pageUpdatedAt = useTimeAgo(page?.updatedAt);
  const favoriteIds = useFavoriteIds("page", page?.spaceId);
  const addFavoriteMutation = useAddFavoriteMutation();
  const removeFavoriteMutation = useRemoveFavoriteMutation();
  const isFavorited = page?.id ? favoriteIds.has(page.id) : false;
  const { data: watchStatus } = useWatchStatusQuery(page?.id);
  const watchPage = useWatchPageMutation();
  const unwatchPage = useUnwatchPageMutation();
  const toggleTemporary = useToggleTemporaryMutation();
  const isTemporary = !!page?.temporaryExpiresAt;

  const handleToggleTemporary = async () => {
    if (!page?.id) return;
    const next = !isTemporary;
    try {
      const res = await toggleTemporary.mutateAsync({
        pageId: page.id,
        temporary: next,
      });
      // Reflect the new deadline in the page cache (menu label + banner) AND in
      // the sidebar tree node so its clock marker updates immediately, no reload.
      syncTemporaryExpiresInCache(page, res.temporaryExpiresAt);
      notifications.show({
        message: next
          ? t("Note will move to trash unless made permanent")
          : t("Note is now permanent"),
      });
    } catch {
      // mutation surfaces the error via notifications
    }
  };

  const handleCopyLink = () => {
    const pageUrl =
      getAppUrl() + buildPageUrl(spaceSlug, page.slugId, page.title);

    clipboard.copy(pageUrl);
    notifications.show({ message: t("Link copied") });
  };

  const handleCopyAsMarkdown = () => {
    if (!pageEditor) return;
    // Copy the page as canonical markdown through the shared converter (issue
    // #347), so "Copy as markdown" matches the server export byte-for-byte.
    const markdown = convertProseMirrorToMarkdown(pageEditor.getJSON());
    const title = page?.title ? `# ${page.title}\n\n` : "";
    clipboard.copy(`${title}${markdown}`);
    notifications.show({ message: t("Copied") });
  };

  const handlePrint = () => {
    setTimeout(() => {
      window.print();
    }, 250);
  };

  const openHistoryModal = () => {
    setHistoryModalOpen(true);
  };

  const handleDeletePage = () => {
    handleDelete(page.id);
  };

  const handleToggleFavorite = () => {
    if (!page?.id) return;
    const params = { type: "page" as const, pageId: page.id };
    if (isFavorited) {
      removeFavoriteMutation.mutate(params);
    } else {
      addFavoriteMutation.mutate(params);
    }
  };

  // The chrome paints from the boot cache BEFORE this query resolves, so on a
  // reload `page` is undefined here while the header is already on screen.
  // Every item below needs the LIVE page (its id/slugId drive copy-link, export,
  // move, delete, watch…), and the boot cache deliberately carries no authority
  // to act. So render the trigger INERT until the response lands — never a throw
  // on the `page.id` / `page.lastUpdatedBy` reads below, and never an action that
  // could fire against a page we have not re-validated.
  if (!page) {
    return (
      <ActionIcon
        variant="subtle"
        color="dark"
        aria-label={t("Page actions")}
        disabled
      >
        <IconDots size={20} />
      </ActionIcon>
    );
  }

  return (
    <>
      <Menu
        shadow="xl"
        position="bottom-end"
        offset={8}
        width={246}
        classNames={{ dropdown: classes.dropdown }}
      >
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="dark"
            className={classes.actionTrigger}
            aria-label={t("Page actions")}
          >
            <IconDots size={20} />
          </ActionIcon>
        </Menu.Target>

        <Menu.Dropdown>
          {!readOnly && (
            <>
              <Menu.Item
                leftSection={<IconPencil size={18} />}
                onClick={() => {
                  setEditMode(PageEditMode.Edit);
                  if (editMode === PageEditMode.Edit)
                    pageEditor?.commands.focus();
                }}
              >
                {t("Edit")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconCopy size={18} />}
                onClick={openCopy}
              >
                {t("Make a copy")}
              </Menu.Item>
            </>
          )}
          <Menu.Item
            component="a"
            href={buildPageUrl(spaceSlug, page.slugId, page.title)}
            target="_blank"
            rel="noopener noreferrer"
            leftSection={<IconExternalLink size={18} />}
          >
            {t("Open in new tab")}
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconLink size={18} />}
            onClick={handleCopyLink}
          >
            {t("Copy link")}
          </Menu.Item>
          <Menu.Item
            leftSection={
              isFavorited ? (
                <IconStarFilled
                  size={16}
                  color="var(--mantine-color-yellow-5)"
                />
              ) : (
                <IconStar size={16} />
              )
            }
            onClick={handleToggleFavorite}
          >
            {isFavorited ? t("Remove from favorites") : t("Add to favorites")}
          </Menu.Item>

          <Menu.Item
            leftSection={<IconPin size={18} />}
            disabled={isPinPending}
            onClick={() => togglePin(page.id)}
          >
            {pinnedId === page.id ? t("Unpin from space") : t("Pin in space")}
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconHistory size={18} />}
            onClick={openHistoryModal}
          >
            {t("Version history")}
          </Menu.Item>
          <Menu.Item
            leftSection={<IconVersions size={18} />}
            onClick={() => {
              setHighlightChanges(true);
              openHistoryModal();
            }}
          >
            {t("Compare versions")}
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconPrinter size={18} />}
            onClick={handlePrint}
          >
            {t("Print")}
          </Menu.Item>
          <Menu.Sub>
            <Menu.Sub.Target>
              <Menu.Sub.Item leftSection={<IconFileExport size={18} />}>
                {t("Export")}
              </Menu.Sub.Item>
            </Menu.Sub.Target>
            <Menu.Sub.Dropdown>
              <Menu.Item onClick={() => setExportFormat(ExportFormat.Markdown)}>
                Markdown
              </Menu.Item>
              <Menu.Item onClick={() => setExportFormat(ExportFormat.HTML)}>
                HTML
              </Menu.Item>
              <Menu.Item onClick={() => setExportFormat(ExportFormat.DOCX)}>
                DOCX
              </Menu.Item>
              <Menu.Item onClick={() => setExportFormat(ExportFormat.PDF)}>
                PDF
              </Menu.Item>
            </Menu.Sub.Dropdown>
          </Menu.Sub>

          {!readOnly && (
            <>
              <Menu.Divider />
              <Menu.Item
                color={"red"}
                leftSection={<IconTrash size={16} />}
                onClick={handleDeletePage}
              >
                {t("Move to trash")}
              </Menu.Item>
            </>
          )}
          <Menu.Sub>
            <Menu.Sub.Target>
              <Menu.Sub.Item leftSection={<IconSettings size={18} />}>
                {t("More")}
              </Menu.Sub.Item>
            </Menu.Sub.Target>
            <Menu.Sub.Dropdown>
              {space?.id === page.spaceId && spaceAbility.can(SpaceCaslAction.Manage, SpaceCaslSubject.Settings) && (
                <Menu.Item
                  disabled={setSpaceHome.isPending}
                  onClick={() => setSpaceHome.mutate(space.settings?.homePageId === page.id ? null : page.id)}
                >
                  {space.settings?.homePageId === page.id ? t("Clear space home page") : t("Set as space home page")}
                </Menu.Item>
              )}

              <Menu.Item
                leftSection={<IconMessageCircle size={18} />}
                {...commentsTriggerProps}
              >
                {t("Comments")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconList size={18} />}
                {...tocTriggerProps}
              >
                {t("Table of contents")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconInfoCircle size={18} />}
                {...detailsTriggerProps}
              >
                {t("Details")}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconMarkdown size={18} />}
                onClick={handleCopyAsMarkdown}
              >
                {t("Copy as Markdown")}
              </Menu.Item>
              {watchStatus?.watching ? (
                <Menu.Item
                  leftSection={<IconEyeOff size={16} />}
                  onClick={() => unwatchPage.mutate(page.id)}
                >
                  {t("Stop watching")}
                </Menu.Item>
              ) : (
                <Menu.Item
                  leftSection={<IconEye size={16} />}
                  onClick={() => watchPage.mutate(page.id)}
                >
                  {t("Watch page")}
                </Menu.Item>
              )}

              <Menu.Item
                closeMenuOnClick={false}
                leftSection={<IconArrowsHorizontal size={18} />}
              >
                <PageWidthToggle label={t("Full width")} />
              </Menu.Item>
              {!readOnly && (
                <>
                  <Menu.Item
                    leftSection={<IconEye size={18} />}
                    onClick={() => setEditMode(PageEditMode.Read)}
                  >
                    {t("Read")}
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconDeviceFloppy size={18} />}
                    onClick={onSaveVersion}
                  >
                    {t("Save version")}
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconArrowRight size={18} />}
                    onClick={openMovePageModal}
                  >
                    {t("Move to space")}
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconClockHour4 size={18} />}
                    onClick={handleToggleTemporary}
                  >
                    {isTemporary ? t("Make permanent") : t("Make temporary")}
                  </Menu.Item>
                </>
              )}
              <Menu.Divider />
              <>
                <Group px="sm" wrap="nowrap" style={{ cursor: "pointer" }}>
                  <Tooltip
                    label={t("Edited by {{name}} {{time}}", {
                      name: page.lastUpdatedBy?.name,
                      time: pageUpdatedAt,
                    })}
                    position="left-start"
                  >
                    <div style={{ width: 210 }}>
                      <Text size="xs" c="dimmed" truncate="end">
                        {t("Word count: {{wordCount}}", {
                          wordCount:
                            pageEditor?.storage?.characterCount?.words(),
                        })}
                      </Text>

                      <Text size="xs" c="dimmed" lineClamp={1}>
                        <Trans
                          defaults="Created by: <b>{{creatorName}}</b>"
                          values={{ creatorName: page?.creator?.name }}
                          components={{ b: <Text span fw={500} /> }}
                        />
                      </Text>
                      <Text size="xs" c="dimmed" truncate="end">
                        {t("Created at: {{time}}", {
                          time: formattedDate(page.createdAt),
                        })}
                      </Text>
                    </div>
                  </Tooltip>
                </Group>
              </>
            </Menu.Sub.Dropdown>
          </Menu.Sub>
        </Menu.Dropdown>
      </Menu>

      {copyOpened && (
        <CopyPageModal
          pageId={page.id}
          currentSpaceSlug={spaceSlug}
          open
          onClose={closeCopy}
        />
      )}

      {exportFormat && (
        <ExportModal
          type="page"
          id={page.id}
          initialFormat={exportFormat}
          open
          onClose={() => setExportFormat(null)}
        />
      )}

      <MovePageModal
        pageId={page.id}
        slugId={page.slugId}
        currentSpaceSlug={spaceSlug}
        onClose={closeMoveSpaceModal}
        open={movePageModalOpened}
      />
    </>
  );
}

function ConnectionWarning() {
  const { t } = useTranslation();
  const yjsConnectionStatus = useAtomValue(yjsConnectionStatusAtom);
  const [showWarning, setShowWarning] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const isDisconnected = ["disconnected", "connecting"].includes(
      yjsConnectionStatus,
    );

    if (isDisconnected) {
      if (!timeoutRef.current) {
        timeoutRef.current = setTimeout(() => setShowWarning(true), 5000);
      }
    } else {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setShowWarning(false);
    }
  }, [yjsConnectionStatus]);

  // Cleanup only on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  if (!showWarning) return null;

  return (
    <Tooltip
      label={t("Real-time editor connection lost. Retrying...")}
      openDelay={250}
      withArrow
    >
      <ThemeIcon
        variant="default"
        c="red"
        role="status"
        aria-label={t("Real-time editor connection lost. Retrying...")}
        style={{ border: "none" }}
      >
        <IconWifiOff size={20} stroke={2} />
      </ThemeIcon>
    </Tooltip>
  );
}
