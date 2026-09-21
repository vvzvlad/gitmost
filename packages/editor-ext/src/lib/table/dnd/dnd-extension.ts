import { Editor, Extension } from "@tiptap/core";
import { PluginKey, Plugin, PluginSpec, TextSelection, Transaction } from "@tiptap/pm/state";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorProps, EditorView } from "@tiptap/pm/view";
import { columnResizingPluginKey } from "@tiptap/pm/tables";
import { cellAround } from "@tiptap/pm/tables";
import {
  cellInfoFromResolvedCell,
  DraggingDOMs,
  getDndRelatedDOMs,
  getHoveringCell,
  HoveringCellInfo,
} from "./utils";
import { getDragOverColumn, getDragOverRow } from "./calc-drag-over";
import { findTable } from "../utils/query";
import { moveColumn, moveRow } from "../utils";
import { PreviewController } from "./preview/preview-controller";
import { DropIndicatorController } from "./preview/drop-indicator-controller";

export interface TableHandleState {
  hoveringCell: HoveringCellInfo | null;
  tableNode: ProseMirrorNode | null;
  tablePos: number | null;
  dragging: { orientation: "col" | "row"; index: number } | null;
  frozen: boolean;
}

const INITIAL_STATE: TableHandleState = {
  hoveringCell: null,
  tableNode: null,
  tablePos: null,
  dragging: null,
  frozen: false,
};

export const TableDndKey = new PluginKey<TableHandleState>("table-handles");

// How long a blur waits before it drops the handles. A click on a floating
// handle (or its menu target) blurs the editor BEFORE the click handler runs,
// and Safari does not even move focus to the clicked div — so we cannot decide
// from `relatedTarget`/`activeElement`. Instead we wait a beat and re-check the
// plugin state: by then a menu has set `frozen` and a drag has set `dragging`.
const BLUR_CLEAR_DELAY_MS = 250;
// A pointer-down flag backed by an event this recent is trusted as live state.
// Sized above the gap between the pointermove bursts of an actively moving
// pointer (tens of ms) and well under a deliberate press-and-hold pause, so a
// user who keeps interacting always reads as "fresh". Older than this we no
// longer trust the flag either way — see _flushBlurClear.
const STALE_POINTER_MS = 1500;

export class TableHandlePluginSpec implements PluginSpec<TableHandleState> {
  key = TableDndKey;
  props: EditorProps<Plugin<TableHandleState>>;

  private _previewController: PreviewController;
  private _dropIndicatorController: DropIndicatorController;

  private _hoveringCell?: HoveringCellInfo;
  private _disposables: (() => void)[] = [];
  private _draggingDirection: "col" | "row" = "col";
  private _draggingIndex = -1;
  private _droppingIndex = -1;
  private _draggingDOMs?: DraggingDOMs;
  private _startCoords = { x: 0, y: 0 };
  private _dragging = false;
  private _blurClearTimer: ReturnType<typeof setTimeout> | null = null;
  // A clear that is waiting for the pointer to be released rather than for a
  // timer. Parked state: no timer is running, the next pointer event resumes it.
  private _blurClearDeferred = false;
  private _pointerIsDown = false;
  private _lastPointerEventAt = 0;

  state = {
    init: (): TableHandleState => INITIAL_STATE,
    apply: (tr: Transaction, prev: TableHandleState): TableHandleState => {
      const meta = tr.getMeta(TableDndKey) as Partial<TableHandleState> | null;
      if (!meta) return prev;
      let changed = false;
      for (const key in meta) {
        if (!Object.is(prev[key as keyof TableHandleState], meta[key as keyof TableHandleState])) {
          changed = true;
          break;
        }
      }
      return changed ? { ...prev, ...meta } : prev;
    },
  };

  constructor(public editor: Editor) {
    this.props = {
      handleDOMEvents: {
        pointermove: this._pointerMove,
        // Force-unfreeze on any pointerdown that lands on the editor.
        // Mantine's `Menu.onClose` doesn't always fire on outside click
        // (the dropdown vanishes visually but the callback is skipped),
        // which would otherwise leave `frozen=true` permanently.
        pointerdown: this._pointerDown,
      },
    };

    this._previewController = new PreviewController();
    this._dropIndicatorController = new DropIndicatorController();
  }

