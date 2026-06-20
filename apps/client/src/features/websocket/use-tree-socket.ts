import { useEffect } from "react";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import { useAtom } from "jotai";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { WebSocketEvent } from "@/features/websocket/types";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { useQueryClient } from "@tanstack/react-query";
import { treeModel } from "@/features/page/tree/model/tree-model";
import localEmitter from "@/lib/local-emitter.ts";

export const useTreeSocket = () => {
  const [socket] = useAtom(socketAtom);
  const [, setTreeData] = useAtom(treeDataAtom);
  const queryClient = useQueryClient();

  useEffect(() => {
    const updateNodeName = (event) => {
      if (event.payload?.title === undefined) return;
      setTreeData((prev) => {
        if (!treeModel.find(prev, event?.id)) return prev;
        return treeModel.update(prev, event.id, {
          name: event.payload.title,
        } as Partial<SpaceTreeNode>);
      });
    };

    localEmitter.on("message", updateNodeName);
    return () => {
      localEmitter.off("message", updateNodeName);
    };
  }, []);

  useEffect(() => {
    socket?.on("message", (event: WebSocketEvent) => {
      switch (event.operation) {
        case "updateOne":
          if (event.entity[0] === "pages") {
            setTreeData((prev) => {
              if (!treeModel.find(prev, event.id)) return prev;
              let next = prev;
              if (event.payload?.title !== undefined) {
                next = treeModel.update(next, event.id, {
                  name: event.payload.title,
                } as Partial<SpaceTreeNode>);
              }
              if (event.payload?.icon !== undefined) {
                next = treeModel.update(next, event.id, {
                  icon: event.payload.icon,
                } as Partial<SpaceTreeNode>);
              }
              return next;
            });
          }
          break;
        case "addTreeNode":
          setTreeData((prev) => {
            // Idempotent: the author already inserted the node optimistically,
            // and a node may be re-delivered — never insert a duplicate id.
            if (treeModel.find(prev, event.payload.data.id)) return prev;
            const newParentId = event.payload.parentId as string | null;
            // Insert by `position` among already-loaded siblings (not the
            // sender's absolute index) so order is consistent across clients
            // with different loaded sets.
            let next = treeModel.insertByPosition(
              prev,
              newParentId,
              event.payload.data,
            );
            // Mirror the emitter: flip new parent's hasChildren to true so
            // the chevron renders on the receiver.
            if (newParentId) {
              next = treeModel.update(next, newParentId, {
                hasChildren: true,
              } as Partial<SpaceTreeNode>);
            }
            return next;
          });
          break;
        case "moveTreeNode":
          setTreeData((prev) => {
            const sourceBefore = treeModel.find(prev, event.payload.id);
            if (!sourceBefore) return prev;
            const oldParentId =
              (sourceBefore as SpaceTreeNode).parentPageId ?? null;
            const newParentId = event.payload.parentId as string | null;

            // Place the node by its fractional `position` among the new
            // siblings — NOT by the sender's absolute `index` (the sender
            // computed that against its own loaded set, which differs from
            // this receiver's). Using the position keeps the visible order
            // correct on every client; placing at `index: 0` would wrongly
            // drop reordered/moved nodes at the top of their new sibling list.
            const placed = treeModel.placeByPosition(prev, event.payload.id, {
              parentId: newParentId,
              position: event.payload.position,
            });
            // `placeByPosition` silently returns the same reference if the
            // destination parent isn't loaded on this client. Falling back to
            // removing the source keeps the UI consistent (the source will
            // reappear when the user expands the new parent and lazy-load
            // fetches it).
            if (placed === prev) {
              return treeModel.remove(prev, event.payload.id);
            }

            // Apply the authoritative node fields the move payload carries
            // (`pageData`) so receivers don't keep a stale title/icon/chevron
            // on the moved node. `placeByPosition` already set `position`.
            const pageData = event.payload.pageData as
              | {
                  title?: string | null;
                  icon?: string | null;
                  hasChildren?: boolean;
                }
              | undefined;
            const patch: Partial<SpaceTreeNode> = {
              position: event.payload.position,
              parentPageId: newParentId as string,
            };
            if (pageData) {
              // The tree node stores the title as `name`.
              if (pageData.title !== undefined) patch.name = pageData.title ?? "";
              if (pageData.icon !== undefined)
                patch.icon = pageData.icon ?? undefined;
              if (pageData.hasChildren !== undefined)
                patch.hasChildren = pageData.hasChildren;
            }
            let next = treeModel.update(placed, event.payload.id, patch);

            // Mirror the emitter's hasChildren bookkeeping so both clients
            // converge to the same chevron state.
            if (oldParentId) {
              const oldParent = treeModel.find(next, oldParentId);
              if (!oldParent?.children?.length) {
                next = treeModel.update(next, oldParentId, {
                  hasChildren: false,
                } as Partial<SpaceTreeNode>);
              }
            }
            if (newParentId) {
              next = treeModel.update(next, newParentId, {
                hasChildren: true,
              } as Partial<SpaceTreeNode>);
            }

            return next;
          });
          break;
        case "deleteTreeNode":
          setTreeData((prev) => {
            if (!treeModel.find(prev, event.payload.node.id)) return prev;
            queryClient.invalidateQueries({
              queryKey: ["pages", event.payload.node.slugId].filter(Boolean),
            });
            let next = treeModel.remove(prev, event.payload.node.id);
            // Mirror the emitter's hasChildren bookkeeping so both clients
            // converge to the same chevron state when the last child is deleted.
            const parentPageId = event.payload.node.parentPageId;
            if (parentPageId) {
              const parent = treeModel.find(next, parentPageId);
              if (!parent?.children?.length) {
                next = treeModel.update(next, parentPageId, {
                  hasChildren: false,
                } as Partial<SpaceTreeNode>);
              }
            }
            return next;
          });
          break;
      }
    });
  }, [socket]);
};
