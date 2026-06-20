import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Text,
  Textarea,
} from "@mantine/core";
import { IconCode, IconEdit } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import classes from "./html-embed-view.module.css";

/**
 * Inject raw HTML (including <script> tags) into `container`, executing any
 * scripts.
 *
 * Setting `innerHTML` does NOT run inline or external <script> tags the browser
 * parses that way: the HTML spec marks scripts inserted via innerHTML as
 * "already started" so they never execute. To get the tracker/analytics
 * use-case working we walk the freshly-parsed scripts and replace each with a
 * brand-new <script> element copying its attributes and inline code. A
 * programmatically created+inserted <script> DOES execute, so this restores
 * normal script behaviour in the wiki origin (Variant C).
 */
function renderRawHtml(container: HTMLElement, source: string) {
  // Clear any previous render (re-render on source change).
  container.innerHTML = "";
  if (!source) return;

  container.innerHTML = source;

  const scripts = Array.from(container.querySelectorAll("script"));
  for (const oldScript of scripts) {
    const newScript = document.createElement("script");
    // Copy every attribute (src, type, async, defer, data-*, etc.).
    for (const attr of Array.from(oldScript.attributes)) {
      newScript.setAttribute(attr.name, attr.value);
    }
    // Copy inline code.
    newScript.text = oldScript.textContent ?? "";
    // Replacing the node in place triggers execution.
    oldScript.parentNode?.replaceChild(newScript, oldScript);
  }
}

export default function HtmlEmbedView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { node, selected, updateAttributes, editor } = props;
  const { source } = node.attrs as { source: string };
  const { isAdmin } = useUserRole();

  const contentRef = useRef<HTMLDivElement | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<string>(source || "");

  // (Re)render the raw source whenever it changes. This runs in BOTH the
  // editable editor and the read-only / public-share editor (same NodeView),
  // so trackers fire for readers too — that is the intended behaviour.
  useEffect(() => {
    if (contentRef.current) {
      renderRawHtml(contentRef.current, source || "");
    }
  }, [source]);

  const openEditor = useCallback(() => {
    setDraft(source || "");
    setModalOpen(true);
  }, [source]);

  const onSave = useCallback(() => {
    if (editor.isEditable) {
      updateAttributes({ source: draft });
    }
    setModalOpen(false);
  }, [draft, editor.isEditable, updateAttributes]);

  // The edit affordance is only meaningful in edit mode, and authoring is
  // restricted to admins (the server strips the node for non-admins anyway).
  const canEdit = editor.isEditable && isAdmin;

  return (
    <NodeViewWrapper
      data-drag-handle
      className={clsx(classes.htmlEmbedNodeView, {
        [classes.htmlEmbedSelected]: selected,
      })}
    >
      {canEdit && (
        <div className={classes.htmlEmbedToolbar}>
          <ActionIcon
            variant="default"
            size="sm"
            aria-label={t("Edit HTML embed")}
            onClick={openEditor}
          >
            <IconEdit size={16} />
          </ActionIcon>
        </div>
      )}

      {source ? (
        // Raw HTML/CSS/JS rendered into the wiki origin. Scripts are re-created
        // in renderRawHtml so they execute.
        <div ref={contentRef} className={classes.htmlEmbedContent} />
      ) : canEdit ? (
        <div className={classes.htmlEmbedPlaceholder} onClick={openEditor}>
          <IconCode size={18} />
          <Text size="sm">{t("Click to add HTML / CSS / JS")}</Text>
        </div>
      ) : (
        // Empty source, non-editor: render nothing visible.
        <div ref={contentRef} className={classes.htmlEmbedContent} />
      )}

      <Modal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        title={t("Edit HTML embed")}
        size="lg"
      >
        <Text size="xs" c="dimmed" mb="xs">
          {t(
            "This HTML/CSS/JS runs in the page origin for everyone who views it. Admins only.",
          )}
        </Text>
        <Textarea
          autosize
          minRows={10}
          maxRows={24}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder={t("<script>...</script>")}
          styles={{ input: { fontFamily: "monospace" } }}
          data-autofocus
        />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setModalOpen(false)}>
            {t("Cancel")}
          </Button>
          <Button onClick={onSave}>{t("Save")}</Button>
        </Group>
      </Modal>
    </NodeViewWrapper>
  );
}
