import { Table } from "@tiptap/extension-table";
import {
  Editor,
  getRenderedAttributes,
  mergeAttributes,
  type ExtensionAttribute,
} from "@tiptap/core";
import { DOMOutputSpec, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import {
  cellAround,
  columnResizing,
  columnResizingPluginKey,
} from "@tiptap/pm/tables";
import { TableView } from "./table-view";

const LIST_TYPES = ["bulletList", "orderedList", "taskList"];

function isInList(editor: Editor): boolean {
  const { $from } = editor.state.selection;

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (LIST_TYPES.includes(node.type.name)) {
      return true;
    }
  }

  return false;
}

function handleListIndent(editor: Editor): boolean {
  return (
    editor.commands.sinkListItem("listItem") ||
    editor.commands.sinkListItem("taskItem")
  );
}

function handleListOutdent(editor: Editor): boolean {
  return (
    editor.commands.liftListItem("listItem") ||
    editor.commands.liftListItem("taskItem")
  );
}

export const CustomTable = Table.extend({

  // Upstream (@tiptap/extension-table) gates the column-resizing plugin on
  // `this.options.resizable && this.editor.isEditable`. `addProseMirrorPlugins`
  // runs exactly ONCE, at editor construction, and the body editor in
  // page-editor.tsx is deliberately constructed with a constant
  // `editable: false` (local-first Ф7 — it stops the editor being destroyed and
  // recreated when /pages/info lands). Editability is flipped afterwards via
  // `setEditable`, which does NOT rebuild the plugin set, so `isResizable` was
  // permanently false and columnResizing was never installed: no resize
  // handles, no draggable column borders, ever.
  //
  // The fix is to gate on `this.options.resizable` ALONE. That is safe because
  // prosemirror-tables guards columnResizing at RUNTIME instead: handleMouseMove,
  // handleMouseLeave and handleMouseDown all early-return on `!view.editable`,
  // and the resize handle is a decoration that is only produced once a handle is
  // active. In a read-only editor the plugin is therefore inert.
  addProseMirrorPlugins() {
    // Everything except columnResizing comes from the parent verbatim, so
    // tableEditing keeps exactly upstream's configuration and any plugin
    // upstream adds later is inherited for free. The parent DOES include a
    // columnResizing of its own whenever the editor happens to be editable at
    // construction time, so it is filtered out here — otherwise the plugin
    // would be registered twice (ProseMirror rejects duplicate plugin keys).
    const inherited = (this.parent?.() ?? []).filter(
      (plugin) => plugin.spec?.key !== columnResizingPluginKey,
    );

    if (!this.options.resizable) {
      return inherited;
    }

    // Upstream's order: columnResizing before tableEditing.
    return [
      columnResizing({
        handleWidth: this.options.handleWidth,
        cellMinWidth: this.options.cellMinWidth,
        // Mirrors upstream, which passes cellMinWidth for both knobs.
        defaultCellMinWidth: this.options.cellMinWidth,
        lastColumnResizable: this.options.lastColumnResizable,
        // DELIBERATE: `null` tells prosemirror-tables to install NO table node
        // view of its own (`if (View && nodeViews)` in the plugin's state.init
        // — `null` is the documented opt-out). The table node view is owned by
        // `addNodeView()` below, which is what stops the 150 Hz DOM-repair loop
        // (af06bab6); leaving the default `View` here would create a second
        // owner for the same node. Ours would still win — tiptap passes
        // extension node views as a direct `EditorView._props.nodeViews` entry
        // and `someProp` consults `_props` before plugin props — but "wins by
        // lookup order" is a latent trap, so the competing owner is removed
        // outright rather than merely out-ranked. Nothing is lost: the live
        // drag preview (`displayColumnWidth`) walks up to the <table> element
        // from `view.domAtPos` and rewrites the colgroup directly, without
        // going through any node view, and the committed colwidth attrs are
        // re-rendered by TableView.update().
        //
        // Consequence worth knowing: upstream's `TableOptions.View` is now
        // deliberately NOT forwarded, so `CustomTable.configure({ View })` is a
        // no-op. The table node view is not configurable from the outside any
        // more — it is `addNodeView()` below, always.
        View: null,
      }),
      ...inherited,
    ];
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      "Mod-a": () => {
        const { state, view } = this.editor;
        const { selection, doc } = state;

        const $cellPos = cellAround(selection.$anchor);
        if (!$cellPos) return false;

        const cellNode = doc.nodeAt($cellPos.pos);
        // Empty cells have nothing useful to scope to — let the default
        // Mod-a fall through and select the whole doc.
        if (!cellNode || !cellNode.textContent) return false;

        const from = $cellPos.pos + 1;
        const to = $cellPos.pos + cellNode.nodeSize - 1;
        if (from >= to) return true;

        const nextSel = TextSelection.between(
          doc.resolve(from),
          doc.resolve(to),
          1,
        );
        if (!nextSel || selection.eq(nextSel)) return true;

        view.dispatch(state.tr.setSelection(nextSel));
        return true;
      },
      Tab: () => {
        // If we're in a list within a table, handle list indentation
        if (isInList(this.editor) && this.editor.isActive("table")) {
          if (handleListIndent(this.editor)) {
            return true;
          }
        }

        // Otherwise, use default table navigation
        if (this.editor.commands.goToNextCell()) {
          return true;
        }

        if (!this.editor.can().addRowAfter()) {
          return false;
        }

        return this.editor.chain().addRowAfter().goToNextCell().run();
      },
      "Shift-Tab": () => {
        // If we're in a list within a table, handle list outdentation
        if (isInList(this.editor) && this.editor.isActive("table")) {
          if (handleListOutdent(this.editor)) {
            return true;
          }
        }

        // Otherwise, use default table navigation
        return this.editor.commands.goToPreviousCell();
      },
    };
  },

  // Without a node view the table node is rendered straight from renderHTML,
  // so ProseMirror uses its DEFAULT ignoreMutation (`!this.contentDOM && type
  // != "selection"`, i.e. false for every mutation on a node that HAS a
  // contentDOM). Every attribute write on `.tableWrapper` — the header-pin
  // controller's class toggles, for instance — was then seen as a foreign DOM
  // change, and ProseMirror "repaired" it by re-rendering the whole table.
  // That destroyed the wrapper, which destroyed the pin controller, whose
  // freshly-built replacement re-applied the same classes: a self-feeding loop
  // that ran `view.updateState` ~150x/second at idle and kept header pinning
  // permanently broken. Installing TableView makes the wrapper owned by a node
  // view that ignores mutations outside its contentDOM, which breaks the loop.
  addNodeView() {
    const options = this.options;
    // Constant for the editor's lifetime, so it is resolved ONCE here rather
    // than inside the per-node closure below — which runs on every update() of
    // every table, i.e. on every keystroke inside a table.
    const extensionAttributes: ExtensionAttribute[] =
      this.editor?.extensionManager?.attributes?.filter(
        (attribute) => attribute.type === this.name,
      ) ?? [];

    return ({ node, HTMLAttributes }) => {
      // Rendered attributes must be recomputed per node: the node view has to
      // re-apply them in update() when the node's attrs change, and tiptap
      // computes `HTMLAttributes` only once, for the constructor call.
      const renderAttributes = (current: ProseMirrorNode) => {
        // The same attribute set tiptap itself would render for this node.
        // When the table node declares no attributes at all (the case in this
        // repo today, and whenever `addNodeView` is invoked without a live
        // extension manager, e.g. in tests), `getRenderedAttributes` has
        // nothing to work from, so the initial `HTMLAttributes` is reused —
        // "keep what the first render produced" instead of "drop everything".
        const rendered = extensionAttributes.length
          ? getRenderedAttributes(current, extensionAttributes)
          : HTMLAttributes;

        // Mirrors renderHTML, which merges the extension-level HTMLAttributes
        // option with the node's own rendered attributes.
        return mergeAttributes(options.HTMLAttributes ?? {}, rendered ?? {});
      };

      return new TableView(node, options.cellMinWidth, { renderAttributes });
    };
  },

  // Kept as the source of truth for getHTML(), the clipboard, export and every
  // static (non-EditorView) render. The node view above must build the same
  // shape (div.tableWrapper > table > colgroup + tbody, same attributes), and
  // that parity is NOT maintained by hand: `table-view.test.ts` mounts a real
  // editor and compares the live wrapper against `editor.getHTML()`, so an
  // upstream change to the parent renderHTML/createColGroup fails a test
  // instead of drifting silently.
  renderHTML({ node, HTMLAttributes }) {
    // https://github.com/ueberdosis/tiptap/issues/4872#issuecomment-2717554498
    const originalRender = this.parent?.({ node, HTMLAttributes });
    const wrapper: DOMOutputSpec = [
      "div",
      { class: "tableWrapper" },
      originalRender,
    ];
    return wrapper;
  },
});
