import { NodePos, useEditor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import React, { FC, useEffect, useRef, useState } from "react";
import classes from "./table-of-contents.module.css";
import clsx from "clsx";
import { Box, Text, Title } from "@mantine/core";
import { useDebouncedCallback } from "@mantine/hooks";
import { useTranslation } from "react-i18next";

type TableOfContentsProps = {
  editor: ReturnType<typeof useEditor>;
  isShare?: boolean;
};

export type HeadingLink = {
  label: string;
  level: number;
  element: HTMLElement;
  position: number;
};

const recalculateLinks = (nodePos: NodePos[]) => {
  const nodes: HTMLElement[] = [];

  const links: HeadingLink[] = Array.from(nodePos).reduce<HeadingLink[]>(
    (acc, item) => {
      const label = item.node.textContent;
      const level = Number(item.node.attrs.level);
      if (label.length && level <= 4) {
        acc.push({
          label,
          level,
          element: item.element,
          //@ts-ignore
          position: item.resolvedPos.pos,
        });
        nodes.push(item.element);
      }
      return acc;
    },
    [],
  );
  return { links, nodes };
};

export const TableOfContents: FC<TableOfContentsProps> = (props) => {
  const { t } = useTranslation();
  const [links, setLinks] = useState<HeadingLink[]>([]);
  const [headingDOMNodes, setHeadingDOMNodes] = useState<HTMLElement[]>([]);
  const [activeElement, setActiveElement] = useState<HTMLElement | null>(null);
  const headerPaddingRef = useRef<HTMLDivElement | null>(null);

  const handleScrollToHeading = (position: number) => {
    const { view } = props.editor;

    const headerOffset = parseInt(
      window.getComputedStyle(headerPaddingRef.current).getPropertyValue("top"),
    );

    const { node } = view.domAtPos(position);
    const element = node as HTMLElement;
    const scrollPosition =
      element.getBoundingClientRect().top + window.scrollY - headerOffset;

    window.scrollTo({
      top: scrollPosition,
      behavior: "smooth",
    });

    const tr = view.state.tr;
    tr.setSelection(new TextSelection(tr.doc.resolve(position)));
    view.dispatch(tr);
    view.focus();
  };

  const handleUpdate = () => {
    // `?? []`: with a null editor (the panel restored open before the editor has
    // mounted) `$nodes` is not called and recalculateLinks receives an empty
    // array instead of `undefined` — otherwise `Array.from(undefined)` throws,
    // and the root ChunkLoadErrorBoundary's only control is a reload button,
    // producing an inescapable reload loop.
    const result = recalculateLinks(props.editor?.$nodes("heading") ?? []);

    setLinks(result.links);
    setHeadingDOMNodes(result.nodes);
  };

  // Debounce the update-driven rescan: `$nodes("heading")` scans every heading
  // in the document, and it previously ran on EVERY keystroke while the TOC
  // panel was open. The panel is derived UI, so recomputing ~300ms after typing
  // settles keeps it correct without doing an all-headings scan per keystroke
  // (#343, PART 7). `useDebouncedCallback` returns a stable reference and always
  // invokes the latest `handleUpdate`.
  const debouncedHandleUpdate = useDebouncedCallback(handleUpdate, 300);

  useEffect(() => {
    props.editor?.on("update", debouncedHandleUpdate);

    return () => {
      props.editor?.off("update", debouncedHandleUpdate);
    };
  }, [props.editor, debouncedHandleUpdate]);

  // Rescan on mount AND whenever the editor handle changes, in BOTH modes. The
  // former non-share deps `[]` scanned exactly once at mount; if the editor was
  // null then (panel restored open before the editor mounted) it would never
  // rescan (read mode gets no `update` events) and the TOC stayed permanently
  // empty. Depending on `props.editor` also removes the variable-length deps
  // array the ternary produced.
  useEffect(() => {
    handleUpdate();
  }, [props.editor]);

  useEffect(() => {
    try {
      const observeHandler = (entries: IntersectionObserverEntry[]) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveElement(entry.target as HTMLElement);
          }
        });
      };

      let headerOffset = 0;
      if (headerPaddingRef.current) {
        headerOffset = parseInt(
          window
            .getComputedStyle(headerPaddingRef.current)
            .getPropertyValue("top"),
        );
      }
      const observerOptions: IntersectionObserverInit = {
        rootMargin: `-${headerOffset}px 0px -85% 0px`,
        threshold: 0,
        root: null,
      };
      const observer = new IntersectionObserver(
        observeHandler,
        observerOptions,
      );

      headingDOMNodes.forEach((heading) => {
        observer.observe(heading);
      });
      return () => {
        headingDOMNodes.forEach((heading) => {
          observer.unobserve(heading);
        });
      };
    } catch (err) {
      console.log(err);
    }
  }, [headingDOMNodes, props.editor]);

  // No editor yet (panel restored open on reload before the editor mounts): show
  // NOTHING rather than the "Add headings…" empty state, which would falsely
  // assert the user's page has no headings until the editor arrives. Safe at both
  // call sites: share-shell gates on `readOnlyEditor &&`, and aside.tsx checks the
  // returned element with `component &&`, so the panel chrome is unaffected.
  if (!props.editor) return null;

  if (!links.length) {
    return (
      <>
        {!props.isShare && (
          <Text size="sm">
            {t("Add headings (H1, H2, H3) to generate a table of contents.")}
          </Text>
        )}

        {props.isShare && (
          <Text size="sm" c="dimmed">
            {t("No table of contents.")}
          </Text>
        )}
      </>
    );
  }

  return (
    <>
      {props.isShare && (
        <Title order={2} size="h6" mb="md" fw={500}>
          {t("Table of contents")}
        </Title>
      )}
      <div className={props.isShare ? classes.leftBorder : ""}>
        {links.map((item, idx) => (
          <Box<"button">
            component="button"
            onClick={() => handleScrollToHeading(item.position)}
            key={idx}
            className={clsx(classes.link, {
              [classes.linkActive]: item.element === activeElement,
            })}
            style={{
              paddingLeft: `calc(${item.level} * var(--mantine-spacing-md))`,
            }}
          >
            {item.label}
          </Box>
        ))}
      </div>
      <div ref={headerPaddingRef} className={classes.headerPadding} />
    </>
  );
};
