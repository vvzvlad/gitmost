import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { SuggestionOptions } from '@tiptap/suggestion';
import renderItems from '@/features/editor/components/slash-menu/render-items';
import getSuggestionItems from '@/features/editor/components/slash-menu/menu-items';

export const slashMenuPluginKey = new PluginKey('slash-command');

// getSuggestionItems fuzzy-matches EVERY command against the query (plus its
// wrong-keyboard-layout remaps) and, while the slash menu is open, is invoked
// TWICE per keystroke: once by the synchronous `allow` gate below and once by
// the popup's `items` builder. A synchronous gating predicate can't be
// debounced without breaking the suggestion decoration/activation, so instead we
// memoize the LAST query's result: the two same-query calls in one keystroke
// build the list only once, and the cache invalidates the moment the query
// changes — so there is no stale-state risk (#343, PART 7).
let lastQuery: string | null = null;
let lastResult: ReturnType<typeof getSuggestionItems> | null = null;
function suggestionItemsForQuery(query: string) {
  if (query === lastQuery && lastResult) return lastResult;
  lastQuery = query;
  lastResult = getSuggestionItems({ query });
  return lastResult;
}

// @ts-ignore
const Command = Extension.create({
  name: 'slash-command',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        // Keep the query alive through spaces so multi-word item labels
        // (e.g. "Heading 1", "Math block") match instead of terminating the
        // query and leaving literal "/Heading 1" text in the document.
        allowSpaces: true,
        command: ({ editor, range, props }) => {
          props.command({ editor, range, props });
        },
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          // Disable slash menu inside code blocks
          if ($from.parent.type.name === 'codeBlock') {
            return false;
          }
          // With `allowSpaces: true` a query that contains a space no longer
          // terminates the suggestion on its own, so a space-bearing query that
          // matches nothing (e.g. "/todo abc") would otherwise keep an empty
          // popup logically active and leave the literal "/todo abc" text in the
          // document, only dismissable via Escape. Deactivate the suggestion when
          // no item matches the current query: returning false here removes the
          // decoration, fires the popup's `onExit`, and lets subsequent keystrokes
          // pass through normally — restoring the pre-`allowSpaces` behavior for
          // non-matching queries while keeping multi-word matches (e.g.
          // "/Heading 1") working.
          const query = state.doc.textBetween(range.from + 1, range.to);
          const groups = suggestionItemsForQuery(query);
          const hasMatches = Object.values(groups).some(
            (items) => items.length > 0,
          );
          return hasMatches;
        },
      } as Partial<SuggestionOptions>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        pluginKey: slashMenuPluginKey,
        ...this.options.suggestion,
        editor: this.editor,
      }),
    ];
  },
});

const SlashCommand = Command.configure({
  suggestion: {
    // Share the per-query memo with `allow` so the pair of same-query calls in a
    // single keystroke rebuilds the list once (#343, PART 7).
    items: ({ query }: { query: string }) => suggestionItemsForQuery(query),
    render: renderItems,
  },
});

export { Command as SlashCommandExtension };
export default SlashCommand;