  view = () => {
    const wrapper = this.editor.options.element;
    // @ts-ignore
    wrapper.appendChild(this._previewController.previewRoot);
    // @ts-ignore
    wrapper.appendChild(this._dropIndicatorController.dropIndicatorRoot);

    // Track the cursor cell so handles follow keyboard nav and clicks too.
    this.editor.on("selectionUpdate", this._onSelectionUpdate);
    this._disposables.push(() =>
      this.editor.off("selectionUpdate", this._onSelectionUpdate),
    );

    // Drop the handles when the editor loses focus. Without this, a single
    // click into any cell leaves `hoveringCell` set for the rest of the
    // session (there is no time- or focus-based clear), which keeps the three
    // floating handles — and their `autoUpdate` watchers — mounted forever.
    this.editor.on("blur", this._onBlur);
    this._disposables.push(() => this.editor.off("blur", this._onBlur));
    this.editor.on("focus", this._onFocus);
    this._disposables.push(() => this.editor.off("focus", this._onFocus));

    // Pointer-down tracking for the blur clear. The flag is derived from
    // `event.buttons` on EVERY pointer event rather than latched by
    // pointerdown/pointerup: pragmatic-dnd drags via native HTML5 DnD, and
    // during a native drag the browser stops delivering pointer events and
    // WebKit is not reliable about `pointercancel`. So the flag must be
    // self-healing (any later pointer event with no button pressed clears it)
    // and backed by `dragend` / `lostpointercapture` / window blur.
    if (typeof document !== "undefined") {
      const pointerEvents = [
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
      ];
      for (const type of pointerEvents) {
        document.addEventListener(type, this._onDocumentPointerEvent, true);
      }
      document.addEventListener("dragend", this._releasePointer, true);
      document.addEventListener("drop", this._releasePointer, true);
      document.addEventListener("lostpointercapture", this._releasePointer, true);
      if (typeof window !== "undefined") {
        window.addEventListener("blur", this._releasePointer);
      }
      this._disposables.push(() => {
        for (const type of pointerEvents) {
          document.removeEventListener(type, this._onDocumentPointerEvent, true);
        }
        document.removeEventListener("dragend", this._releasePointer, true);
        document.removeEventListener("drop", this._releasePointer, true);
        document.removeEventListener(
          "lostpointercapture",
          this._releasePointer,
          true,
        );
        if (typeof window !== "undefined") {
          window.removeEventListener("blur", this._releasePointer);
        }
      });
    }

    return {
      destroy: this.destroy,
    };
  };

  destroy = () => {
    this._cancelBlurClear();
    this._previewController.destroy();
    this._dropIndicatorController.destroy();
    this._disposables.forEach((d) => d());
  };

  private _onDocumentPointerEvent = (event: Event) => {
    // `buttons` is a bitmask of the CURRENTLY pressed buttons, so it is true
    // state rather than an edge — a stale `true` heals on the next pointer
    // event, whatever we missed in between.
    const buttons = (event as PointerEvent).buttons;
    this._pointerIsDown = typeof buttons === "number" ? buttons !== 0 : false;
    this._lastPointerEventAt = Date.now();
    this._resumeDeferredBlurClear();
  };

  private _releasePointer = () => {
    this._pointerIsDown = false;
    this._lastPointerEventAt = Date.now();
    this._resumeDeferredBlurClear();
  };

  // Restart a clear that parked itself waiting for the pointer to come up.
  private _resumeDeferredBlurClear = () => {
    if (!this._blurClearDeferred) return;
    if (this._pointerIsDown) return;
    this._blurClearDeferred = false;
    if (this._blurClearTimer === null) {
      this._blurClearTimer = setTimeout(
        this._flushBlurClear,
        BLUR_CLEAR_DELAY_MS,
      );
    }
  };

  private _cancelBlurClear = () => {
    this._blurClearDeferred = false;
    if (this._blurClearTimer === null) return;
    clearTimeout(this._blurClearTimer);
    this._blurClearTimer = null;
  };

