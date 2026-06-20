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
  // When true, the item is only offered to workspace admins/owners. This is a
  // UI convenience only — the real authoring gate is enforced server-side.
  adminOnly?: boolean;
  // When true, the item is hidden unless the workspace HTML embed feature toggle
  // is ON. Combined with adminOnly, the item shows only for admins in workspaces
  // where the feature is enabled. UI gate only — the server strips htmlEmbed on
  // every write where the toggle is OFF or the user is not an admin.
  requiresHtmlEmbedFeature?: boolean;
};

export type SlashMenuGroupedItemsType = {
  [category: string]: SlashMenuItemType[];
};
