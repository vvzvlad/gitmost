import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Group, Skeleton, Text, TextInput, UnstyledButton } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "lucide-react";
import { dynamicIconImports } from "lucide-react/dynamic";
import { isChunkLoadError, handleError } from "@/components/chunk-load-error-boundary";
import { hasAutoReloaded } from "@/lib/reload-guard";
import { LucideGlyph } from "./lucide-glyph";
import { CURATED_ICON_NAMES } from "./curated-icons";
import type { LucideCatalog } from "./lucide-catalog.generated";
import { loadCatalog, syncCatalog } from "./lucide-catalog-loader";
import {
  buildBrowseRows,
  buildResultRows,
  canonicalOf,
  catalogIconCount,
  searchIcons,
  HEADER_ROW_HEIGHT,
  ICON_ROW_HEIGHT,
  type IconRow,
} from "./lucide-search";
import classes from "./lucide-icon-grid.module.css";

// All 1995 dynamicIconImports keys (canonical + aliases), sorted — the data for
// the failure "limited mode" grid, where the catalog (hence the alias→canon map
// and tags) is unavailable.
const ALL_ICON_NAMES = Object.keys(dynamicIconImports).sort();

// Fixed scroll-container height. The loading skeleton holds the SAME height so
// the catalog arriving never shifts the grid under the cursor.
const GRID_HEIGHT = 320;

type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; catalog: LucideCatalog }
  | { kind: "failed"; reason: string };

export interface LucideIconGridProps {
  /** Show the built-in search box (default true). */
  search?: boolean;
  /** Always called with the CANONICAL icon name (even for an alias hit). */
  onPick: (name: string) => void;
}

/**
 * Searchable, virtualized Lucide icon grid exposing the FULL catalog. Before a
 * query it shows a "Popular" section then category sections; typing switches to
 * a ranked flat result list (by name / alias / tag, plus a compact Russian
 * synonym map). No per-icon tooltip — the name lives on each button's
 * `aria-label`, and a counter under the grid says how many icons are shown.
 * Reused by the article picker and the AI-role glyph picker.
 */