  /**
   * Cancel a pending clear and, if the blur already cleared the handles
   * (alt-tab away, come back), re-derive them from the caret's cell.
   * `selectionUpdate` does not fire on refocus, so without this the handles
   * stay gone until the next pointermove or arrow key. `_onSelectionUpdate`
   * carries the right guards (editable / frozen / dragging / unchanged-cell)
   * and is a no-op when the caret is not in a cell.
   */
  private _onFocus = () => {
    this._cancelBlurClear();
    this._onSelectionUpdate();
  };

  private _onBlur = () => {
    this._cancelBlurClear();
    this._blurClearTimer = setTimeout(this._flushBlurClear, BLUR_CLEAR_DELAY_MS);
  };

  /**
   * Clear the handle state after a blur — but only if the blur really ended
   * the interaction. We bail out when the editor got focus back, while a menu
   * holds the handles (`frozen`) or a drag is in flight (`dragging`), and
   * while a pointer is still down (a click-and-hold on a handle that has not
   * become a drag yet). Same early-return-when-already-clear idiom as
   * `_pointerMove`, so a blurred editor does not dispatch a transaction on
   * every blur forever.
   *
   * The pointer wait TERMINATES BY CONSTRUCTION without ever cancelling a
   * drag the user is about to start:
   *
   *  - pointer down and BACKED BY A RECENT EVENT (< STALE_POINTER_MS): the
   *    interaction is live, so re-arm the timer and keep waiting.
   *  - pointer down but the last pointer event is OLD: this is either a
   *    motionless press-and-hold on a grip (the user deciding where to drop —
   *    clearing here would unmount the `draggable` element and make the drag
   *    impossible) or a flag left stuck by a native HTML5 drag that swallowed
   *    the pointer events / a button released outside the window. The two are
   *    indistinguishable from timestamps, so we do NEITHER: we PARK. No timer
   *    is left running (no perpetual 250ms wakeup), and the next pointer event
   *    resumes the clear — which is exactly when the hold ends and when a
   *    stuck flag heals via `event.buttons`.
   *
   * So every path reaches a terminal state: cleared, cancelled by refocus or
   * destroy, or parked with nothing running.
   */
  private _flushBlurClear = () => {
    this._blurClearTimer = null;
    if (this.editor.isDestroyed) {
      this._blurClearDeferred = false;
      return;
    }
    if (this.editor.isFocused) {
      this._blurClearDeferred = false;
      return;
    }
    if (this._pointerIsDown) {
      if (Date.now() - this._lastPointerEventAt < STALE_POINTER_MS) {
        this._blurClearTimer = setTimeout(
          this._flushBlurClear,
          BLUR_CLEAR_DELAY_MS,
        );
        return;
      }
      this._blurClearDeferred = true;
      return;
    }
    this._blurClearDeferred = false;

    const current = TableDndKey.getState(this.editor.state);
    if (current?.frozen || current?.dragging) return;
    if (
      current?.hoveringCell == null &&
      current?.tableNode == null &&
      current?.tablePos == null
    ) {
      return;
    }

    this._hoveringCell = undefined;
    this._dispatchMeta({ hoveringCell: null, tableNode: null, tablePos: null });
  };

  private _pointerDown = (view: EditorView, _event: PointerEvent): boolean => {
    const current = TableDndKey.getState(view.state);
    if (current?.frozen) this.editor.commands.unfreezeHandles();
    return false;
  };

