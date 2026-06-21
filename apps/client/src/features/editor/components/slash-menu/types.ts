import { Range } from "@tiptap/core";
import { useEditor } from "@tiptap/react";

export type CommandProps = {
  editor: ReturnType<typeof useEditor>;
  range: Range;
};

export type CommandListProps = {
  items: SlashMenuGroupedItemsType;
  command: (item: SlashMenuItemType) => void;
  editor: ReturnType<typeof useEditor>;
  range: Range;
};

export type SlashMenuItemType = {
  title: string;
  description: string;
  icon: any;
  separator?: true;
  searchTerms: string[];
  command: (props: CommandProps) => void;
  disable?: (editor: ReturnType<typeof useEditor>) => boolean;
  // When true, the item is hidden unless the workspace HTML embed master toggle
  // is ON. UI gate only — for anonymous public-share reads the server serves
  // already-stripped content when the toggle is OFF.
  requiresHtmlEmbedFeature?: boolean;
};

export type SlashMenuGroupedItemsType = {
  [category: string]: SlashMenuItemType[];
};
