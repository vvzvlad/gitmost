import type { CSSProperties } from "react";
import { IconFolder } from "@tabler/icons-react";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import { AvatarIconType } from "@/features/attachments/types/attachment.types";
import type { ISpaceSettings } from "../types/space.types";
import { SPACE_ICONS } from "./space-icon-options";

interface Props {
  space: { name: string; logo?: string | null; settings?: ISpaceSettings };
  size?: number | string;
  mt?: number | string;
  compact?: boolean;
}

export function SpaceIcon({ space, size = 28, mt, compact }: Props) {
  const appearance = space.settings?.appearance;
  const customized = Boolean(appearance?.icon || appearance?.color);
  if (!customized && !(compact && !space.logo)) {
    return (
      <CustomAvatar
        name={space.name}
        avatarUrl={space.logo ?? undefined}
        type={AvatarIconType.SPACE_ICON}
        color="initials"
        variant="filled"
        size={size}
        mt={mt}
      />
    );
  }
  const Icon =
    SPACE_ICONS.find((option) => option.value === appearance?.icon)
      ?.component ?? IconFolder;
  const color = /^#[0-9a-fA-F]{6}$/.test(appearance?.color ?? "")
    ? appearance!.color!
    : "#166c9d";
  const dimension = typeof size === "number" ? size : size === "md" ? 38 : size;
  const style: CSSProperties = {
    width: dimension,
    height: dimension,
    marginTop: mt,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    color: customized ? color : "currentColor",
    background: compact ? undefined : `${color}15`,
  };
  return (
    <span
      style={style}
      aria-hidden="true"
      data-space-icon={appearance?.icon || "folder"}
    >
      <Icon size={compact ? "100%" : "65%"} stroke={1.8} />
    </span>
  );
}
