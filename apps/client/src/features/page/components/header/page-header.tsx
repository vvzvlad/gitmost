import classes from "./page-header.module.css";
import PageHeaderMenu from "@/features/page/components/header/page-header-menu.tsx";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import SidebarToggle from "@/components/ui/sidebar-toggle-button";
import { desktopSidebarAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar";
import { Group, Tooltip } from "@mantine/core";
import Breadcrumb from "@/features/page/components/breadcrumbs/breadcrumb.tsx";

import { useParams } from "react-router-dom";
import { usePageMetaQuery } from "@/features/page/queries/page-query";
import { extractPageSlugId } from "@/lib";
import { CustomAvatar } from "@/components/ui/custom-avatar";

interface Props {
  readOnly?: boolean;
}
export default function PageHeader({ readOnly }: Props) {
  const { t } = useTranslation();
  const { pageSlug } = useParams();
  const pageId = extractPageSlugId(pageSlug);
  const { data } = usePageMetaQuery({ pageId });
  const page =
    data?.id === pageId || data?.slugId === pageId ? data : undefined;
  const contributors = page?.contributors?.length
    ? page.contributors
    : page?.creator
      ? [page.creator]
      : [];
  const sidebarOpen = useAtomValue(desktopSidebarAtom);
  const toggleSidebar = useToggleSidebar(desktopSidebarAtom);

  return (
    <div className={classes.header} data-page-header="true">
      <Group
        justify="space-between"
        h="100%"
        wrap="nowrap"
        className={classes.group}
      >
        <Group wrap="nowrap" gap="xs" className={classes.trail}>
          {!sidebarOpen && (
            <SidebarToggle
              visibleFrom="md"
              aria-label={t("Sidebar toggle")}
              onClick={toggleSidebar}
            />
          )}
          <Breadcrumb />
        </Group>

        <Group
          justify="flex-end"
          h="100%"
          wrap="nowrap"
          className={classes.actions}
        >
          <Group
            gap={6}
            wrap="nowrap"
            visibleFrom="sm"
            aria-label={t("Contributors")}
          >
            {contributors.slice(0, 3).map((person) => (
              <Tooltip key={person.id} label={person.name}>
                <span>
                  <CustomAvatar
                    name={person.name}
                    avatarUrl={person.avatarUrl}
                    size={30}
                  />
                </span>
              </Tooltip>
            ))}
          </Group>
          <PageHeaderMenu readOnly={readOnly} />
        </Group>
      </Group>
    </div>
  );
}
