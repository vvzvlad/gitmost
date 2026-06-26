import { Button, Menu, Stack, Text } from "@mantine/core";
import { IconHourglass, IconPlus } from "@tabler/icons-react";
import { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useGetSpacesQuery } from "@/features/space/queries/space-query.ts";
import { useCreatePageMutation } from "@/features/page/queries/page-query.ts";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { ISpace } from "@/features/space/types/space.types.ts";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";
import { canCreatePage } from "./can-create-page.ts";

// A single create-note action, parametrized by `temporary`. Self-contained: it
// owns its own create mutation so the regular and temporary buttons show
// independent loading state, while the list of writable spaces is resolved once
// by the parent and passed in. With exactly one writable space it creates
// directly; with several it shows a target-space picker.
function CreateNoteButton({
  writableSpaces,
  temporary,
  label,
  icon,
  color,
}: {
  writableSpaces: ISpace[];
  temporary: boolean;
  label: string;
  icon: ReactNode;
  // Mantine color token; lets the temporary action tint toward the warm
  // orange/amber used by the clock marker + banner while "New note" stays neutral.
  color: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createPageMutation = useCreatePageMutation();

  const createNote = async (space: ISpace) => {
    try {
      // `spaceId`/`temporary` are accepted by the create-page endpoint but are
      // not part of the shared `IPageInput` type; cast to satisfy the mutation
      // signature.
      const createdPage = await createPageMutation.mutateAsync({
        spaceId: space.id,
        ...(temporary ? { temporary: true } : {}),
      } as any);
      navigate(buildPageUrl(space.slug, createdPage.slugId, createdPage.title));
    } catch {
      // useCreatePageMutation already surfaces a red notification on error.
    }
  };

  const isPending = createPageMutation.isPending;

  // Exactly one writable space → create directly, no picker needed.
  if (writableSpaces.length === 1) {
    return (
      <Button
        size="md"
        variant="light"
        color={color}
        fullWidth
        leftSection={icon}
        loading={isPending}
        onClick={() => createNote(writableSpaces[0])}
      >
        {label}
      </Button>
    );
  }

  // Multiple writable spaces → pick the target space from a dropdown.
  return (
    <Menu shadow="md" width="target" position="bottom-start">
      <Menu.Target>
        <Button
          size="md"
          variant="light"
          color={color}
          fullWidth
          leftSection={icon}
          loading={isPending}
        >
          {label}
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

// Prominent home-screen actions to create a new note (page). Because the home
// screen has no active space, the target space is resolved from the user's
// writable spaces: created directly when there is one, picked from a dropdown
// when there are several. Renders two full-width, vertically stacked buttons: a
// neutral regular note and an orange-tinted temporary note (which auto-moves to
// Trash after the workspace lifetime). Stacking full-width keeps the longer
// "New temporary note" label from clipping on narrow mobile widths.
export default function NewNoteButton() {
  const { t } = useTranslation();
  const { data } = useGetSpacesQuery({ limit: 100 });

  const writableSpaces = (data?.items ?? []).filter(canCreatePage);

  // No writable space → nothing to create in; render nothing.
  if (writableSpaces.length === 0) return null;

  return (
    <Stack gap="sm">
      <CreateNoteButton
        writableSpaces={writableSpaces}
        temporary={false}
        label={t("New note")}
        icon={<IconPlus size={18} />}
        color="gray"
      />
      <CreateNoteButton
        writableSpaces={writableSpaces}
        temporary={true}
        label={t("New temporary note")}
        icon={<IconHourglass size={18} />}
        color="orange"
      />
    </Stack>
  );
}
