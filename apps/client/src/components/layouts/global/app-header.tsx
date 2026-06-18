import {
  ActionIcon,
  Box,
  Group,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import classes from "./app-header.module.css";
import { BrandLogo } from "@/components/ui/brand-logo";
import TopMenu from "@/components/layouts/global/top-menu.tsx";
import { Link } from "react-router-dom";
import APP_ROUTE from "@/lib/app-route.ts";
import { useAtom, useSetAtom } from "jotai";
import {
  desktopSidebarAtom,
  mobileSidebarAtom,
} from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import { aiChatWindowOpenAtom } from "@/features/ai-chat/atoms/ai-chat-atom.ts";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts";
import SidebarToggle from "@/components/ui/sidebar-toggle-button.tsx";
import { useTranslation } from "react-i18next";
import {
  SearchControl,
  SearchMobileControl,
} from "@/features/search/components/search-control.tsx";
import {
  searchSpotlight,
} from "@/features/search/constants.ts";
import { NotificationPopover } from "@/features/notification/components/notification-popover.tsx";

const links = [
  { link: APP_ROUTE.HOME, label: "Home" },
];

export function AppHeader() {
  const { t } = useTranslation();
  const [mobileOpened] = useAtom(mobileSidebarAtom);
  const toggleMobile = useToggleSidebar(mobileSidebarAtom);

  const [desktopOpened] = useAtom(desktopSidebarAtom);
  const toggleDesktop = useToggleSidebar(desktopSidebarAtom);

  const [workspace] = useAtom(workspaceAtom);
  const setAiChatWindowOpen = useSetAtom(aiChatWindowOpenAtom);
  // AI chat entry point: only shown when the workspace enables it (A7 gate).
  const aiChatEnabled = workspace?.settings?.ai?.chat === true;

  const items = links.map((link) => (
    <Link key={link.label} to={link.link} className={classes.link}>
      {t(link.label)}
    </Link>
  ));

  return (
    <>
      <Group h="100%" px="md" justify="space-between" wrap={"nowrap"}>
        <Group wrap="nowrap">
          <Tooltip label={t("Sidebar toggle")}>
            <SidebarToggle
              aria-label={t("Sidebar toggle")}
              opened={mobileOpened}
              onClick={toggleMobile}
              hiddenFrom="sm"
              size="sm"
            />
          </Tooltip>

          <Tooltip label={t("Sidebar toggle")}>
            <SidebarToggle
              aria-label={t("Sidebar toggle")}
              opened={desktopOpened}
              onClick={toggleDesktop}
              visibleFrom="sm"
              size="sm"
            />
          </Tooltip>

          <Link to="/home" className={classes.brand} aria-label="Gitmost">
            <Box hiddenFrom="sm" className={classes.brandIcon}>
              <BrandLogo markOnly height={26} />
            </Box>
            <Box visibleFrom="sm" className={classes.brandIcon}>
              <BrandLogo height={30} />
            </Box>
          </Link>

          <Tooltip label={t("Version")}>
            <Text
              size="xs"
              c="dimmed"
              lh={1}
              ml="md"
              visibleFrom="sm"
              style={{ userSelect: "text", whiteSpace: "nowrap" }}
            >
              {APP_VERSION}
            </Text>
          </Tooltip>

          <Group ml="xl" gap={5} className={classes.links} visibleFrom="sm">
            {items}
          </Group>
        </Group>

        <div>
          <Group visibleFrom="sm">
            <SearchControl onClick={searchSpotlight.open} />
          </Group>
          <Group hiddenFrom="sm">
            <SearchMobileControl onSearch={searchSpotlight.open} />
          </Group>
        </div>

        <Group px={"xl"} wrap="nowrap">
          {aiChatEnabled && (
            <Tooltip label={t("AI chat")} withArrow>
              <ActionIcon
                variant="subtle"
                color="dark"
                size="sm"
                aria-label={t("AI chat")}
                onClick={() => setAiChatWindowOpen((v) => !v)}
              >
                <IconSparkles size={20} />
              </ActionIcon>
            </Tooltip>
          )}
          <NotificationPopover />
          <TopMenu />
        </Group>
      </Group>
    </>
  );
}
