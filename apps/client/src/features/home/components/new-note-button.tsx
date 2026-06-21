import { Button, Menu, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useGetSpacesQuery } from "@/features/space/queries/space-query.ts";
import { useCreatePageMutation } from "@/features/page/queries/page-query.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { SpaceRole } from "@/lib/types.ts";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";

// The /spaces list endpoint returns membership.role but NOT membership.permissions
// (only /spaces/info includes CASL rules). Mirror the server space-ability mapping:
// ADMIN and WRITER can manage pages, READER is read-only. So a space is writable
// for the current user when their role is ADMIN or WRITER.
function canCreatePage(space: ISpace): boolean {
  const role = space.membership?.role;
  return role === SpaceRole.ADMIN || role === SpaceRole.WRITER;
}

// Prominent home-screen action to create a new note (page). Because the home
// screen has no active space, the target space is resolved from the user's
// writable spaces: created directly when there is one, picked from a dropdown
// when there are several.
export default function NewNoteButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createPageMutation = useCreatePageMutation();
  const { data } = useGetSpacesQuery({ limit: 100 });

  const writableSpaces = (data?.items ?? []).filter(canCreatePage);

  const createNote = async (space: ISpace) => {
    try {
      // `spaceId` is accepted by the create-page endpoint but is not part of
      // the shared `IPageInput` type; cast to satisfy the mutation signature.
      const createdPage = await createPageMutation.mutateAsync({
        spaceId: space.id,
      } as any);
      navigate(buildPageUrl(space.slug, createdPage.slugId, createdPage.title));
    } catch {
      // useCreatePageMutation already surfaces a red notification on error.
    }
  };

  // No writable space → nothing to create in; render nothing.
  if (writableSpaces.length === 0) return null;

  const isPending = createPageMutation.isPending;

  // Exactly one writable space → create directly, no picker needed.
  if (writableSpaces.length === 1) {
    return (
      <Button
        fullWidth
        size="md"
        leftSection={<IconPlus size={18} />}
        loading={isPending}
        onClick={() => createNote(writableSpaces[0])}
      >
        {t("New note")}
      </Button>
    );
  }

  // Multiple writable spaces → pick the target space from a dropdown.
  return (
    <Menu shadow="md" width="target" position="bottom-start">
      <Menu.Target>
        <Button
          fullWidth
          size="md"
          leftSection={<IconPlus size={18} />}
          loading={isPending}
        >
          {t("New note")}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t("Create in space")}</Menu.Label>
        {writableSpaces.map((space) => (
          <Menu.Item
            key={space.id}
            disabled={isPending}
            leftSection={
              <CustomAvatar
                name={space.name}
                avatarUrl={space.logo}
                type={AvatarIconType.SPACE_ICON}
                color="initials"
                variant="filled"
                size={20}
              />
            }
            onClick={() => createNote(space)}
          >
            <Text size="sm" lineClamp={1}>
              {space.name}
            </Text>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
