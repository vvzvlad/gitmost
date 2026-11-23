import {
  Group,
  Menu,
  Text,
  UnstyledButton,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconBrandGithub,
  IconBrightnessFilled,
  IconBrush,
  IconCheck,
  IconChevronDown,
  IconDeviceDesktop,
  IconLogout,
  IconMoon,
  IconSettings,
  IconSun,
  IconUsers,
} from "@tabler/icons-react";
import { useAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { Link } from "react-router-dom";
import APP_ROUTE from "@/lib/app-route.ts";
import useAuth from "@/features/auth/hooks/use-auth.ts";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { useTranslation } from "react-i18next";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";

export default function TopMenu({
  className,
  inSidebar = false,
  accountOnly = false,
}: {
  className?: string;
  inSidebar?: boolean;
  accountOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [currentUser] = useAtom(currentUserAtom);
  const { logout } = useAuth();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const user = currentUser?.user;
  const workspace = currentUser?.workspace;

  if (!user || !workspace) {
    return <></>;
  }

  return (
    <>
      <Menu
        width={250}
        position={accountOnly ? "top-start" : "bottom-end"}
        withArrow
        shadow="lg"
      >
        <Menu.Target>
          <UnstyledButton
            className={className}
            aria-label={t(accountOnly ? "Account" : "Workspace menu")}
          >
            <Group gap={7} wrap={"nowrap"}>
              {accountOnly ? (
                <CustomAvatar
                  avatarUrl={user.avatarUrl}
                  name={user.name}
                  size={28}
                  variant="filled"
                />
              ) : inSidebar && !workspace.logo ? (
                <IconUsers size={20} stroke={1.7} />
              ) : (
                <CustomAvatar
                  avatarUrl={workspace?.logo}
                  name={workspace.name}
                  variant="filled"
                  size="sm"
                  type={AvatarIconType.WORKSPACE_ICON}
                />
              )}
              <Text
                fw={500}
                size="sm"
                lh={1}
                mr={3}
                lineClamp={1}
                flex={inSidebar || accountOnly ? 1 : undefined}
              >
                {accountOnly ? user.name : workspace.name}
              </Text>
              <IconChevronDown size={16} />
            </Group>
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          {!accountOnly && (
            <>
              <Menu.Label>{t("Workspace")}</Menu.Label>

              {!inSidebar && (
                <Menu.Item
                  component={Link}
                  to={APP_ROUTE.SETTINGS.WORKSPACE.GENERAL}
                  leftSection={<IconSettings size={16} />}
                >
                  {t("Workspace settings")}
                </Menu.Item>
              )}

              <Menu.Item
                component={Link}
                to={APP_ROUTE.SETTINGS.WORKSPACE.MEMBERS}
                leftSection={<IconUsers size={16} />}
              >
                {t("Manage members")}
              </Menu.Item>
            </>
          )}
          {!inSidebar && (
            <>
              {!accountOnly && <Menu.Divider />}
              <Menu.Label>{t("Account")}</Menu.Label>
              <Menu.Item
                component={Link}
                to={APP_ROUTE.SETTINGS.ACCOUNT.PROFILE}
                aria-label={t("My profile")}
              >
                <Group wrap={"nowrap"}>
                  <CustomAvatar
                    size={"sm"}
                    avatarUrl={user.avatarUrl}
                    name={user.name}
                  />

                  <div style={{ width: 190 }}>
                    <Text size="sm" fw={500} lineClamp={1}>
                      {user.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate="end">
                      {user.email}
                    </Text>
                  </div>
                </Group>
              </Menu.Item>
              <Menu.Item
                component={Link}
                to={APP_ROUTE.SETTINGS.ACCOUNT.PREFERENCES}
                leftSection={<IconBrush size={16} />}
              >
                {t("My preferences")}
              </Menu.Item>

              <Menu.Sub>
                <Menu.Sub.Target>
                  <Menu.Sub.Item
                    leftSection={<IconBrightnessFilled size={16} />}
                  >
                    {t("Theme")}
                  </Menu.Sub.Item>
                </Menu.Sub.Target>

                <Menu.Sub.Dropdown>
                  <Menu.Item
                    onClick={() => setColorScheme("light")}
                    leftSection={<IconSun size={16} />}
                    rightSection={
                      colorScheme === "light" ? <IconCheck size={16} /> : null
                    }
                  >
                    {t("Light")}
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => setColorScheme("dark")}
                    leftSection={<IconMoon size={16} />}
                    rightSection={
                      colorScheme === "dark" ? <IconCheck size={16} /> : null
                    }
                  >
                    {t("Dark")}
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => setColorScheme("auto")}
                    leftSection={<IconDeviceDesktop size={16} />}
                    rightSection={
                      colorScheme === "auto" ? <IconCheck size={16} /> : null
                    }
                  >
                    {t("System settings")}
                  </Menu.Item>
                </Menu.Sub.Dropdown>
              </Menu.Sub>

              {/* AGPL-3.0 §13: every user of this network service is offered the
              Corresponding Source of the running program. */}
              <Menu.Item
                component="a"
                href="https://github.com/Dozor-dev-coder/DozoR-WIKI"
                target="_blank"
                rel="noopener noreferrer"
                leftSection={<IconBrandGithub size={16} />}
              >
                {t("Source code")}
              </Menu.Item>

              <Menu.Divider />

              <Menu.Item
                onClick={logout}
                leftSection={<IconLogout size={16} />}
              >
                {t("Logout")}
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </>
  );
}
