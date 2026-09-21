import React, { useEffect, useState } from "react";
import { Group, Text, ScrollArea, ActionIcon } from "@mantine/core";
import {
  IconUser,
  IconSettings,
  IconUsers,
  IconArrowLeft,
  IconUsersGroup,
  IconSpaces,
  IconBrush,
  IconWorld,
  IconSparkles,
  IconKey,
  IconPlug,
} from "@tabler/icons-react";
import { Link, useLocation } from "react-router-dom";
import classes from "./settings.module.css";
import { useTranslation } from "react-i18next";
import {
  prefetchGroups,
  prefetchShares,
  prefetchSpaces,
  prefetchWorkspaceMembers,
} from "@/components/settings/settings-queries.tsx";
import { mobileSidebarAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts";
import { useSettingsNavigation } from "@/hooks/use-settings-navigation";
import { useWorkspaceEntitlementsQuery } from "@/features/workspace/queries/workspace-query.ts";
import { useAtom } from "jotai";

type DataItem = {
  label: string;
  icon: React.ElementType;
  path: string;
};

type DataGroup = {
  heading: string;
  items: DataItem[];
};

// Build the sidebar groups. The personal MCP-servers item (#686) is only shown
// when the instance kill-switch (`mcpPersonalServersEnabled`) is on — the page
// otherwise renders a disabled state, so hiding the link here keeps it tidy.
function buildGroupedData(mcpPersonalEnabled: boolean): DataGroup[] {
  const accountItems: DataItem[] = [
    { label: "Profile", icon: IconUser, path: "/settings/account/profile" },
    {
      label: "Preferences",
      icon: IconBrush,
      path: "/settings/account/preferences",
    },
    {
      label: "API keys",
      icon: IconKey,
      path: "/settings/account/api-keys",
    },
  ];

  if (mcpPersonalEnabled) {
    accountItems.push({
      label: "My MCP servers",
      icon: IconPlug,
      path: "/settings/account/mcp-servers",
    });
  }

  return [
    {
      heading: "Account",
      items: accountItems,
    },
    {
      heading: "Workspace",
      items: [
        { label: "General", icon: IconSettings, path: "/settings/workspace" },
        { label: "AI", icon: IconSparkles, path: "/settings/ai" },
        { label: "Members", icon: IconUsers, path: "/settings/members" },
        { label: "Groups", icon: IconUsersGroup, path: "/settings/groups" },
        { label: "Spaces", icon: IconSpaces, path: "/settings/spaces" },
        { label: "Public sharing", icon: IconWorld, path: "/settings/sharing" },
      ],
    },
  ];
}

export default function SettingsSidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const [active, setActive] = useState(location.pathname);
  const { goBack } = useSettingsNavigation();
  const [mobileSidebarOpened] = useAtom(mobileSidebarAtom);
  const toggleMobileSidebar = useToggleSidebar(mobileSidebarAtom);
  const { data: entitlements } = useWorkspaceEntitlementsQuery();

  useEffect(() => {
    setActive(location.pathname);
  }, [location.pathname]);

  const groupedData = buildGroupedData(
    entitlements?.mcpPersonalServersEnabled ?? false,
  );

  const menuItems = groupedData.map((group) => {
    return (
      <div key={group.heading}>
        <Text c="dimmed" className={classes.linkHeader}>
          {t(group.heading)}
        </Text>
        {group.items.map((item) => {
          let prefetchHandler: any;
          switch (item.label) {
            case "Members":
              prefetchHandler = prefetchWorkspaceMembers;
              break;
            case "Spaces":
              prefetchHandler = prefetchSpaces;
              break;
            case "Groups":
              prefetchHandler = prefetchGroups;
              break;
            case "Public sharing":
              prefetchHandler = prefetchShares;
              break;
            default:
              break;
          }

          return (
            <Link
              onMouseEnter={prefetchHandler}
              className={classes.link}
              data-active={active.startsWith(item.path) || undefined}
              key={item.label}
              to={item.path}
              onClick={() => {
                if (mobileSidebarOpened) {
                  toggleMobileSidebar();
                }
              }}
            >
              <item.icon className={classes.linkIcon} stroke={2} />
              <span>{t(item.label)}</span>
            </Link>
          );
        })}
      </div>
    );
  });

  return (
    <div className={classes.navbar}>
      <Group className={classes.title} justify="flex-start">
        <ActionIcon
          onClick={() => {
            goBack();
            if (mobileSidebarOpened) {
              toggleMobileSidebar();
            }
          }}
          variant="transparent"
          c="gray"
          aria-label={t("Back")}
        >
          <IconArrowLeft stroke={2} />
        </ActionIcon>
        <Text fw={500}>{t("Settings")}</Text>
      </Group>

      <ScrollArea w="100%">{menuItems}</ScrollArea>
    </div>
  );
}
