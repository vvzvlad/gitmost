import { useEffect, useRef, useState } from "react";
import { Modal, ScrollArea, TextInput, Text, UnstyledButton, Group } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { IconFileText, IconSearch } from "@tabler/icons-react";
import type { Editor, Range } from "@tiptap/core";
import { searchSuggestions } from "@/features/search/services/search-service";
import type { IPage } from "@/features/page/types/page.types";

export const PAGE_EMBED_PICKER_EVENT = "open-page-embed-picker";

type PickerDetail = {
  editor: Editor;
  range: Range;
  /** Host page id, used to forbid self-embed in the picker. */
  hostPageId?: string;
};

/**
 * Modal page picker for inserting a `pageEmbed`. Queries search-suggestions
 * with `onlyTemplates` so only template-flagged pages are offered. Forbids
 * selecting the current (host) page (self-embed guard at insertion time).
 * Mounted once per editor; opened via a CustomEvent dispatched by the slash
 * command item.
 */
export default function PageEmbedPicker() {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const detailRef = useRef<PickerDetail | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PickerDetail>).detail;
      if (!detail?.editor) return;
      detailRef.current = detail;
      setQuery("");
      setOpened(true);
    };
    document.addEventListener(PAGE_EMBED_PICKER_EVENT, handler);
    return () => document.removeEventListener(PAGE_EMBED_PICKER_EVENT, handler);
  }, []);

  const { data, isFetching } = useQuery({
    queryKey: ["page-embed-template-picker", query],
    queryFn: () =>
      searchSuggestions({
        query,
        includePages: true,
        onlyTemplates: true,
        limit: 20,
      }),
    enabled: opened,
    staleTime: 30 * 1000,
  });

  const hostPageId = detailRef.current?.hostPageId;
  const pages = ((data?.pages ?? []) as IPage[]).filter(
    (p) => p && p.id !== hostPageId,
  );

  const handleSelect = (page: IPage) => {
    const detail = detailRef.current;
    if (!detail) return;
    const { editor, range } = detail;
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertPageEmbed({ sourcePageId: page.id })
      .run();
    setOpened(false);
  };

  return (
    <Modal
      opened={opened}
      onClose={() => setOpened(false)}
      title={t("Embed page")}
      size="md"
    >
      <TextInput
        placeholder={t("Search templates...")}
        leftSection={<IconSearch size={16} />}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        autoFocus
        mb="sm"
      />
      <ScrollArea.Autosize mah={320}>
        {pages.length === 0 && !isFetching && (
          <Text size="sm" c="dimmed" ta="center" py="md">
            {t("No templates found")}
          </Text>
        )}
        {pages.map((page) => (
          <UnstyledButton
            key={page.id}
            onClick={() => handleSelect(page)}
            style={{ display: "block", width: "100%", padding: "8px 4px" }}
          >
            <Group gap="xs" wrap="nowrap">
              {page.icon ? (
                <span>{page.icon}</span>
              ) : (
                <IconFileText size={16} />
              )}
              <Text size="sm" truncate>
                {page.title || t("Untitled")}
              </Text>
            </Group>
          </UnstyledButton>
        ))}
      </ScrollArea.Autosize>
    </Modal>
  );
}
