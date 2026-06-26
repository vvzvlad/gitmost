import { Button, Group, Paper, Text } from "@mantine/core";
import { IconClockHour4 } from "@tabler/icons-react";
import { Trans, useTranslation } from "react-i18next";
import { useTimeAgo } from "@/hooks/use-time-ago.tsx";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import {
  useToggleTemporaryMutation,
  syncTemporaryExpiresInCache,
} from "@/features/page-embed/queries/page-embed-query.ts";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability.ts";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type.ts";

type TemporaryNoteBannerProps = {
  slugId: string;
};

/**
 * Banner shown on an open temporary note ("structure or die"). Mirrors
 * DeletedPageBanner: it reads the page from the shared query cache and offers
 * the explicit rescue action — "Make permanent". Children ride along to trash
 * with the note, which is noted in the copy.
 */
export function TemporaryNoteBanner({ slugId }: TemporaryNoteBannerProps) {
  const { t } = useTranslation();
  const { data: page } = usePageQuery({ pageId: slugId });
  const { data: space } = useGetSpaceBySlugQuery(page?.space?.slug);
  const spaceAbility = useSpaceAbility(space?.membership?.permissions);
  const expiresTimeAgo = useTimeAgo(page?.temporaryExpiresAt);
  const toggleTemporary = useToggleTemporaryMutation();

  // Don't show on a note that is already in trash; the deleted-page banner
  // owns that state.
  if (!page?.temporaryExpiresAt || page?.deletedAt) return null;

  const canEdit = spaceAbility.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page);

  const handleMakePermanent = async () => {
    try {
      const res = await toggleTemporary.mutateAsync({
        pageId: page.id,
        temporary: false,
      });
      syncTemporaryExpiresInCache(page, res.temporaryExpiresAt);
    } catch {
      // mutation surfaces the error via notifications
    }
  };

  return (
    <Paper radius="sm" mb="md" px="md" py="xs" bg="orange.0">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <IconClockHour4
            size={18}
            stroke={1.5}
            style={{
              flexShrink: 0,
              color: "var(--mantine-color-orange-7)",
            }}
          />
          <Text size="sm">
            <Trans
              i18nKey="This temporary note moves to trash {{time}} (with its sub-pages) unless made permanent."
              values={{ time: expiresTimeAgo }}
            />
          </Text>
        </Group>
        {canEdit && (
          <Button
            size="xs"
            variant="light"
            color="orange"
            leftSection={<IconClockHour4 size={16} />}
            onClick={handleMakePermanent}
            loading={toggleTemporary.isPending}
          >
            {t("Make permanent")}
          </Button>
        )}
      </Group>
    </Paper>
  );
}
