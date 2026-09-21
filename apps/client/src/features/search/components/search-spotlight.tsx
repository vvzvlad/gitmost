import { Spotlight } from "@mantine/spotlight";
import { IconSearch } from "@tabler/icons-react";
import { Group, Text, VisuallyHidden } from "@mantine/core";
import { useState, useMemo, useEffect } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import {
  markOperationStart,
  measureOperation,
} from "@/lib/telemetry/vitals";
import { useTranslation } from "react-i18next";
import { searchSpotlightStore } from "../constants.ts";
import { SearchSpotlightFilters } from "./search-spotlight-filters.tsx";
import { useUnifiedSearch } from "../hooks/use-unified-search.ts";
import { SearchResultItem } from "./search-result-item.tsx";

interface SearchSpotlightProps {
  spaceId?: string;
}
export function SearchSpotlight({ spaceId }: SearchSpotlightProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [debouncedSearchQuery] = useDebouncedValue(query, 300);
  const [filters, setFilters] = useState<{
    spaceId?: string | null;
    contentType?: string;
  }>({
    contentType: "page",
  });

  // Build unified search params
  const searchParams = useMemo(() => {
    const params: any = {
      query: debouncedSearchQuery,
      contentType: filters.contentType || "page", // Only used for frontend routing
    };

    // Handle space filtering - only pass spaceId if a specific space is selected
    if (filters.spaceId) {
      params.spaceId = filters.spaceId;
    }

    return params;
  }, [debouncedSearchQuery, filters]);

  const { data: searchResults, isLoading, isError } = useUnifiedSearch(searchParams);

  // #683 `search_full` — the user's search round-trip: a new non-empty debounced
  // query is the "submit" (mark), and the metric is settled when its results
  // render (isLoading → false). A brand-new query key starts as isLoading=true,
  // so the mark is set before the settle; a superseding query overwrites the mark
  // (replayed search) and an empty query never marks. measureOperation consumes
  // the mark, so each query reports at most once; the surface-open cost is the
  // separate `spotlight_open` metric, so this is not double-counted.
  // Success-only: a failed search (isError) does NOT measure — its mark is left
  // to be overwritten by the next query or to expire silently, so retry-inflated
  // failures never pollute the p95/p99 the metric exists for.
  useEffect(() => {
    if (debouncedSearchQuery.length > 0) markOperationStart("search_full");
  }, [debouncedSearchQuery]);

  useEffect(() => {
    if (debouncedSearchQuery.length > 0 && !isLoading && !isError) {
      measureOperation("search_full");
    }
  }, [debouncedSearchQuery, isLoading, isError]);

  const resultItems = (searchResults || []).map((result) => (
    <SearchResultItem
      key={result.id}
      result={result}
      isAttachmentResult={filters.contentType === "attachment"}
      showSpace={!filters.spaceId}
    />
  ));

  const handleFiltersChange = (newFilters: any) => {
    setFilters(newFilters);
  };

  return (
    <>
      <Spotlight.Root
        size="xl"
        maxHeight={600}
        store={searchSpotlightStore}
        query={query}
        onQueryChange={setQuery}
        scrollable
        overlayProps={{
          backgroundOpacity: 0.55,
        }}
      >
        <Group gap="xs" px="sm" pt="sm" pb="xs">
          <Spotlight.Search
            placeholder={t("Search...")}
            aria-label={t("Search")}
            leftSection={<IconSearch size={20} stroke={1.5} />}
            style={{ flex: 1 }}
          />
        </Group>

        <div
          style={{
            padding: "4px 16px",
          }}
        >
          <SearchSpotlightFilters
            onFiltersChange={handleFiltersChange}
            spaceId={spaceId}
          />
          {/* #529: operator hint — matches ANY word by default; "…" for an exact
              phrase, +term to require, -term to exclude. */}
          <Text size="xs" c="dimmed" mt={4}>
            {t('Tip: "exact phrase", +required, -excluded')}
          </Text>
        </div>

        <VisuallyHidden role="status" aria-live="polite">
          {query.length > 0 && !isLoading
            ? resultItems.length === 0
              ? t("No results found")
              : // Singular/plural handling so 1 result is not announced as
                // "1 results found".
                t("{{count}} result found", { count: resultItems.length })
            : ""}
        </VisuallyHidden>

        <Spotlight.ActionsList>
          {query.length === 0 && resultItems.length === 0 && (
            <Spotlight.Empty>{t("Start typing to search...")}</Spotlight.Empty>
          )}

          {query.length > 0 && !isLoading && resultItems.length === 0 && (
            <Spotlight.Empty>{t("No results found...")}</Spotlight.Empty>
          )}

          {resultItems.length > 0 && <>{resultItems}</>}
        </Spotlight.ActionsList>
      </Spotlight.Root>
    </>
  );
}
