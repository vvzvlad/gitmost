import {
  IconBlockquote,
  IconCaretRightFilled,
  IconCheckbox,
  IconCode,
  IconH1,
  IconH2,
  IconH3,
  IconInfoCircle,
  IconList,
  IconListNumbers,
  IconMath,
  IconMathFunction,
  IconMovie,
  IconMusic,
  IconPaperclip,
  IconFileTypePdf,
  IconPhoto,
  IconTable,
  IconTypography,
  IconMenu4,
  IconPageBreak,
  IconCalendar,
  IconAppWindow,
  IconSitemap,
  IconColumns3,
  IconColumns2,
  IconTag,
  IconMoodSmile,
  IconRotate2,
  IconSuperscript,
  IconArrowsMaximize,
} from "@tabler/icons-react";
import { PAGE_EMBED_PICKER_EVENT } from "@/features/editor/components/page-embed/page-embed-picker";
import {
  CommandProps,
  SlashMenuGroupedItemsType,
  SlashMenuItemType,
} from "@/features/editor/components/slash-menu/types";
import { uploadImageAction } from "@/features/editor/components/image/upload-image-action.tsx";
import { uploadVideoAction } from "@/features/editor/components/video/upload-video-action.tsx";
import { uploadAudioAction } from "@/features/editor/components/audio/upload-audio-action.tsx";
import { uploadAttachmentAction } from "@/features/editor/components/attachment/upload-attachment-action.tsx";
import { uploadPdfAction } from "@/features/editor/components/pdf/upload-pdf-action.tsx";
import IconExcalidraw from "@/components/icons/icon-excalidraw";
import IconMermaid from "@/components/icons/icon-mermaid";
import IconDrawio from "@/components/icons/icon-drawio";
import { IconColumns4 } from "@/components/icons/icon-columns-4";
import { IconColumns5 } from "@/components/icons/icon-columns-5";
import i18n from "@/i18n.ts";
import {
  AirtableIcon,
  FigmaIcon,
  FramerIcon,
  GoogleDriveIcon,
  GoogleSheetsIcon,
  LoomIcon,
  MiroIcon,
  TypeformIcon,
  VimeoIcon,
  YoutubeIcon,
} from "@/components/icons";