export function LucideIconGrid({ search = true, onPick }: LucideIconGridProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // Read an already-resolved catalog synchronously so a re-opened picker renders
  // `ready` without flashing the skeleton.
  const [state, setState] = useState<CatalogState>(() => {
    const cached = syncCatalog();
    return cached ? { kind: "ready", catalog: cached } : { kind: "loading" };
  });

  // Imperative load (NOT React.lazy/Suspense): a reject thrown in render would
  // bubble to the root ChunkLoadErrorBoundary and burn the shared per-window
  // auto-reload budget. Decide locally instead.
  useEffect(() => {
    if (state.kind !== "loading") return;
    let cancelled = false;
    loadCatalog()
      .then((catalog) => {
        if (!cancelled) setState({ kind: "ready", catalog });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[lucide-catalog] failed to load the catalog chunk", err);
        const reason =
          (err as { message?: string })?.message ?? String(err ?? "unknown error");
        if (isChunkLoadError(err)) {
          // Stale-deploy 404: hand it to the existing guarded-reload path
          // (reloads once per window). If the budget is already spent we stay
          // here and MUST show the failure UI, never an eternal skeleton.
          if (!hasAutoReloaded()) {
            handleError(err); // reloads the page when the budget allows
          }
          setState({ kind: "failed", reason });
          return;
        }
        setState({ kind: "failed", reason });
      });
    return () => {
      cancelled = true;
    };
  }, [state.kind]);

  const normalizedQuery = query.trim().toLowerCase();

  // Row model + counter data, derived from state and query. NB: `t` is deliberately
  // NOT a dependency here -- a language switch must not rebuild `rows` (a new `rows`
  // identity re-runs the measure()/scrollToOffset(0) effect below and would reset the
  // scroll position). The translated string is memoised separately, on `t`.
  const { rows, counterKey, counterCount } = useMemo((): {
    rows: IconRow[];
    counterKey: string;
    counterCount: number;
  } => {
    if (state.kind === "ready") {
      if (normalizedQuery === "") {
        return {
          rows: buildBrowseRows(state.catalog, CURATED_ICON_NAMES),
          counterKey: "{{count}} icons",
          counterCount: catalogIconCount(state.catalog),
        };
      }
      const names = searchIcons(state.catalog, normalizedQuery);
      return {
        rows: buildResultRows(names),
        counterKey: "Found {{count}}",
        counterCount: names.length,
      };
    }
    if (state.kind === "failed") {
      // Limited mode: same virtualized model; name+alias substring only.
      const names =
        normalizedQuery === ""
          ? ALL_ICON_NAMES
          : ALL_ICON_NAMES.filter((n) => n.includes(normalizedQuery));
      return {
        rows: buildResultRows(names),
        counterKey: "{{count}} icons (limited mode)",
        counterCount: names.length,
      };
    }
    return { rows: [], counterKey: "", counterCount: 0 };
  }, [state, normalizedQuery]);

  const counter = useMemo(
    () => (counterKey ? t(counterKey, { count: counterCount }) : ""),
    [counterKey, counterCount, t],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) =>
      rows[i]?.kind === "header" ? HEADER_ROW_HEIGHT : ICON_ROW_HEIGHT,
    getItemKey: (i) => rows[i]?.id ?? i,
    overscan: 4,
  });

  // The layout memo does NOT depend on estimateSize and won't recompute when the
  // row model changes at a constant count, so force it explicitly; also reset
  // scroll to the top so a new query / the catalog arriving opens at the best
  // matches instead of a stale scrollTop.
  useEffect(() => {
    virtualizer.measure();
    virtualizer.scrollToOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const renderGlyph = (name: string) => {
    if (state.kind === "ready") {
      const node = state.catalog.icons[canonicalOf(state.catalog, name)];
      // Guard: Icon.mjs does `iconNode.map(...)` unguarded — a missing node
      // would throw a TypeError (NOT a chunk error), crashing the whole app into
      // the full-screen error boundary. Fall back to a lazy glyph instead.
      if (node) return <Icon iconNode={node} size={18} />;
    }
    return <LucideGlyph name={name} size={18} />;
  };

  const pickName = (name: string) =>
    onPick(state.kind === "ready" ? canonicalOf(state.catalog, name) : name);

  const showEmpty =
    state.kind !== "loading" && normalizedQuery !== "" && rows.length === 0;

  return (
    <div>
      {search && (
        <TextInput
          size="xs"
          mb="xs"
          leftSection={<IconSearch size={14} />}
          placeholder={t("Search icons")}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label={t("Search icons")}
        />
      )}

      {state.kind === "failed" && (
        <Group justify="space-between" wrap="nowrap" gap="xs" mb="xs">
          <Text size="xs" c="dimmed" style={{ flex: 1 }}>
            {t(
              "Icon catalog failed to load: {{reason}}. Showing all icons in limited mode",
              { reason: state.reason },
            )}
          </Text>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => window.location.reload()}
          >
            {t("Retry")}
          </Button>
        </Group>
      )}

      {state.kind === "loading" ? (
        <Skeleton height={GRID_HEIGHT} radius="sm" aria-busy />
      ) : showEmpty ? (
        <div style={{ height: GRID_HEIGHT }}>
          <Text size="xs" c="dimmed" ta="center" py="md">
            {t("No icons found")}
          </Text>
        </div>
      ) : (
        <div
          ref={scrollRef}
          style={{ height: GRID_HEIGHT, overflowY: "auto", position: "relative" }}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              if (!row) return null;
              return (
                <div
                  key={row.id}
                  // Height forced inline (like doc-tree.tsx) so a wrapped header
                  // title can't drift from estimateSize.
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height:
                      row.kind === "header" ? HEADER_ROW_HEIGHT : ICON_ROW_HEIGHT,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {row.kind === "header" ? (
                    <Text
                      size="xs"
                      fw={600}
                      c="dimmed"
                      style={{ lineHeight: `${HEADER_ROW_HEIGHT}px` }}
                    >
                      {t(row.title)}
                    </Text>
                  ) : (
                    <div
                      className={classes.row}
                      data-icon-row
                      style={{ height: ICON_ROW_HEIGHT }}
                    >
                      {row.names.map((name) => (
                        <UnstyledButton
                          key={name}
                          type="button"
                          className={classes.cell}
                          data-icon-cell
                          aria-label={
                            state.kind === "ready"
                              ? canonicalOf(state.catalog, name)
                              : name
                          }
                          onClick={() => pickName(name)}
                        >
                          {renderGlyph(name)}
                        </UnstyledButton>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!showEmpty && counter !== "" && (
        <Text size="xs" c="dimmed" ta="center" mt="xs">
          {counter}
        </Text>
      )}
    </div>
  );
}

export default LucideIconGrid;
