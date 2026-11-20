import { ActionIcon, Group, Menu, Text, Tooltip } from "@mantine/core";
import {
  IconArrowDown,
  IconMessage,
  IconHome,
  IconChevronsDown,
  IconChevronsUp,
  IconDots,
  IconEye,
  IconEyeOff,
  IconFileExport,
  IconHourglass,
  IconPlus,
  IconPin,
  IconSettings,
  IconStar,
  IconStarFilled,
  IconTrash,
} from "@tabler/icons-react";
import {
  useSpaceWatchStatusQuery,
  useWatchSpaceMutation,
  useUnwatchSpaceMutation,
} from "@/features/space/queries/space-watcher-query.ts";
import classes from "./space-sidebar.module.css";
import React, { useRef } from "react";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation.ts";
import { Link, useParams } from "react-router-dom";
import { useDisclosure } from "@mantine/hooks";
import SpaceSettingsModal from "@/features/space/components/settings-modal.tsx";
import { useSetSpaceHome } from "@/features/space/queries/space-home-query";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import SpaceTree, {
  SpaceTreeApi,
} from "@/features/page/tree/components/space-tree.tsx";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability.ts";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type.ts";
import PageImportModal from "@/features/page/components/page-import-modal.tsx";
import { useTranslation } from "react-i18next";
import { useAtomValue } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
import { NotificationPopover } from "@/features/notification/components/notification-popover";
import { useOpenAiChatForCurrentPage } from "@/features/ai-chat/hooks/use-open-ai-chat";
import SidebarToggle from "@/components/ui/sidebar-toggle-button";
import { desktopSidebarAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar";
import { BrandLogo } from "@/components/ui/brand-logo";
import TopMenu from "@/components/layouts/global/top-menu.tsx";
import { SearchControl } from "@/features/search/components/search-control.tsx";
import { openSearchSpotlight } from "@/features/search/constants.ts";
import { useSpacePin } from "@/features/page/atoms/space-pin-atom";
import { usePageMetaQuery } from "@/features/page/queries/page-query";
import { buildPageUrl } from "@/features/page/page.utils";
import { SwitchSpace } from "./switch-space";
import ExportModal from "@/components/common/export-modal";
import {
  useFavoriteIds,
  useAddFavoriteMutation,
  useRemoveFavoriteMutation,
} from "@/features/favorite/queries/favorite-query";

export function SpaceSidebar() {
  const { t } = useTranslation();
  const [opened, { open: openSettings, close: closeSettings }] =
    useDisclosure(false);

  const { spaceSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);

  const { pinnedId } = useSpacePin(space?.id);
  const { data: pinnedPage } = usePageMetaQuery({ pageId: pinnedId });

  const spaceRules = space?.membership?.permissions;
  const spaceAbility = useSpaceAbility(spaceRules);
  const { handleCreate } = useTreeMutation(space?.id ?? "");
  const treeRef = useRef<SpaceTreeApi | null>(null);

  if (!space) {
    return <></>;
  }

  function handleCreatePage() {
    handleCreate(null);
  }

  function handleCreateTemporaryPage() {
    handleCreate(null, { temporary: true });
  }

  return (
    <>
      <div className={classes.navbar}>
        <div className={classes.brandRow}>
          <Link to="/home" className={classes.brand}>
            <BrandLogo height={34} className={classes.brandLogo} />
          </Link>
          <SidebarUtilities />
        </div>
        <Text
          size="sm"
          c="dimmed"
          component="div"
          className={classes.workspaceLabel}
        >
          {t("Workspace")}
        </Text>
        <TopMenu inSidebar className={classes.workspaceButton} />
        <SearchControl
          workspaceSearch
          className={classes.workspaceSearch}
          onClick={openSearchSpotlight}
        />

        <Link to="/home" className={classes.navigationLink}>
          <IconHome size={20} stroke={1.7} />
          {t("Home")}
        </Link>
        <SwitchSpace spaceId={space.id} spaceName={space.name}>
          <div className={classes.sectionPages}>
            <Group className={classes.pagesHeader} justify="space-between">
              <Group gap="xs">
                <SpaceMenu
                  spaceId={space.id}
                  canManagePages={spaceAbility.can(
                    SpaceCaslAction.Manage,
                    SpaceCaslSubject.Page,
                  )}
                  onSpaceSettings={openSettings}
                  treeRef={treeRef}
                />

                {spaceAbility.can(
                  SpaceCaslAction.Manage,
                  SpaceCaslSubject.Page,
                ) && (
                  <>
                    <Tooltip
                      label={t("Create page")}
                      withArrow
                      position="right"
                    >
                      <ActionIcon
                        variant="default"
                        size={18}
                        onClick={handleCreatePage}
                        aria-label={t("Create page")}
                      >
                        <IconPlus />
                      </ActionIcon>
                    </Tooltip>

                    {/* Standalone second button: a "temporary note" auto-moves to
                      trash after the workspace lifetime unless made permanent. */}
                    <Tooltip
                      label={t("New temporary note")}
                      withArrow
                      position="right"
                    >
                      <ActionIcon
                        variant="default"
                        size={18}
                        onClick={handleCreateTemporaryPage}
                        aria-label={t("New temporary note")}
                      >
                        <IconHourglass />
                      </ActionIcon>
                    </Tooltip>
                  </>
                )}
              </Group>
            </Group>

            <div className={classes.pages}>
              {pinnedPage?.id === pinnedId &&
                pinnedPage &&
                !pinnedPage.deletedAt &&
                pinnedPage.spaceId === space.id && (
                  <Link
                    to={buildPageUrl(
                      space.slug,
                      pinnedPage.slugId,
                      pinnedPage.title,
                    )}
                    className={classes.pinnedPage}
                  >
                    <IconPin size={17} />
                    <span>{pinnedPage.title || t("Untitled")}</span>
                  </Link>
                )}
              <SpaceTree
                ref={treeRef}
                rowHeight={36}
                spaceId={space.id}
                readOnly={spaceAbility.cannot(
                  SpaceCaslAction.Manage,
                  SpaceCaslSubject.Page,
                )}
              />
            </div>
          </div>
        </SwitchSpace>
      </div>

      <SpaceSettingsModal
        opened={opened}
        onClose={closeSettings}
        spaceId={space?.slug}
      />
    </>
  );
}

function SidebarUtilities() {
  const { t } = useTranslation();
  const workspace = useAtomValue(workspaceAtom);
  const toggleSidebar = useToggleSidebar(desktopSidebarAtom);
  const openAiChat = useOpenAiChatForCurrentPage();

  return (
    <Group visibleFrom="md" gap={2} wrap="nowrap" className={classes.utilities}>
      {workspace?.settings?.ai?.chat === true && (
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label={t("AI chat")}
          onClick={openAiChat}
        >
          <IconMessage size={18} />
        </ActionIcon>
      )}
      <NotificationPopover />
      <SidebarToggle
        opened
        aria-label={t("Sidebar toggle")}
        onClick={toggleSidebar}
      />
    </Group>
  );
}

interface SpaceMenuProps {
  spaceId: string;
  canManagePages: boolean;
  onSpaceSettings: () => void;
  treeRef: React.RefObject<SpaceTreeApi | null>;
}
function SpaceMenu({
  spaceId,
  canManagePages,
  onSpaceSettings,
  treeRef,
}: SpaceMenuProps) {
  const { t } = useTranslation();
  const handleExpandAll = () => {
    // Fire-and-forget: expandAll already surfaces its own error notification.
    // The menu closes on click (consistent with Collapse all), so there is no
    // in-menu loading state to track here.
    treeRef.current?.expandAll();
  };

  const handleCollapseAll = () => {
    treeRef.current?.collapseAll();
  };
  const { spaceSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);
  const ability = useSpaceAbility(space?.membership?.permissions);
  const setSpaceHome = useSetSpaceHome(space);

  const [importOpened, { open: openImportModal, close: closeImportModal }] =
    useDisclosure(false);
  const [exportOpened, { open: openExportModal, close: closeExportModal }] =
    useDisclosure(false);

  const { data: watchStatus } = useSpaceWatchStatusQuery(spaceId);
  const watchMutation = useWatchSpaceMutation();
  const unwatchMutation = useUnwatchSpaceMutation();
  const isWatching = watchStatus?.watching ?? false;

  const favoriteIds = useFavoriteIds("space");
  const addFavoriteMutation = useAddFavoriteMutation();
  const removeFavoriteMutation = useRemoveFavoriteMutation();
  const isFavorited = favoriteIds.has(spaceId);

  const handleToggleFavorite = () => {
    const params = { type: "space" as const, spaceId };
    if (isFavorited) {
      removeFavoriteMutation.mutate(params);
    } else {
      addFavoriteMutation.mutate(params);
    }
  };

  const handleToggleWatch = () => {
    if (isWatching) {
      unwatchMutation.mutate(spaceId);
    } else {
      watchMutation.mutate(spaceId);
    }
  };

  return (
    <>
      <Menu width={200} shadow="md" withArrow>
        <Menu.Target>
          <Tooltip label={t("Space menu")} withArrow position="top">
            <ActionIcon
              variant="default"
              size={18}
              aria-label={t("Space menu")}
            >
              <IconDots />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Item component={Link} to={`/s/${encodeURIComponent(spaceSlug)}?overview=1`} leftSection={<IconHome size={16} />}>
            {t("Space overview")}
          </Menu.Item>

          {space?.settings?.homePageId && ability.can(SpaceCaslAction.Manage, SpaceCaslSubject.Settings) && (
            <Menu.Item disabled={setSpaceHome.isPending} onClick={() => setSpaceHome.mutate(null)}>
              {t("Clear space home page")}
            </Menu.Item>
          )}
          <Menu.Item
            onClick={handleExpandAll}
            leftSection={<IconChevronsDown size={16} />}
          >
            {t("Expand all")}
          </Menu.Item>

          <Menu.Item
            onClick={handleCollapseAll}
            leftSection={<IconChevronsUp size={16} />}
          >
            {t("Collapse all")}
          </Menu.Item>

          <Menu.Divider />

          <Menu.Item
            onClick={handleToggleFavorite}
            leftSection={
              isFavorited ? (
                <IconStarFilled
                  size={16}
                  color="var(--mantine-color-yellow-filled)"
                />
              ) : (
                <IconStar size={16} />
              )
            }
          >
            {isFavorited ? t("Remove from favorites") : t("Add to favorites")}
          </Menu.Item>

          <Menu.Item
            onClick={handleToggleWatch}
            leftSection={
              isWatching ? <IconEyeOff size={16} /> : <IconEye size={16} />
            }
          >
            {isWatching ? t("Stop watching space") : t("Watch space")}
          </Menu.Item>

          {canManagePages && (
            <>
              <Menu.Divider />

              <Menu.Item
                onClick={openImportModal}
                leftSection={<IconArrowDown size={16} />}
              >
                {t("Import pages")}
              </Menu.Item>

              <Menu.Item
                onClick={openExportModal}
                leftSection={<IconFileExport size={16} />}
              >
                {t("Export space")}
              </Menu.Item>

              <Menu.Divider />

              <Menu.Item
                onClick={onSpaceSettings}
                leftSection={<IconSettings size={16} />}
              >
                {t("Space settings")}
              </Menu.Item>

              <Menu.Item
                component={Link}
                to={`/s/${spaceSlug}/trash`}
                leftSection={<IconTrash size={16} />}
              >
                {t("Trash")}
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>

      {canManagePages && (
        <>
          <PageImportModal
            spaceId={spaceId}
            open={importOpened}
            onClose={closeImportModal}
          />

          <ExportModal
            type="space"
            id={spaceId}
            open={exportOpened}
            onClose={closeExportModal}
          />
        </>
      )}
    </>
  );
}
