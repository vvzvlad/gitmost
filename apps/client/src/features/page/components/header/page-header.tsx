import classes from "./page-header.module.css";
import PageHeaderMenu from "@/features/page/components/header/page-header-menu.tsx";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import SidebarToggle from "@/components/ui/sidebar-toggle-button";
import { desktopSidebarAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar";
import { Group } from "@mantine/core";
import Breadcrumb from "@/features/page/components/breadcrumbs/breadcrumb.tsx";

interface Props {
  readOnly?: boolean;
}
export default function PageHeader({ readOnly }: Props) {
  const { t } = useTranslation();
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
          <PageHeaderMenu readOnly={readOnly} />
        </Group>
      </Group>
    </div>
  );
}