const CommandGroups: SlashMenuGroupedItemsType = {
  basic: [
    {
      title: "Text",
      description: "Just start typing with plain text.",
      searchTerms: ["p", "paragraph"],
      icon: IconTypography,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .toggleNode("paragraph", "paragraph")
          .run();
      },
    },
    {
      title: "To-do list",
      description: "Track tasks with a to-do list.",
      searchTerms: ["todo", "task", "list", "check", "checkbox"],
      icon: IconCheckbox,
      command: ({ editor, range }: CommandProps) => {
        editor.chain().focus().deleteRange(range).toggleTaskList().run();
      },
    },
    {
      title: "Heading 1",
      description: "Big section heading.",
      searchTerms: ["title", "big", "large"],
      icon: IconH1,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode("heading", { level: 1 })
          .run();
      },
    },
    {
      title: "Heading 2",
      description: "Medium section heading.",
      searchTerms: ["subtitle", "medium"],
      icon: IconH2,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode("heading", { level: 2 })
          .run();
      },
    },
    {
      title: "Heading 3",
      description: "Small section heading.",
      searchTerms: ["subtitle", "small"],
      icon: IconH3,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode("heading", { level: 3 })
          .run();
      },
    },
    {
      title: "Bullet list",
      description: "Create a simple bullet list.",
      searchTerms: ["unordered", "point", "list"],
      icon: IconList,
      command: ({ editor, range }: CommandProps) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run();
      },
    },
    {
      title: "Numbered list",
      description: "Create a list with numbering.",
      searchTerms: ["numbered", "ordered", "list", "ol"],
      icon: IconListNumbers,
      command: ({ editor, range }: CommandProps) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      },
    },
    {
      title: "Quote",
      description: "Create block quote.",
      searchTerms: ["blockquote", "quotes"],
      icon: IconBlockquote,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      title: "Code",
      description: "Insert code snippet.",
      searchTerms: ["codeblock"],
      icon: IconCode,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      title: "Divider",
      description: "Insert horizontal rule divider",
      searchTerms: ["horizontal rule", "hr"],
      icon: IconMenu4,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
    {
      title: "Page break",
      description: "Insert a page break for printing.",
      searchTerms: ["page", "break", "pagebreak", "print"],
      icon: IconPageBreak,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).setPageBreak().run(),
    },
    {
      title: "Image",
      description: "Upload any image from your device.",
      searchTerms: ["photo", "picture", "media", "file", "attachment"],
      icon: IconPhoto,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();

        // @ts-ignore
        const pageId = editor.storage?.pageId;
        if (!pageId) return;

        // upload image
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async () => {
          if (input.files?.length) {
            for (const file of input.files) {
              const pos = editor.view.state.selection.from;

              uploadImageAction(file, editor, pos, pageId);
            }
          }

          input.remove();
        };
        input.click();
      },
    },
    {
      title: "Video",
      description: "Upload any video from your device.",
      searchTerms: ["video", "mp4", "media", "file", "attachment"],
      icon: IconMovie,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();

        // @ts-ignore
        const pageId = editor.storage?.pageId;
        if (!pageId) return;

        // upload video
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "video/*";
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async () => {
          if (input.files?.length) {
            for (const file of input.files) {
              const pos = editor.view.state.selection.from;

              uploadVideoAction(file, editor, pos, pageId);
            }
          }

          input.remove();
        };
        input.click();
      },
    },
    {
      title: "Audio",
      description: "Upload any audio from your device.",
      searchTerms: [
        "audio",
        "music",
        "sound",
        "mp3",
        "media",
        "file",
        "attachment",
      ],
      icon: IconMusic,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();

        // @ts-ignore
        const pageId = editor.storage?.pageId;
        if (!pageId) return;

        // upload audio
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "audio/*";
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async () => {
          if (input.files?.length) {
            for (const file of input.files) {
              const pos = editor.view.state.selection.from;

              uploadAudioAction(file, editor, pos, pageId);
            }
          }

          input.remove();
        };
        input.click();
      },
    },
    {
      title: "Embed PDF",
      description: "Upload and embed a PDF file.",
      searchTerms: ["pdf", "document", "embed"],
      icon: IconFileTypePdf,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();

        // @ts-ignore
        const pageId = editor.storage?.pageId;
        if (!pageId) return;

        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/pdf";
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async () => {
          if (input.files?.length) {
            for (const file of input.files) {
              const pos = editor.view.state.selection.from;

              uploadPdfAction(file, editor, pos, pageId);
            }
          }

          input.remove();
        };
        input.click();
      },
    },
    {
      title: "File attachment",
      description: "Upload any file from your device.",
      searchTerms: ["file", "attachment", "upload", "csv", "zip"],
      icon: IconPaperclip,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();

        // @ts-ignore
        const pageId = editor.storage?.pageId;
        if (!pageId) return;

        // upload file
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "";
        input.multiple = true;
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = async () => {
          if (input.files?.length) {
            for (const file of input.files) {
              const pos = editor.view.state.selection.from;

              uploadAttachmentAction(file, editor, pos, pageId, true);
            }
          }

          input.remove();
        };
        input.click();
      },
    },
    {
      title: "Table",
      description: "Insert a table.",
      searchTerms: ["table", "rows", "columns"],
      icon: IconTable,
      command: ({ editor, range }: CommandProps) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      title: "Toggle block",
      description: "Insert collapsible block.",
      searchTerms: ["collapsible", "block", "toggle", "details", "expand"],
      icon: IconCaretRightFilled,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).setDetails().run(),
    },
    {
      title: "Footnote",
      description: "Insert a footnote reference.",
      searchTerms: ["footnote", "note", "reference", "сноска", "примечание"],
      icon: IconSuperscript,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).setFootnote().run(),
    },
    {
      title: "Callout",
      description: "Insert callout notice.",
      searchTerms: [
        "callout",
        "notice",
        "panel",
        "info",
        "warning",
        "success",
        "error",
        "danger",
      ],
      icon: IconInfoCircle,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).toggleCallout().run(),
    },
    {
      title: "Math inline",
      description: "Insert inline math equation.",
      searchTerms: [
        "math",
        "inline",
        "mathinline",
        "inlinemath",
        "inline math",
        "equation",
        "katex",
        "latex",
        "tex",
      ],
      icon: IconMathFunction,
      command: ({ editor, range }: CommandProps) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setMathInline()
          .setNodeSelection(range.from)
          .run(),
    },
    {
      title: "Math block",
      description: "Insert math equation",
      searchTerms: [
        "math",
        "block",
        "mathblock",
        "block math",
        "equation",
        "katex",
        "latex",
        "tex",
      ],
      icon: IconMath,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).setMathBlock().run(),
    },
    {
      title: "Mermaid diagram",
      description: "Insert mermaid diagram",
      searchTerms: ["mermaid", "diagrams", "chart", "uml"],
      icon: IconMermaid,
      command: ({ editor, range }: CommandProps) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setCodeBlock({ language: "mermaid" })
          .insertContent("flowchart LR\n" + "    A --> B")
          .run(),
    },
    {
      title: "Draw.io (diagrams.net)",
      description: "Insert and design Drawio diagrams",
      searchTerms: ["drawio", "diagrams", "charts", "uml", "whiteboard"],
      icon: IconDrawio,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).setDrawio().run(),
    },
    {
      title: "Excalidraw (Whiteboard)",
      description: "Draw and sketch excalidraw diagrams",
      searchTerms: ["diagrams", "draw", "sketch", "whiteboard"],
      icon: IconExcalidraw,
      command: ({ editor, range }: CommandProps) =>
        editor.chain().focus().deleteRange(range).setExcalidraw().run(),
    },
    {
      title: "Date",
      description: "Insert current date",
      searchTerms: ["date", "today"],
      icon: IconCalendar,
      command: ({ editor, range }: CommandProps) => {
        const currentDate = new Date().toLocaleDateString(i18n.language, {
          year: "numeric",
          month: "long",
          day: "numeric",
        });

        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent(currentDate)
          .run();
      },
    },
    {
      title: "Status",
      description: "Insert inline status badge.",
      searchTerms: ["status", "badge", "label", "lozenge"],
      icon: IconTag,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setStatus({ text: "", color: "gray" })
          .run();
      },
    },
    {
      title: "Emoji",
      description: "Insert emoji.",
      searchTerms: ["emoji", "icon", "smiley", "emoticon", "symbol", "reaction"],
      icon: IconMoodSmile,
      command: ({ editor, range }: CommandProps) => {
        editor.chain().focus().deleteRange(range).insertContent(":").run();
      },
    },
    {
      title: "Subpages (Child pages)",
      description: "List all subpages of the current page",
      searchTerms: [
        "subpages",
        "child",
        "children",
        "nested",
        "hierarchy",
        "toc",
      ],
      icon: IconSitemap,
      command: ({ editor, range }: CommandProps) => {
        editor.chain().focus().deleteRange(range).insertSubpages().run();
      },
    },
    {
      title: "Page tree (child pages, recursive)",
      description: "Render the full nested tree of all descendant pages",
      searchTerms: [
        "subpages",
        "child",
        "children",
        "nested",
        "hierarchy",
        "tree",
        "recursive",
        "toc",
      ],
      icon: IconSitemap,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertSubpages({ recursive: true })
          .run();
      },
    },
    {
      title: "Synced block",
      description: "Create a block that stays in sync across pages.",
      searchTerms: [
        "sync",
        "synced",
        "synced block",
        "excerpt",
        "transclusion",
        "reusable",
        "snippet",
      ],
      icon: IconRotate2,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTransclusionSource()
          .run();
      },
    },
    {
      title: "Embed page",
      description: "Insert a live, read-only copy of another page.",
      searchTerms: [
        "template",
        "embed",
        "embed page",
        "page",
        "live",
        "include",
        "reuse",
      ],
      icon: IconArrowsMaximize,
      command: ({ editor, range }: CommandProps) => {
        // @ts-ignore - editor.storage.pageId is set by the host editor
        const hostPageId: string | undefined = editor.storage?.pageId;
        document.dispatchEvent(
          new CustomEvent(PAGE_EMBED_PICKER_EVENT, {
            detail: { editor, range, hostPageId },
          }),
        );
      },
    },
    {
      title: "2 Columns",
      description: "Split content into two columns.",
      searchTerms: ["columns", "layout", "split", "side"],
      icon: IconColumns2,
      command: ({ editor, range }: CommandProps) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertColumns({ layout: "two_equal" })
          .run(),
    },
    {
      title: "3 Columns",
      description: "Split content into three columns.",
      searchTerms: ["columns", "layout", "split", "triple"],
      icon: IconColumns3,
      command: ({ editor, range }: CommandProps) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertColumns({ layout: "three_equal" })
          .run(),
    },
    {
      title: "4 Columns",
      description: "Split content into four columns.",
      searchTerms: ["columns", "layout", "split"],
      icon: IconColumns4,
      command: ({ editor, range }: CommandProps) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertColumns({ layout: "four_equal" })
          .run(),
    },
    {
      title: "5 Columns",
      description: "Split content into five columns.",
      searchTerms: ["columns", "layout", "split"],
      icon: IconColumns5,
      command: ({ editor, range }: CommandProps) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertColumns({ layout: "five_equal" })
          .run(),
    },
    {
      title: "HTML embed",
      description: "Embed raw HTML, CSS and JavaScript (sandboxed).",
      searchTerms: ["html", "css", "js", "javascript", "script", "tracker", "analytics", "raw", "embed"],
      icon: IconCode,
      requiresHtmlEmbedFeature: true,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setHtmlEmbed({ source: "" })
          .run();
      },
    },
    {
      title: "Iframe embed",
      description: "Embed any Iframe",
      searchTerms: ["iframe"],
      icon: IconAppWindow,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "iframe" })
          .run();
      },
    },
    {
      title: "Airtable",
      description: "Embed Airtable",
      searchTerms: ["airtable"],
      icon: AirtableIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "airtable" })
          .run();
      },
    },
    {
      title: "Loom",
      description: "Embed Loom video",
      searchTerms: ["loom"],
      icon: LoomIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "loom" })
          .run();
      },
    },
    {
      title: "Figma",
      description: "Embed Figma files",
      searchTerms: ["figma"],
      icon: FigmaIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "figma" })
          .run();
      },
    },
    {
      title: "Typeform",
      description: "Embed Typeform",
      searchTerms: ["typeform"],
      icon: TypeformIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "typeform" })
          .run();
      },
    },
    {
      title: "Miro",
      description: "Embed Miro board",
      searchTerms: ["miro"],
      icon: MiroIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "miro" })
          .run();
      },
    },
    {
      title: "YouTube",
      description: "Embed YouTube video",
      searchTerms: ["youtube", "yt", "media", "video"],
      icon: YoutubeIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "youtube" })
          .run();
      },
    },
    {
      title: "Vimeo",
      description: "Embed Vimeo video",
      searchTerms: ["vimeo"],
      icon: VimeoIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "vimeo" })
          .run();
      },
    },
    {
      title: "Framer",
      description: "Embed Framer prototype",
      searchTerms: ["framer"],
      icon: FramerIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "framer" })
          .run();
      },
    },
    {
      title: "Google Drive",
      description: "Embed Google Drive content",
      searchTerms: ["google drive", "gdrive"],
      icon: GoogleDriveIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "gdrive" })
          .run();
      },
    },
    {
      title: "Google Sheets",
      description: "Embed Google Sheets content",
      searchTerms: ["google sheets", "gsheets"],
      icon: GoogleSheetsIcon,
      command: ({ editor, range }: CommandProps) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setEmbed({ provider: "gsheets" })
          .run();
      },
    },
  ],
};

