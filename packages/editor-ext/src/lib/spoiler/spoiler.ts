import { Mark, markInputRule, mergeAttributes } from "@tiptap/core";

export interface SpoilerOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    spoiler: {
      setSpoiler: () => ReturnType;
      toggleSpoiler: () => ReturnType;
      unsetSpoiler: () => ReturnType;
    };
  }
}

// Discord-style `||text||` input rule. Requires a non-space right after the
// opening `||` and a non-space right before the closing `||` so empty/padded
// markers don't match.
const inputRegex = /(?:^|\s)(\|\|(?!\s)([^|]+)(?<!\s)\|\|)$/;

export const Spoiler = Mark.create<SpoilerOptions>({
  name: "spoiler",

  // Don't bleed onto text typed at the boundary (mirrors link).
  inclusive: false,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  parseHTML() {
    return [{ tag: "span[data-spoiler]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-spoiler": "true",
        class: "spoiler",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setSpoiler:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleSpoiler:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetSpoiler:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  addInputRules() {
    return [markInputRule({ find: inputRegex, type: this.type })];
  },

  // No addKeyboardShortcuts: the issue's proposed `Mod-Shift-s` is already taken
  // by the built-in Strike mark (and `Mod-Shift-h` by Highlight). The `||text||`
  // input rule plus the bubble-menu button cover ergonomics, so we omit a hotkey
  // rather than collide with an existing one.
});
