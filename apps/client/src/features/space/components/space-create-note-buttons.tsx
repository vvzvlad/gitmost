import { useState } from "react";
import { Button, Menu, Stack } from "@mantine/core";
import { IconFileText, IconHourglass, IconPlus } from "@tabler/icons-react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { useTreeMutation } from "@/features/page/tree/hooks/use-tree-mutation.ts";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability.ts";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type.ts";

// Space-overview quick actions: create a regular note or a temporary note
// (which auto-moves to Trash after the workspace lifetime) directly in the
// current space and open it. Mirrors the sidebar's create buttons but lives on
// the space overview screen, reusing `useTreeMutation.handleCreate` so the new
// page is optimistically inserted into the sidebar tree and navigated to.
export default function SpaceCreateNoteButtons() {
  const { t } = useTranslation();
  const { spaceSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);
  const spaceAbility = useSpaceAbility(space?.membership?.permissions);
  // `handleCreate` is read unconditionally to keep hook order stable; it is
  // only invoked after the permission guard below confirms a loaded space.
  const { handleCreate } = useTreeMutation(space?.id ?? "");
  // Which create action is in flight: drives the per-button spinner and the
  // shared disabled state so a slow create round-trip cannot be double-fired.
  const [pending, setPending] = useState<
    "regular" | "temporary" | "template" | null
  >(null);

  // Render nothing until the space loads, or when the user cannot manage pages.
  if (!space) return null;
  if (spaceAbility.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Page)) {
    return null;
  }

  const templates = [
    {
      title: t("How-to guide"),
      sections: [
        t("Purpose"),
        t("Prerequisites"),
        t("Steps"),
        t("Expected result"),
        t("Troubleshooting"),
      ],
    },
    {
      title: t("Meeting notes"),
      sections: [
        t("Agenda"),
        t("Discussion"),
        t("Decisions"),
        t("Action items"),
      ],
    },
    {
      title: t("Knowledge base article"),
      sections: [
        t("Summary"),
        t("When to use this"),
        t("Details"),
        t("Related resources"),
      ],
    },
  ];

  const createNote = (
    kind: "regular" | "temporary" | "template",
    template?: { title: string; sections: string[] },
  ) => {
    if (pending) return;
    setPending(kind);
    const options = template
      ? {
          template: {
            title: template.title,
            content: template.sections
              .map((section) => `## ${section}`)
              .join("\n\n"),
          },
        }
      : { temporary: kind === "temporary" };
    handleCreate(null, options)
      .catch(() => {
        // The create mutation displays the server error.
      })
      .finally(() => setPending(null));
  };

  return (
    <Stack gap="sm">
      <Button
        size="md"
        variant="light"
        color="gray"
        fullWidth
        leftSection={<IconPlus size={18} />}
        loading={pending === "regular"}
        disabled={pending !== null}
        onClick={() => createNote("regular")}
      >
        {t("New note")}
      </Button>
      <Button
        size="md"
        variant="light"
        color="orange"
        fullWidth
        leftSection={<IconHourglass size={18} />}
        loading={pending === "temporary"}
        disabled={pending !== null}
        onClick={() => createNote("temporary")}
      >
        {t("New temporary note")}
      </Button>
      <Menu position="bottom-start">
        <Menu.Target>
          <Button
            variant="default"
            leftSection={<IconFileText size={18} />}
            loading={pending === "template"}
            disabled={pending !== null}
          >
            {t("New from template")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {templates.map((template) => (
            <Menu.Item
              key={template.title}
              onClick={() => createNote("template", template)}
            >
              {template.title}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}