/**
 * Read the workspace-level HTML embed master toggle from the persisted
 * `currentUser` payload (the same localStorage entry `currentUserAtom` writes,
 * carrying `workspace.settings`). ABSENT/false => OFF (the default). The slash
 * `getSuggestionItems` is a plain function (no React/atom context), so we read
 * the persisted state directly. UI gate only; an anonymous public-share read is
 * served already-stripped content by the server when the toggle is OFF.
 */
export function isHtmlEmbedFeatureEnabled(): boolean {
  try {
    const raw = localStorage.getItem("currentUser");
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.workspace?.settings?.htmlEmbed === true;
  } catch {
    return false;
  }
}

// Russian ЙЦУКЕН -> US QWERTY by physical key position (lowercase; callers
// lowercase first). Lets the slash menu match Latin item titles/terms even when
// a command is typed with the wrong keyboard layout active (e.g. "/сщву" while
// ЙЦУКЕН is on physically types the same keys as "/code").
const RU_TO_EN_LAYOUT: Record<string, string> = {
  й: "q", ц: "w", у: "e", к: "r", е: "t", н: "y", г: "u", ш: "i", щ: "o",
  з: "p", х: "[", ъ: "]",
  ф: "a", ы: "s", в: "d", а: "f", п: "g", р: "h", о: "j", л: "k", д: "l",
  ж: ";", э: "'",
  я: "z", ч: "x", с: "c", м: "v", и: "b", т: "n", ь: "m", б: ",", ю: ".",
  ё: "`",
};
// Inverse map: US QWERTY -> Russian ЙЦУКЕН by physical key position. Handles the
// mirror case (e.g. "cyjcrf" typed with EN layout on == "сноска" == Footnote).
const EN_TO_RU_LAYOUT: Record<string, string> = Object.fromEntries(
  Object.entries(RU_TO_EN_LAYOUT).map(([ru, en]) => [en, ru]),
);

