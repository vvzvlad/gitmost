import React, { useState, useEffect } from "react";
import {
  Button,
  Menu,
  Text,
  Group,
  getDefaultZIndex,
} from "@mantine/core";
import {
  IconChevronDown,
  IconBuilding,
  IconFileDescription,
  IconCheck,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { SpaceFilterMenu } from "@/features/space/components/space-filter-menu";
import { RadioMenuItem } from "@/components/ui/radio-menu-item";
import classes from "./search-spotlight-filters.module.css";

interface SearchSpotlightFiltersProps {
  onFiltersChange?: (filters: any) => void;
  spaceId?: string;
}

export function SearchSpotlightFilters({
  onFiltersChange,
  spaceId,
}: SearchSpotlightFiltersProps) {
  const { t } = useTranslation();
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(
    spaceId || null,
  );
  const [contentType, setContentType] = useState<string | null>("page");

  const { data: spacesData } = useGetSpacesQuery({ limit: 100 });
  const selectedSpaceData = selectedSpaceId
    ? spacesData?.items.find((space) => space.id === selectedSpaceId)
    : null;

  useEffect(() => {
    if (onFiltersChange) {
      onFiltersChange({
        spaceId: selectedSpaceId,
        contentType,
      });
    }
  }, []);

  const contentTypeOptions = [{ value: "page", label: t("Pages") }];

  const handleSpaceSelect = (spaceId: string | null) => {
    setSelectedSpaceId(spaceId);

    if (onFiltersChange) {
      onFiltersChange({
        spaceId: spaceId,
        contentType,
      });
    }
  };

  const handleFilterChange = (filterType: string, value: any) => {
    let newSelectedSpaceId = selectedSpaceId;
    let newContentType = contentType;

    switch (filterType) {
      case "spaceId":
        newSelectedSpaceId = value;
        setSelectedSpaceId(value);
        break;
      case "contentType":
        newContentType = value;
        setContentType(value);
        break;
    }

    if (onFiltersChange) {
      onFiltersChange({
        spaceId: newSelectedSpaceId,
        contentType: newContentType,
      });
    }
  };

  return (
    <div className={classes.filtersContainer}>
      <SpaceFilterMenu
        value={selectedSpaceId}
        onChange={handleSpaceSelect}
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
          {selectedSpaceId
            ? `${t("Space")}: ${selectedSpaceData?.name || t("Unknown")}`
            : `${t("Space")}: ${t("All spaces")}`}
        </Button>
      </SpaceFilterMenu>

      <Menu
        shadow="md"
        width={220}
        position="bottom-start"
        zIndex={getDefaultZIndex("max")}
      >
        <Menu.Target>
          <Button
            variant="subtle"
            color="gray"
            size="sm"
            rightSection={<IconChevronDown size={14} />}
            leftSection={<IconFileDescription size={16} />}
            className={classes.filterButton}
            fw={500}
          >
            {contentType
              ? `${t("Type")}: ${contentTypeOptions.find((opt) => opt.value === contentType)?.label || t(contentType === "page" ? "Pages" : "Attachments")}`
              : t("Type")}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {contentTypeOptions.map((option) => (
            <Menu.Item
              key={option.value}
              component={RadioMenuItem}
              aria-checked={contentType === option.value}
              onClick={() =>
                contentType !== option.value &&
                handleFilterChange("contentType", option.value)
              }
            >
              <Group flex="1" gap="xs">
                <div>
                  <Text size="sm">{option.label}</Text>
                </div>
                {contentType === option.value && <IconCheck size={20} aria-hidden />}
              </Group>
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
