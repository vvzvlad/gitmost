import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Text,
  TextInput,
} from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CopyTextButton from "@/components/common/copy.tsx";
import { getAppUrl } from "@/lib/config.ts";
import {
  useRemoveShareAliasMutation,
  useSetShareAliasMutation,
  useShareAliasForPageQuery,
} from "@/features/share/queries/share-query.ts";
import { checkShareAliasAvailability } from "@/features/share/services/share-service.ts";
import {
  isValidShareAlias,
  normalizeShareAlias,
} from "@/features/share/share-alias.util.ts";

interface ShareAliasSectionProps {
  pageId: string;
  readOnly: boolean;
}

// The prefix label shown next to the slug input, e.g. "docs.example.com/l/".
function aliasPrefixLabel(): string {
  const url = getAppUrl();
  const host = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `${host}/l/`;
}

export default function ShareAliasSection({
  pageId,
  readOnly,
}: ShareAliasSectionProps) {
  const { t } = useTranslation();
  const { data: currentAlias } = useShareAliasForPageQuery(pageId);
  const setAliasMutation = useSetShareAliasMutation();
  const removeAliasMutation = useRemoveShareAliasMutation();

  const [value, setValue] = useState("");
  const [availability, setAvailability] = useState<{
    valid: boolean;
    available: boolean;
    currentPageId: string | null;
  } | null>(null);
  const [reassign, setReassign] = useState<{
    alias: string;
    currentPageTitle: string | null;
  } | null>(null);

  // Seed the input from the page's current alias (if any).
  useEffect(() => {
    setValue(currentAlias?.alias ?? "");
  }, [currentAlias?.alias, pageId]);

  const normalized = useMemo(() => normalizeShareAlias(value), [value]);
  const isValid = isValidShareAlias(normalized);
  const unchanged = currentAlias?.alias === normalized;

  // Debounced availability probe (skips when invalid or unchanged).
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    setAvailability(null);
    if (!isValid || unchanged) return;
    debounceRef.current && clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await checkShareAliasAvailability(normalized);
        setAvailability({
          valid: res.valid,
          available: res.available,
          currentPageId: res.currentPageId,
        });
      } catch {
        setAvailability(null);
      }
    }, 400);
    return () => {
      debounceRef.current && clearTimeout(debounceRef.current);
    };
  }, [normalized, isValid, unchanged]);

  const prettyLink = currentAlias?.alias
    ? `${getAppUrl()}/l/${currentAlias.alias}`
    : null;

  const handleSave = async (confirmReassign = false) => {
    try {
      await setAliasMutation.mutateAsync({
        pageId,
        alias: normalized,
        confirmReassign,
      });
      setReassign(null);
    } catch (error: any) {
      // The address already points at another page: prompt to move it here.
      if (error?.status === 409 || error?.response?.status === 409) {
        const data = error?.response?.data;
        if (data?.code === "ALIAS_REASSIGN_REQUIRED") {
          setReassign({
            alias: normalized,
            currentPageTitle: data?.currentPageTitle ?? null,
          });
        }
      }
    }
  };

  const handleRemove = async () => {
    if (!currentAlias?.id) return;
    await removeAliasMutation.mutateAsync(currentAlias.id);
    setValue("");
  };

  const showInvalid = normalized.length > 0 && !isValid;
  const showTaken =
    isValid && !unchanged && availability && !availability.available;

  return (
    <>
      <Text size="sm" fw={500} mt="md">
        {t("Custom address")}
      </Text>
      <Text size="xs" c="dimmed" mb={4}>
        {t("A short, memorable link you can point at any shared page.")}
      </Text>

      {prettyLink && (
        <Group my="xs" gap={4} wrap="nowrap">
          <TextInput
            variant="filled"
            value={prettyLink}
            readOnly
            rightSection={<CopyTextButton text={prettyLink} />}
            style={{ width: "100%" }}
          />
          <ActionIcon
            component="a"
            variant="default"
            target="_blank"
            href={prettyLink}
            size="sm"
          >
            <IconExternalLink size={16} />
          </ActionIcon>
        </Group>
      )}

      <TextInput
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        // Show the canonical form once the user pauses so what they type maps
        // visibly to what gets stored.
        onBlur={() => setValue(normalized)}
        leftSection={
          <Text size="xs" c="dimmed" pl={4} style={{ whiteSpace: "nowrap" }}>
            {aliasPrefixLabel()}
          </Text>
        }
        leftSectionWidth={Math.min(aliasPrefixLabel().length * 7 + 12, 180)}
        placeholder={t("my-page")}
        disabled={readOnly}
        error={
          showInvalid
            ? t("Use 2-60 lowercase letters, digits and hyphens")
            : showTaken
              ? t("This address is already in use")
              : undefined
        }
      />

      <Group mt="xs" gap="xs">
        <Button
          size="compact-sm"
          onClick={() => handleSave(false)}
          loading={setAliasMutation.isPending}
          disabled={readOnly || !isValid || unchanged}
        >
          {t("Save")}
        </Button>
        {currentAlias?.id && (
          <Button
            size="compact-sm"
            variant="default"
            color="red"
            onClick={handleRemove}
            loading={removeAliasMutation.isPending}
            disabled={readOnly}
          >
            {t("Remove")}
          </Button>
        )}
      </Group>

      <Modal
        opened={!!reassign}
        onClose={() => setReassign(null)}
        title={t("Move custom address?")}
        centered
        size="sm"
      >
        <Text size="sm">
          {reassign?.currentPageTitle
            ? t(
                'The address "{{alias}}" currently points to "{{title}}". Move it to this page?',
                {
                  alias: reassign?.alias,
                  title: reassign?.currentPageTitle,
                },
              )
            : t(
                'The address "{{alias}}" is already in use. Move it to this page?',
                { alias: reassign?.alias },
              )}
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setReassign(null)}>
            {t("Cancel")}
          </Button>
          <Button
            color="red"
            onClick={() => handleSave(true)}
            loading={setAliasMutation.isPending}
          >
            {t("Move here")}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
