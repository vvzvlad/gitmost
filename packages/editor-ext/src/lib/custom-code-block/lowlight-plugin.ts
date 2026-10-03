import { findChildren } from '@tiptap/core';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
// @ts-ignore
import highlight from 'highlight.js/lib/core';

function parseNodes(
  nodes: any[],
  className: string[] = [],
): { text: string; classes: string[] }[] {
  return nodes
    .map((node) => {
      const classes = [
        ...className,
        ...(node.properties ? node.properties.className : []),
      ];

      if (node.children) {
        return parseNodes(node.children, classes);
      }

      return {
        text: node.value,
        classes,
      };
    })
    .flat();
}

function getHighlightNodes(result: any) {
  // `.value` for lowlight v1, `.children` for lowlight v2
  return result.value || result.children || [];
}

function registered(aliasOrLanguage: string) {
  return Boolean(highlight.getLanguage(aliasOrLanguage));
}

// Max characters to sample for auto-detection to avoid performance issues with large code blocks
const AUTO_DETECT_SAMPLE_SIZE = 3000;

type HighlightTokens = { text: string; classes: string[] }[];

// Highlight results keyed by `${language}\u0000${textContent}`, where language
// is the registered language the block is highlighted with, or '' for
// auto-detection.
type HighlightCache = Map<string, HighlightTokens>;

type LowlightState = {
  decorations: DecorationSet;
  highlights: HighlightCache;
};

