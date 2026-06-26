import type { IAiMcpServerTestResult } from "@/features/workspace/services/ai-mcp-server-service.ts";

/** Minimal translator shape (i18next `t`): key + optional interpolation. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

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
  return {
    state: "idle",
    color: undefined,
    variant: "default",
    label: t("Test"),
    tooltip: "",
  };
}