  private _pointerMove = (view: EditorView, event: PointerEvent) => {
    const current = TableDndKey.getState(view.state);
    if (current?.frozen || current?.dragging) return;

    const resizeState = columnResizingPluginKey.getState(view.state);
    if (resizeState?.dragging) return;

    if (!this.editor.isEditable) {
      if (current?.hoveringCell == null && current?.tableNode == null && current?.tablePos == null) return;
      this._dispatchMeta({ hoveringCell: null, tableNode: null, tablePos: null });
      return;
    }

    const hoveringCell = getHoveringCell(view, event);
    if (hoveringCell) {
      if (current?.hoveringCell?.cellPos === hoveringCell.cellPos) return;
      this._hoveringCell = hoveringCell;
      const $cell = view.state.doc.resolve(hoveringCell.cellPos);
      const tableInfo = findTable($cell);
      this._dispatchMeta({
        hoveringCell,
        tableNode: tableInfo?.node ?? null,
        tablePos: tableInfo?.pos ?? null,
      });
      return;
    }

    // Pointer isn't over a cell but may be transiting toward a handle that
    // floats outside the cell — fall back to the selection's cell so the
    // handles stay visible.
    const $cellPos = cellAround(view.state.selection.$head);
    if ($cellPos) {
      const cellInfo = cellInfoFromResolvedCell($cellPos);
      if (current?.hoveringCell?.cellPos === cellInfo.cellPos) return;
      this._hoveringCell = cellInfo;
      const tableInfo = findTable($cellPos);
      this._dispatchMeta({
        hoveringCell: cellInfo,
        tableNode: tableInfo?.node ?? null,
        tablePos: tableInfo?.pos ?? null,
      });
      return;
    }

    this._hoveringCell = undefined;
    if (current?.hoveringCell == null && current?.tableNode == null && current?.tablePos == null) return;
    this._dispatchMeta({ hoveringCell: null, tableNode: null, tablePos: null });
  };

  private _onSelectionUpdate = () => {
    if (!this.editor.isEditable) return;

    const current = TableDndKey.getState(this.editor.state);
    if (current?.frozen || current?.dragging) return;

    const $cellPos = cellAround(this.editor.state.selection.$head);
    if (!$cellPos) return;

    const cellInfo = cellInfoFromResolvedCell($cellPos);
    if (current?.hoveringCell?.cellPos === cellInfo.cellPos) return;

    this._hoveringCell = cellInfo;
    const tableInfo = findTable($cellPos);
    this._dispatchMeta({
      hoveringCell: cellInfo,
      tableNode: tableInfo?.node ?? null,
      tablePos: tableInfo?.pos ?? null,
    });
  };

  private _dispatchMeta = (patch: Partial<TableHandleState>) => {
    const tr = this.editor.state.tr.setMeta(TableDndKey, patch);
    tr.setMeta("addToHistory", false);
    this.editor.view.dispatch(tr);
  };

  // ---- Public API for the React handle layer ----

  // Returns true if the drag was set up successfully.
  startDragFromHandle = (
    orientation: "col" | "row",
    clientX: number,
    clientY: number,
  ): boolean => {
    if (!this._hoveringCell) return false;
    this._dragging = true;
    this._draggingDirection = orientation;
    this._startCoords = { x: clientX, y: clientY };

    const draggingIndex =
      (orientation === "col"
        ? this._hoveringCell.colIndex
        : this._hoveringCell.rowIndex) ?? 0;
    this._draggingIndex = draggingIndex;

    const relatedDoms = getDndRelatedDOMs(
      this.editor.view,
      this._hoveringCell.cellPos,
      draggingIndex,
      orientation,
    );
    if (!relatedDoms) {
      this._dragging = false;
      return false;
    }
    this._draggingDOMs = relatedDoms;

    this._previewController.onDragStart(relatedDoms, draggingIndex, orientation);
    this._dropIndicatorController.onDragStart(relatedDoms, orientation);

    // Park the selection inside the dragged cell unless it's already in the
    // same table. PM auto-maps `selection.from` through concurrent remote
    // transactions, so commitDrop can resolve the table even if the doc
    // shifted mid-drag — same trick the pre-pragmatic-dnd implementation
    // relied on.
    const state = this.editor.state;
    const currentTable = findTable(state.selection.$from);
    const hoverTable = (() => {
      try {
        return findTable(state.doc.resolve(this._hoveringCell.cellPos));
      } catch {
        return undefined;
      }
    })();
    const tr = state.tr;
    if (
      hoverTable &&
      (!currentTable || currentTable.pos !== hoverTable.pos)
    ) {
      try {
        const $inside = state.doc.resolve(this._hoveringCell.cellPos + 1);
        tr.setSelection(TextSelection.near($inside, 1));
      } catch {}
    }
    tr.setMeta(TableDndKey, {
      dragging: { orientation, index: draggingIndex },
    });
    tr.setMeta("addToHistory", false);
    this.editor.view.dispatch(tr);
    return true;
  };