function translitByLayout(text: string, map: Record<string, string>): string {
  let out = "";
  for (const ch of text) out += map[ch] ?? ch;
  return out;
}

/**
 * Build the list of search strings to try for a given query: the original
 * query first, followed by its RU->EN and EN->RU physical-layout remappings.
 * Keeping the original first preserves genuine Cyrillic search terms (e.g.
 * "сноска"/"примечание" for Footnote) and lets callers treat the original
 * differently from the remapped candidates. De-duplication only collapses the
 * list to one element when nothing is remappable (e.g. digits/spaces), so a
 * typical ASCII query still yields multiple candidates.
 */
export function buildLayoutCandidates(search: string): string[] {
  return [
    ...new Set([
      search,
      translitByLayout(search, RU_TO_EN_LAYOUT),
      translitByLayout(search, EN_TO_RU_LAYOUT),
    ]),
  ];
}

export const getSuggestionItems = ({
  query,
  excludeItems,
}: {
  query: string;
  excludeItems?: Set<string>;
}): SlashMenuGroupedItemsType => {
  const search = query.toLowerCase();
  const candidates = buildLayoutCandidates(search);
  // buildLayoutCandidates dedupes the remaps against the original, so
  // candidates[0] is the original query and the rest are wrong-layout remaps.
  // The original query matches on everything (title, description, searchTerms).
  // A remapped candidate matches fully only when it is long enough to be
  // unambiguous; a short (1-2 char) remap is restricted to a TITLE match so it
  // does not spuriously substring-match unrelated Cyrillic search terms
  // (e.g. "/cy" -> "сн" hitting the "сноска" searchTerm, "/b" -> "и" hitting
  // "примечание"), while still letting a real short wrong-layout prefix through
  // (e.g. "/сщ" -> "co" fuzzy-matching the "Code" title).
  const REMAP_FULL_MATCH_MIN_LEN = 3;
  const [originalCandidate, ...remapped] = candidates;
  const filteredGroups: SlashMenuGroupedItemsType = {};
  const htmlEmbedFeatureEnabled = isHtmlEmbedFeatureEnabled();

  const fuzzyMatch = (query: string, target: string) => {
    let queryIndex = 0;
    target = target.toLowerCase();
    for (const char of target) {
      if (query[queryIndex] === char) queryIndex++;
      if (queryIndex === query.length) return true;
    }
    return false;
  };

  const candidateMatchesItem = (
    candidate: string,
    item: SlashMenuItemType,
    description: string,
    titleOnly: boolean,
  ) => {
    if (fuzzyMatch(candidate, item.title)) return true;
    if (titleOnly) return false;
    return (
      description.includes(candidate) ||
      (item.searchTerms != null &&
        item.searchTerms.some((term: string) => term.includes(candidate)))
    );
  };

  for (const [group, items] of Object.entries(CommandGroups)) {
    const filteredItems = items.filter((item) => {
      if (excludeItems?.has(item.title)) return false;
      // Hide the HTML embed item unless the workspace master toggle is ON.
      if (item.requiresHtmlEmbedFeature && !htmlEmbedFeatureEnabled)
        return false;
      const description = item.description.toLowerCase();
      return (
        candidateMatchesItem(originalCandidate, item, description, false) ||
        remapped.some((candidate) =>
          candidateMatchesItem(
            candidate,
            item,
            description,
            candidate.length < REMAP_FULL_MATCH_MIN_LEN,
          ),
        )
      );
    });

    if (filteredItems.length) {
      const titleMatchesAnyCandidate = (title: string) => {
        const lower = title.toLowerCase();
        return (
          lower.includes(originalCandidate) ||
          remapped.some((candidate) => lower.includes(candidate))
        );
      };
      filteredGroups[group] = filteredItems.sort((a, b) => {
        const aTitle = titleMatchesAnyCandidate(a.title) ? 0 : 1;
        const bTitle = titleMatchesAnyCandidate(b.title) ? 0 : 1;
        return aTitle - bTitle;
      });
    }
  }

  return filteredGroups;
};

export default getSuggestionItems;
