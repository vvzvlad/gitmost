import classes from "./switch-space.module.css";
import { useNavigate } from "react-router-dom";
import { getSpaceUrl } from "@/lib/config";
import { Text, UnstyledButton } from "@mantine/core";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";
import {
  prefetchSpace,
  useGetSpacesQuery,
} from "@/features/space/queries/space-query.ts";
import { ISpace } from "../../types/space.types";
import clsx from "clsx";
import React, { useMemo } from "react";

interface SwitchSpaceProps {
  spaceId: string;
  spaceName: string;
  spaceSlug: string;
  spaceIcon?: string;
}

export function SwitchSpace({
  spaceId,
  spaceName,
  spaceSlug,
  spaceIcon,
}: SwitchSpaceProps) {
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