function getDecorations({
  doc,
  name,
  lowlight,
  defaultLanguage,
  highlights,
}: {
  doc: ProsemirrorNode;
  name: string;
  lowlight: any;
  defaultLanguage: string | null | undefined;
  highlights: HighlightCache;
}): LowlightState {
  const decorations: Decoration[] = [];
  // Only the blocks of THIS doc are carried into the next cache, so it never
  // holds more than the document's own code blocks.
  const nextHighlights: HighlightCache = new Map();

  findChildren(doc, (node) => node.type.name === name).forEach((block) => {
    let from = block.pos + 1;
    const language = block.node.attrs.language || defaultLanguage;
    const languages = lowlight.listLanguages();
    const textContent = block.node.textContent;
    const highlightLanguage =
      language &&
      (languages.includes(language) ||
        registered(language) ||
        lowlight.registered?.(language))
        ? language
        : '';
    const cacheKey = `${highlightLanguage}\u0000${textContent}`;

    let tokens = nextHighlights.get(cacheKey) ?? highlights.get(cacheKey);
    if (!tokens) {
      let nodes;
      if (highlightLanguage) {
        nodes = getHighlightNodes(
          lowlight.highlight(highlightLanguage, textContent),
        );
      } else {
        // For auto-detection, sample a limited portion to detect the language,
        // then highlight the full content with the detected language
        const sample =
          textContent.length > AUTO_DETECT_SAMPLE_SIZE
            ? textContent.slice(0, AUTO_DETECT_SAMPLE_SIZE)
            : textContent;
        const autoResult = lowlight.highlightAuto(sample);
        const detectedLanguage = autoResult.data?.language;
        if (detectedLanguage && textContent.length > AUTO_DETECT_SAMPLE_SIZE) {
          nodes = getHighlightNodes(
            lowlight.highlight(detectedLanguage, textContent),
          );
        } else {
          nodes = getHighlightNodes(autoResult);
        }
      }
      tokens = parseNodes(nodes);
    }
    nextHighlights.set(cacheKey, tokens);

    tokens.forEach((node) => {
      const to = from + node.text.length;

      if (node.classes.length) {
        const decoration = Decoration.inline(from, to, {
          class: node.classes.join(' '),
        });

        decorations.push(decoration);
      }

      from = to;
    });
  });

  return {
    decorations: DecorationSet.create(doc, decorations),
    highlights: nextHighlights,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function isFunction(param: any): param is Function {
  return typeof param === 'function';
}

export function LowlightPlugin({
  name,
  lowlight,
  defaultLanguage,
  onHighlight,
}: {
  name: string;
  lowlight: any;
  defaultLanguage: string | null | undefined;
  // #683 `code_highlight` — optional timing hook, invoked with the wall-clock ms
  // of a REAL decoration recompute (init + the guarded apply recompute below),
  // NOT on every transaction (#343): a plain keystroke that maps the existing
  // decoration set never calls getDecorations, so it never fires this. The host
  // (apps/client) reports it as `operation_ms{op=code_highlight}`; when it passes
  // no callback (telemetry off) there is zero timing cost. editor-ext cannot
  // import the client telemetry module, so the report is injected as a callback.
  onHighlight?: (durationMs: number) => void;
}) {
  if (
    !['highlight', 'highlightAuto', 'listLanguages'].every((api) =>
      isFunction(lowlight[api]),
    )
  ) {
    throw Error(
      'You should provide an instance of lowlight to use the code-block-lowlight extension',
    );
  }

  // Run getDecorations, optionally timing the recompute for the host's telemetry.
  // Timing (two performance.now calls) is skipped entirely when no callback is
  // provided, so a telemetry-off build pays nothing here.
  const runDecorations = (
    doc: ProsemirrorNode,
    highlights: HighlightCache,
  ): LowlightState => {
    if (!onHighlight) {
      return getDecorations({
        doc,
        name,
        lowlight,
        defaultLanguage,
        highlights,
      });
    }
    const start = performance.now();
    const result = getDecorations({
      doc,
      name,
      lowlight,
      defaultLanguage,
      highlights,
    });
    try {
      onHighlight(performance.now() - start);
    } catch {
      // telemetry is best-effort; never let it break decoration rendering.
    }
    return result;
  };

  const lowlightPlugin: Plugin<LowlightState> = new Plugin<LowlightState>({
    key: new PluginKey('lowlight'),

    state: {
      init: (_, { doc }) => runDecorations(doc, new Map()),
      apply: (transaction, pluginState, oldState, newState) => {
        // No doc change: nothing to map and nothing to recompute, so skip the
        // two full-document findChildren walks below.
        if (!transaction.docChanged) return pluginState;

        const oldNodeName = oldState.selection.$head.parent.type.name;
        const newNodeName = newState.selection.$head.parent.type.name;
        const oldNodes = findChildren(
          oldState.doc,
          (node) => node.type.name === name,
        );
        const newNodes = findChildren(
          newState.doc,
          (node) => node.type.name === name,
        );

        if (
          transaction.docChanged &&
          // Apply decorations if:
          // selection includes named node,
          ([oldNodeName, newNodeName].includes(name) ||
            // OR transaction adds/removes named node,
            newNodes.length !== oldNodes.length ||
            // OR transaction has changes that completely encapsulte a node
            // (for example, a transaction that affects the entire document).
            // Such transactions can happen during collab syncing via y-prosemirror, for example.
            transaction.steps.some((step) => {
              // @ts-ignore
              return (
                // @ts-ignore
                step.from !== undefined &&
                // @ts-ignore
                step.to !== undefined &&
                oldNodes.some((node) => {
                  // @ts-ignore
                  return (
                    // @ts-ignore
                    node.pos >= step.from &&
                    // @ts-ignore
                    node.pos + node.node.nodeSize <= step.to
                  );
                })
              );
            }))
        ) {
          // Real recompute path (selection touches a code block, a code block was
          // added/removed, or a full-doc-spanning step). Timed for #683. Blocks
          // whose language and text are unchanged reuse the previous result.
          return runDecorations(transaction.doc, pluginState.highlights);
        }

        // Cheap map of the existing decorations — NOT a recompute; a keystroke
        // outside a code block lands here and is never timed (AC5).
        return {
          decorations: pluginState.decorations.map(
            transaction.mapping,
            transaction.doc,
          ),
          highlights: pluginState.highlights,
        };
      },
    },

    props: {
      decorations(state) {
        return lowlightPlugin.getState(state).decorations;
      },
    },
  });

  return lowlightPlugin;
}
