import { UseMutationResult } from "@tanstack/react-query";
import {
  IAiMcpServer,
  IAiMcpServerCreate,
  IAiMcpServerUpdate,
  IAiMcpServerTestResult,
} from "./mcp-server-types.ts";

// Mutation-hook contract shared by the reusable MCP row/form/modal (#686).
//
// The row and form OWN their mutation instances (a per-row `test` mutation so
// each row's inline result/loading is independent; the form's own create/update
// so the modal's saving state is local), so they take the hook FUNCTIONS — not
// pre-built mutation results — and call them internally. The admin path passes
// the `/workspace/ai-mcp-servers*` hooks and the personal path passes the
// `/account/mcp-servers*` hooks; the wiring (state derivation, remount key,
// write-only header semantics) exists exactly once.
//
// The `use*` names are load-bearing: they let eslint's rules-of-hooks treat the
// props as hooks (called unconditionally, in stable order, every render).
export type UseCreateMcpServerMutation = () => UseMutationResult<
  IAiMcpServer,
  Error,
  IAiMcpServerCreate
>;

export type UseUpdateMcpServerMutation = () => UseMutationResult<
  IAiMcpServer,
  Error,
  IAiMcpServerUpdate
>;

export type UseTestMcpServerMutation = () => UseMutationResult<
  IAiMcpServerTestResult,
  Error,
  string
>;