  updateDragPosition = (clientX: number, clientY: number) => {
    const draggingDOMs = this._draggingDOMs;
    if (!draggingDOMs || !this._dragging) return;

    if (this._draggingDirection === "col") {
      this._previewController.onDragging(
        draggingDOMs,
        clientX,
        clientY,
        "col",
      );
      const direction = this._startCoords.x > clientX ? "left" : "right";
      const dragOverColumn = getDragOverColumn(draggingDOMs.table, clientX);
      if (!dragOverColumn) return;
      const [col, index] = dragOverColumn;
      this._droppingIndex = index;
      this._dropIndicatorController.onDragging(col, direction, "col");
      return;
    }

    this._previewController.onDragging(draggingDOMs, clientX, clientY, "row");
    const direction = this._startCoords.y > clientY ? "up" : "down";
    const dragOverRow = getDragOverRow(draggingDOMs.table, clientY);
    if (!dragOverRow) return;
    const [row, index] = dragOverRow;
    this._droppingIndex = index;
    this._dropIndicatorController.onDragging(row, direction, "row");
  };

  commitDrop = () => {
    if (!this._dragging) return;
    const direction = this._draggingDirection;
    const from = this._draggingIndex;
    const to = this._droppingIndex;

    if (from < 0 || to < 0 || from === to) return;

    // Use the live (auto-mapped) selection as the table anchor — PM has
    // already mapped it through any concurrent remote transactions, so
    // it's safe to resolve even if the doc shifted mid-drag.
    const tr = this.editor.state.tr;
    const pos = this.editor.state.selection.from;

    if (direction === "col") {
      if (moveColumn({ tr, originIndex: from, targetIndex: to, select: true, pos })) {
        this.editor.view.dispatch(tr);
      }
      return;
    }
    if (moveRow({ tr, originIndex: from, targetIndex: to, select: true, pos })) {
      this.editor.view.dispatch(tr);
    }
  };

  endDrag = () => {
    this._dragging = false;
    this._draggingIndex = -1;
    this._droppingIndex = -1;
    this._startCoords = { x: 0, y: 0 };
    this._draggingDOMs = undefined;
    this._dropIndicatorController.onDragEnd();
    this._previewController.onDragEnd();
    this._dispatchMeta({ dragging: null });
  };
}

// Resolve via plugin key, not a module singleton — survives StrictMode / HMR.
export function getTableHandlePluginSpec(
  editor: Editor,
): TableHandlePluginSpec | null {
  const plugin = TableDndKey.get(editor.state);
  if (!plugin) return null;
  return plugin.spec as unknown as TableHandlePluginSpec;
}

export const TableDndExtension = Extension.create({
  name: "table-drag-and-drop",
  addProseMirrorPlugins() {
    const editor = this.editor;
    const spec = new TableHandlePluginSpec(editor);
    return [new Plugin(spec)];
  },
});

export const TableHandleCommandsExtension = Extension.create({
  name: "table-handle-commands",
  addCommands() {
    return {
      freezeHandles:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(TableDndKey, { frozen: true });
            tr.setMeta("addToHistory", false);
          }
          return true;
        },
      unfreezeHandles:
        () =>
        ({ tr, state, dispatch }) => {
          if (dispatch) {
            // Re-sync `hoveringCell` to the cursor's cell as we unfreeze:
            // `selectionUpdate` was gated while frozen, so the stored
            // hoveringCell may be stale.
            const patch: Partial<TableHandleState> = { frozen: false };
            const $cellPos = cellAround(state.selection.$head);
            if ($cellPos) {
              const cellInfo = cellInfoFromResolvedCell($cellPos);
              const tableInfo = findTable($cellPos);
              patch.hoveringCell = cellInfo;
              patch.tableNode = tableInfo?.node ?? null;
              patch.tablePos = tableInfo?.pos ?? null;
            } else {
              patch.hoveringCell = null;
              patch.tableNode = null;
              patch.tablePos = null;
            }
            tr.setMeta(TableDndKey, patch);
            tr.setMeta("addToHistory", false);
          }
          return true;
        },
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableHandleCommands: {
      freezeHandles: () => ReturnType;
      unfreezeHandles: () => ReturnType;
    };
  }
}
