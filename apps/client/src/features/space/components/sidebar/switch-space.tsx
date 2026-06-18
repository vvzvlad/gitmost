import classes from "./switch-space.module.css";
import { useNavigate } from "react-router-dom";
import { getSpaceUrl } from "@/lib/config";
import { ActionIcon, Group, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";
import {
  prefetchSpace,
  useGetSpacesQuery,
} from "@/features/space/queries/space-query.ts";
import { ISpace } from "../../types/space.types";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import React, { useMemo } from "react";

interface SwitchSpaceProps {
  spaceId: string;
  spaceName: string;
  spaceSlug: string;
  spaceIcon?: string;
  onSettings: () => void;
}

export function SwitchSpace({
  spaceId,
  spaceName,
  spaceSlug,
  spaceIcon,
  onSettings,
}: SwitchSpaceProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Load every space the user belongs to (API caps limit at 100) and render
  // them as an always-visible grid instead of the previous searchable popover.
  const { data } = useGetSpacesQuery({ limit: 100 });

  // Sort spaces alphabetically by name for a stable, predictable grid.
  const spaces = useMemo(() => {
    const list = [...(data?.items ?? [])];
    // Ensure the active space is always present (and highlightable) in the grid,
    // even when it falls outside the first 100 spaces returned by the API.
    if (spaceSlug && !list.some((s: ISpace) => s.slug === spaceSlug)) {
      list.push({
        id: spaceId,
        name: spaceName,
        slug: spaceSlug,
        logo: spaceIcon,
      } as ISpace);
    }
    return list.sort((a: ISpace, b: ISpace) => a.name.localeCompare(b.name));
  }, [data, spaceId, spaceName, spaceSlug, spaceIcon]);

  const handleSelect = (slug: string) => {
    if (slug && slug !== spaceSlug) {
      navigate(getSpaceUrl(slug));
    }
  };

  return (
    <div className={classes.wrapper}>
      <Group gap={6} wrap="nowrap" className={classes.header}>
        <CustomAvatar
          name={spaceName}
          avatarUrl={spaceIcon}
          type={AvatarIconType.SPACE_ICON}
          color="initials"
          variant="filled"
          size={20}
        />
        <Text className={classes.spaceName} size="md" fw={600} lineClamp={1}>
          {spaceName}
        </Text>
        <Tooltip label={t("Space settings")} withArrow position="top">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            onClick={onSettings}
            aria-label={t("Space settings")}
          >
            <IconSettings size={18} stroke={2} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <div className={classes.grid}>
        {spaces.map((space: ISpace) => (
          <UnstyledButton
            key={space.id}
            className={clsx(
              classes.card,
              space.slug === spaceSlug && classes.cardActive,
            )}
            onClick={() => handleSelect(space.slug)}
            onMouseEnter={() => prefetchSpace(space.slug, space.id)}
            title={space.name}
          >
            <CustomAvatar
              name={space.name}
              avatarUrl={space.logo}
              type={AvatarIconType.SPACE_ICON}
              color="initials"
              variant="filled"
              size={18}
            />
            <Text className={classes.cardName} size="xs" fw={500} lineClamp={1}>
              {space.name}
            </Text>
          </UnstyledButton>
        ))}
      </div>
    </div>
  );
}
