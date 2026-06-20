import { useEffect } from "react";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import { useAtom } from "jotai";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom.ts";
import { WebSocketEvent } from "@/features/websocket/types";
import { SpaceTreeNode } from "@/features/page/tree/types.ts";
import { useQueryClient } from "@tanstack/react-query";
import { treeModel } from "@/features/page/tree/model/tree-model";
import {
  applyUpdateOne,
  applyAddTreeNode,
  applyMoveTreeNode,
  applyDeleteTreeNode,
} from "@/features/websocket/tree-socket-reducers.ts";
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
            setTreeData((prev) => applyUpdateOne(prev, event));
          }
          break;
        case "addTreeNode":
          setTreeData((prev) => applyAddTreeNode(prev, event.payload));
          break;
        case "moveTreeNode":
          setTreeData((prev) => applyMoveTreeNode(prev, event.payload));
          break;
        case "deleteTreeNode":
          // The `invalidateQueries` side effect stays in the hook; the tree
          // transform (`applyDeleteTreeNode`) is pure. Only invalidate when the
          // node is actually in the tree (mirrors the pure reducer's early-out).
          setTreeData((prev) => {
            if (treeModel.find(prev, event.payload.node.id)) {
              queryClient.invalidateQueries({
                queryKey: ["pages", event.payload.node.slugId].filter(Boolean),
              });
            }
            return applyDeleteTreeNode(prev, event.payload);
          });
          break;
      }
    });
  }, [socket]);
};
