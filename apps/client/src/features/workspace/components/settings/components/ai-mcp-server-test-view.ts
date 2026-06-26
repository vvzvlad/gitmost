import type { IAiMcpServerTestResult } from "@/features/workspace/services/ai-mcp-server-service.ts";

/** Minimal translator shape (i18next `t`): key + optional interpolation. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Subset of an axios-style rejection we read for the reject tooltip. */
type McpTestRequestError = {
  response?: { data?: { message?: string } };
};

/**
 * Best-effort extraction of a server-sent message from a rejected test request
 * (axios stores it at `error.response.data.message`). Returns undefined for a
 * bare/network error so the caller can fall back to a generic label.
 */
function readRequestErrorMessage(error: unknown): string | undefined {
  if (error && typeof error === "object" && "response" in error) {
    return (error as McpTestRequestError).response?.data?.message;
  }
  return undefined;
}

/**
 * Presentation for the inline "Test" button, derived from the current test
 * result tristate (no result yet / ok / failed). Color is never the only signal
 * — the label and icon change too (a11y / colorblind-friendly). Kept as a single
 * pure derivation (rather than two parallel if/else chains) so the button and
 * tooltip can never drift apart, and so the text branches are unit-testable
 * without rendering the row.
 */
export interface McpTestButtonView {
  /** Tristate; the component maps this to the leftSection icon. */
  state: "idle" | "ok" | "failed";
  /** Mantine Button color; undefined = theme default (idle). */
  color?: string;
  /** Mantine Button variant. */
  variant: string;
  /** Translated button label. */
  label: string;
  /** Translated tooltip text; "" while there is no result (tooltip disabled). */
  tooltip: string;
}

export function mcpTestButtonView(
  result: IAiMcpServerTestResult | undefined,
  t: Translate,
  error?: unknown,
): McpTestButtonView {
  if (result?.ok) {
    return {
      state: "ok",
      color: "green",
      variant: "light",
      label: t("OK · {{n}}", { n: result.tools.length }),
      tooltip:
        result.tools.length > 0
          ? result.tools.join(", ")
          : t("No tools available"),
    };
  }
  if (result && result.ok === false) {
    return {
      state: "failed",
      color: "red",
      variant: "light",
      label: t("Failed"),
      tooltip: result.error,
    };
  }
  if (error) {
    // The test request itself rejected (401/403/500/network) — there is no
    // `{ ok }` payload, so without this branch the row would silently revert to
    // the idle "Test" instead of reporting the failure. Tooltip prefers the
    // server-sent message, else the generic i18n fallback.
    return {
      state: "failed",
      color: "red",
      variant: "light",
      label: t("Failed"),
      tooltip: readRequestErrorMessage(error) ?? t("Failed to update data"),
    };
  }
  return {
    state: "idle",
    color: undefined,
    variant: "default",
    label: t("Test"),
    tooltip: "",
  };
}
