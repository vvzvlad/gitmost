import { useState } from "react";
import { Button, Select, getDefaultZIndex } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconBuilding, IconChevronDown, IconTag } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { useWorkspaceLabelsQuery } from "@/features/label/queries/label-query";
import { SpaceFilterMenu } from "@/features/space/components/space-filter-menu";
import classes from "./search-spotlight-filters.module.css";

interface Props {
  spaceId?: string | null;
  onSpaceChange: (id: string | null) => void;
  labelId: string | null;
  onLabelChange: (id: string | null) => void;
}

export function SearchSpotlightFilters({
  spaceId,
  onSpaceChange,
  labelId,
  onLabelChange,
}: Props) {
  const { t } = useTranslation();
  const { data: spaces } = useGetSpacesQuery({ limit: 100 });
  const space = spaces?.items.find((item) => item.id === spaceId);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query.trim(), 200);
  const [selectedLabel, setSelectedLabel] = useState<{
    value: string;
    label: string;
  }>();
  const { data: labels } = useWorkspaceLabelsQuery(debouncedQuery, opened);
  const options = (labels?.items ?? []).map((label) => ({
    value: label.id,
    label: label.name,
  }));
  if (
    selectedLabel &&
    !options.some((option) => option.value === selectedLabel.value)
  ) {
    options.push(selectedLabel);
  }

  return (
    <div className={classes.filtersContainer}>
      <SpaceFilterMenu
        value={spaceId ?? null}
        onChange={onSpaceChange}
        position="bottom-start"
        width={250}
        zIndex={getDefaultZIndex("max")}
      >
        <Button
          variant="subtle"
          color="gray"
          size="sm"
          rightSection={<IconChevronDown size={14} />}
          leftSection={<IconBuilding size={16} />}
          className={classes.filterButton}
          fw={500}
        >
          {`${t("Space")}: ${spaceId ? (space?.name ?? t("Current space")) : t("All spaces")}`}
        </Button>
      </SpaceFilterMenu>
      <Select
        aria-label={t("Filter by label")}
        placeholder={t("All labels")}
        leftSection={<IconTag size={16} />}
        size="xs"
        w={180}
        style={{ flexShrink: 0 }}
        clearable
        searchable
        onSearchChange={setQuery}
        onDropdownOpen={() => setOpened(true)}
        onDropdownClose={() => setOpened(false)}
        nothingFoundMessage={t("No labels found")}
        data={options}
        value={labelId}
        comboboxProps={{ zIndex: getDefaultZIndex("max"), withinPortal: true }}
        onChange={(id, option) => {
          setSelectedLabel(id ? option : undefined);
          onLabelChange(id);
        }}
      />
    </div>
  );
}
