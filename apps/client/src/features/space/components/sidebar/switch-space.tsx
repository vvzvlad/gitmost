import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Collapse, UnstyledButton } from "@mantine/core";
import {
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconStack2,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { getSpaceUrl } from "@/lib/config";
import {
  prefetchSpace,
  useGetSpacesQuery,
} from "@/features/space/queries/space-query";
import classes from "./switch-space.module.css";

interface SwitchSpaceProps {
  spaceId: string;
  spaceName: string;
  children: ReactNode;
}

export function SwitchSpace({
  spaceId,
  spaceName,
  children,
}: SwitchSpaceProps) {
  const { t } = useTranslation();
  const { data } = useGetSpacesQuery({ limit: 100 });
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [activeOpen, setActiveOpen] = useState(true);
  const otherSpaces = (data?.items ?? [])
    .filter((space) => space.id !== spaceId)
    .sort((first, second) => first.name.localeCompare(second.name));

  return (
    <div className={classes.wrapper}>
      <UnstyledButton
        className={classes.section}
        aria-expanded={spacesOpen}
        onClick={() => setSpacesOpen((open) => !open)}
      >
        <IconStack2 size={20} stroke={1.7} />
        <span>{t("Spaces")}</span>
        {spacesOpen ? (
          <IconChevronDown size={16} />
        ) : (
          <IconChevronRight size={16} />
        )}
      </UnstyledButton>
      <Collapse in={spacesOpen}>
        <div className={classes.activeSpace}>
          <UnstyledButton
            className={classes.row}
            onClick={() => setActiveOpen((open) => !open)}
            aria-expanded={activeOpen}
          >
            {activeOpen ? (
              <IconChevronDown size={16} />
            ) : (
              <IconChevronRight size={16} />
            )}
            <IconFolder size={19} stroke={1.7} />
            <span>{spaceName}</span>
          </UnstyledButton>
          <Collapse in={activeOpen}>{children}</Collapse>
        </div>
        {otherSpaces.map((space) => (
          <Link
            key={space.id}
            to={getSpaceUrl(space.slug)}
            className={classes.row}
            onMouseEnter={() => prefetchSpace(space.slug, space.id)}
          >
            <IconChevronRight size={16} />
            <IconFolder size={19} stroke={1.7} />
            <span>{space.name}</span>
          </Link>
        ))}
        {otherSpaces.length >= 99 && (
          <Link className={classes.row} to="/spaces">
            {t("View all spaces")}
          </Link>
        )}
      </Collapse>
    </div>
  );
}
