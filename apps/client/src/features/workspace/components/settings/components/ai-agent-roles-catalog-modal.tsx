import { useEffect, useMemo, useState } from "react";
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Modal,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconFolderOff,
  IconInfoCircle,
  IconRefresh,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  useAiRoleCatalogBundlesQueries,
  useAiRoleCatalogQuery,
  useImportAiRolesFromCatalogMutation,
  useUpdateAiRoleFromCatalogMutation,
} from "@/features/ai-chat/queries/ai-chat-query.ts";
import { IAiRole } from "@/features/ai-chat/types/ai-chat.types.ts";
import { LucideGlyph } from "@/components/ui/lucide/lucide-glyph.tsx";
import { parseIconRef } from "@/lib/icon-ref.ts";
import {
  bundleCounts,
  bundlePhase,
  CatalogViewRole,
  mapBundleRolesToView,
  nameConflictSlugs,
  partialOffersRename,
  RoleStatus,
} from "@/features/ai-chat/utils/catalog-bundle-model.ts";

interface AiAgentRolesCatalogModalProps {
  opened: boolean;
  onClose: () => void;
  // The current admin role list (full view, including `source`). Used to compute
  // each catalog role's install state (import / installed / update available).
  roles: IAiRole[];
}

/** A bundle mapped into the modal's view model. */
interface CatalogViewBundle {
  id: string;
  name: string;
  description: string;
  roles: CatalogViewRole[];
}

type ViewState = "loading" | "error" | "empty" | "ready";

/** A skipped role carried in a partial result so the plaque can name it. */
interface SkippedItem {
  slug: string;
  name: string;
  // Why it was skipped — 'name-conflict' offers "Rename & install"; an
  // 'already-installed' race is purely informational (re-importing would just
  // skip again, so no action button is shown).
  reason: "name-conflict" | "already-installed";
}

/** The inline per-bundle result plaque shown after an import/update. */
type ImportResult =
  | { type: "success"; installed: number; renamed?: number }
  | { type: "updated"; count: number }
  | { type: "partial"; installed: number; skipped: SkippedItem[] };

/** Progress of a client-side "Update all" request series. */
interface UpdateProgress {
  scope: string; // a bundle id, or GLOBAL_SCOPE
  current: number;
  total: number;
}

const GLOBAL_SCOPE = "__all__";

/**
 * Admin modal: browse the curated role catalog as bundle CARDS. Each bundle's
 * collapsed header shows a status summary (N new / all installed / N updates /
 * mixed) and a single primary action (Install bundle / Update all / Installed);
 * expanding it reveals per-role rows with checkboxes and per-role updates.
 *
 * Every listed bundle's content is loaded eagerly in parallel (statuses must be
 * readable without expanding). Import is per-bundle on the current one-bundle API
 * with `conflict:'skip'`; name collisions come back as skipped and surface an
 * inline "Rename & install" that re-imports the one role with `conflict:'rename'`.
 * "Update all" (per-bundle and global) is a client-side series of single-role
 * update calls with progress on the button — there is no batch endpoint yet.
 */
export default function AiAgentRolesCatalogModal({
  opened,
  onClose,
  roles,
}: AiAgentRolesCatalogModalProps) {
  const { t, i18n } = useTranslation();

  // The user's i18n base subtag (e.g. "ru-RU" => "ru"); the preferred catalog
  // language both when seeding and when reconciling against offered languages.
  const baseLang = (i18n.language || "en").split("-")[0].toLowerCase();

  // Fetch the catalog only while the modal is open. `language` drives both the
  // catalog query and the eager bundle-content reads. Seed it synchronously from
  // the base subtag so the first fetch already uses the user's language; the
  // effect below reconciles against the catalog's offered languages once loaded.
  const [language, setLanguage] = useState<string>(() => baseLang);
  const catalogQuery = useAiRoleCatalogQuery(language || "en", opened);

  const catalog = catalogQuery.data;
  const bundleSummaries = catalog?.bundles ?? [];
  const languages = catalog?.languages;

  // Eagerly open every listed bundle's content in parallel. The result array is
  // index-aligned with `bundleSummaries`.
  const bundleQueries = useAiRoleCatalogBundlesQueries(
    bundleSummaries.map((b) => b.id),
    language,
    opened && !!catalog,
  );

  const importMutation = useImportAiRolesFromCatalogMutation();
  const updateMutation = useUpdateAiRoleFromCatalogMutation();

  // Per-bundle UI state. `selected` is keyed by `${bundleId}:${slug}`.
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<
    Record<string, ImportResult | undefined>
  >({});
  // Transient client-only skipped slugs per bundle (a name conflict under
  // conflict:'skip'); overlaid onto still-importable roles as the "skipped"
  // status until the user acts. Never persisted server-side.
  const [skipped, setSkipped] = useState<Record<string, Set<string>>>({});
  const [busyBundle, setBusyBundle] = useState<string | null>(null);
  const [busyRole, setBusyRole] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  // Pick a sensible default language from the catalog once it loads: the i18n
  // base subtag if offered, else "en", else the first.
  useEffect(() => {
    if (!languages || languages.length === 0) return;
    if (language && languages.includes(language)) return;
    const preferred = languages.includes(baseLang)
      ? baseLang
      : languages.includes("en")
        ? "en"
        : languages[0];
    setLanguage(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languages]);

  // Reset all per-language UI state when the content language changes (bundle
  // contents, hence the install computations, selection and result plaques, are
  // language-specific).
  useEffect(() => {
    setSelected({});
    setResults({});
    setSkipped({});
    setBusyBundle(null);
    setBusyRole(null);
    setProgress(null);
  }, [language]);

  // A signature of the bundle-content reads so the derived model recomputes when
  // any content arrives/changes (the query result array is a new reference every
  // render, so it can't be a useMemo dependency directly).
  const contentSignature = bundleQueries
    .map((q) => `${q.status}:${q.dataUpdatedAt}`)
    .join("|");

  const viewBundles = useMemo<CatalogViewBundle[]>(
    () =>
      bundleSummaries.map((summary, i) => {
        const content = bundleQueries[i]?.data;
        const rolesView = content
          ? mapBundleRolesToView(content.roles, roles, language)
          : [];
        // Overlay the transient "skipped" status onto still-importable roles.
        const skippedSet = skipped[summary.id];
        const withSkipped = skippedSet
          ? rolesView.map((r) =>
              r.status === "import" && skippedSet.has(r.slug)
                ? { ...r, status: "skipped" as RoleStatus }
                : r,
            )
          : rolesView;
        return {
          id: summary.id,
          name: summary.name,
          description: summary.description ?? "",
          roles: withSkipped,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundleSummaries, contentSignature, roles, language, skipped],
  );

  // Default-check every importable role as its bundle content becomes available,
  // without clobbering user toggles (only fills keys not already present).
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const b of viewBundles) {
        for (const r of b.roles) {
          if (r.status !== "import") continue;
          const k = roleKey(b.id, r.slug);
          if (!(k in next)) {
            next[k] = true;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [viewBundles]);

  // --- derived ---
  const view: ViewState = catalogQuery.isError
    ? "error"
    : catalogQuery.isLoading || !catalog
      ? "loading"
      : bundleSummaries.length === 0
        ? "empty"
        : bundleQueries.some((q) => q.isError)
          ? "error"
          : bundleQueries.some((q) => q.isLoading)
            ? "loading"
            : "ready";

  const importable = (b: CatalogViewBundle) =>
    b.roles.filter((r) => r.status === "import");
  const selectedImportable = (b: CatalogViewBundle) =>
    importable(b).filter((r) => selected[roleKey(b.id, r.slug)]);

  const bundlesWithUpdates = viewBundles.filter((b) =>
    b.roles.some((r) => r.status === "update"),
  );
  const totalUpdates = viewBundles.reduce(
    (n, b) => n + b.roles.filter((r) => r.status === "update").length,
    0,
  );
  const otherLangInstalls = viewBundles
    .flatMap((b) => b.roles)
    .filter(
      (r) =>
        r.status === "import" &&
        r.installedLang &&
        r.installedLang !== language,
    ).length;

  // --- actions ---
  function toggleRole(bundleId: string, slug: string) {
    setSelected((s) => ({
      ...s,
      [roleKey(bundleId, slug)]: !s[roleKey(bundleId, slug)],
    }));
  }

  function toggleAll(b: CatalogViewBundle) {
    const imp = importable(b);
    const all = imp.every((r) => selected[roleKey(b.id, r.slug)]);
    setSelected((s) => {
      const next = { ...s };
      imp.forEach((r) => (next[roleKey(b.id, r.slug)] = !all));
      return next;
    });
  }

  function retry() {
    void catalogQuery.refetch();
    bundleQueries.forEach((q) => void q.refetch());
  }

  async function installBundle(b: CatalogViewBundle) {
    const slugs = selectedImportable(b).map((r) => r.slug);
    if (slugs.length === 0) return;
    setBusyBundle(b.id);
    setResults((r) => ({ ...r, [b.id]: undefined }));
    try {
      const res = await importMutation.mutateAsync({
        bundleId: b.id,
        language,
        slugs,
        conflict: "skip",
      });
      // Only name conflicts become a transient `skipped` overlay (renameable);
      // an already-installed race has nothing to act on. Decision lives in the
      // pure, unit-tested nameConflictSlugs helper.
      const conflictSlugs = nameConflictSlugs(res.skippedRoles);
      if (conflictSlugs.length > 0) {
        setSkipped((prev) => {
          const set = new Set(prev[b.id] ?? []);
          conflictSlugs.forEach((slug) => set.add(slug));
          return { ...prev, [b.id]: set };
        });
      }
      setResults((r) => ({
        ...r,
        [b.id]:
          res.skippedRoles.length > 0
            ? {
                type: "partial",
                installed: res.created,
                skipped: res.skippedRoles.map((s) => ({
                  slug: s.slug,
                  name: s.name,
                  reason: s.reason,
                })),
              }
            : {
                type: "success",
                installed: res.created,
                renamed: res.renamed || undefined,
              },
      }));
    } catch {
      // The mutation's onError already surfaced a notification.
    } finally {
      setBusyBundle(null);
    }
  }

  async function renameInstall(bundleId: string, slug: string) {
    setBusyBundle(bundleId);
    try {
      const res = await importMutation.mutateAsync({
        bundleId,
        language,
        slugs: [slug],
        conflict: "rename",
      });
      setSkipped((prev) => {
        const set = new Set(prev[bundleId] ?? []);
        set.delete(slug);
        return { ...prev, [bundleId]: set };
      });
      setResults((r) => {
        const cur = r[bundleId];
        if (cur?.type === "partial") {
          const remaining = cur.skipped.filter((x) => x.slug !== slug);
          const installed = cur.installed + res.created;
          return {
            ...r,
            [bundleId]:
              remaining.length > 0
                ? { type: "partial", installed, skipped: remaining }
                : {
                    type: "success",
                    installed,
                    renamed: res.renamed || undefined,
                  },
          };
        }
        return {
          ...r,
          [bundleId]: {
            type: "success",
            installed: res.created,
            renamed: res.renamed || undefined,
          },
        };
      });
    } catch {
      // Notification already shown by the mutation.
    } finally {
      setBusyBundle(null);
    }
  }

  async function updateRole(bundleId: string, role: CatalogViewRole) {
    if (!role.installedRoleId) return;
    setBusyRole(roleKey(bundleId, role.slug));
    try {
      await updateMutation.mutateAsync(role.installedRoleId);
    } catch {
      // Notification already shown by the mutation.
    } finally {
      setBusyRole(null);
    }
  }

  // Run a series of single-role update calls with progress on the button. There
  // is no batch endpoint yet ([API #3]); the roles refetch after each call so the
  // statuses converge as the series proceeds.
  async function runUpdateSeries(
    scope: string,
    targets: CatalogViewRole[],
    onDone: () => void,
  ) {
    const ids = targets
      .map((r) => r.installedRoleId)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return;
    setBusyBundle(scope);
    setProgress({ scope, current: 0, total: ids.length });
    try {
      for (let i = 0; i < ids.length; i++) {
        setProgress({ scope, current: i + 1, total: ids.length });
        await updateMutation.mutateAsync(ids[i]);
      }
      onDone();
    } catch {
      // Notification already shown by the mutation; stop the series.
    } finally {
      setBusyBundle(null);
      setProgress(null);
    }
  }

  function updateBundleAll(b: CatalogViewBundle) {
    const ups = b.roles.filter((r) => r.status === "update");
    void runUpdateSeries(b.id, ups, () =>
      setResults((r) => ({
        ...r,
        [b.id]: { type: "updated", count: ups.length },
      })),
    );
  }

  function updateAllGlobal() {
    const ups = viewBundles.flatMap((b) =>
      b.roles.filter((r) => r.status === "update"),
    );
    void runUpdateSeries(GLOBAL_SCOPE, ups, () => {
      // Per-bundle plaques are set for each affected bundle.
      setResults((r) => {
        const next = { ...r };
        for (const b of viewBundles) {
          const n = b.roles.filter((x) => x.status === "update").length;
          if (n > 0) next[b.id] = { type: "updated", count: n };
        }
        return next;
      });
    });
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size={640}
      title={
        <Text fw={600} fz="lg">
          {t("Role catalog")}
        </Text>
      }
      styles={{ header: { alignItems: "center" } }}
    >
      {/* Content-language switcher (Р5) — compact, top-right. */}
      {languages && languages.length > 1 && (
        <Group justify="flex-end" gap="xs" mb="md">
          <Text fz="xs" c="dimmed">
            {t("Content")}
          </Text>
          <SegmentedControl
            size="xs"
            value={language}
            onChange={setLanguage}
            data={languages.map((l) => ({ label: l.toUpperCase(), value: l }))}
          />
          <Tooltip label={t("Content language of the roles")} withArrow>
            <ThemeIcon variant="transparent" c="dimmed" size="sm">
              <IconInfoCircle size={16} />
            </ThemeIcon>
          </Tooltip>
        </Group>
      )}

      {view === "error" && <ErrorState onRetry={retry} />}
      {view === "empty" && <EmptyState />}
      {view === "loading" && <LoadingState />}

      {view === "ready" && (
        <Stack gap="sm">
          {/* Р10 — global "update all" when updates span ≥2 bundles. */}
          {bundlesWithUpdates.length >= 2 && (
            <Alert
              variant="light"
              color="blue"
              icon={<IconRefresh size={16} />}
              p="xs"
            >
              <Group gap="sm" wrap="nowrap">
                <Text fz="sm" fw={500}>
                  {t(
                    "{{count}} updates available in {{bundles}} bundles",
                    {
                      count: totalUpdates,
                      bundles: bundlesWithUpdates.length,
                    },
                  )}
                </Text>
                <Button
                  size="compact-sm"
                  ml="auto"
                  onClick={updateAllGlobal}
                  loading={busyBundle === GLOBAL_SCOPE}
                >
                  {progress?.scope === GLOBAL_SCOPE
                    ? t("Updating {{current}}/{{total}}…", {
                        current: progress.current,
                        total: progress.total,
                      })
                    : t("Update all ({{count}})", { count: totalUpdates })}
                </Button>
              </Group>
            </Alert>
          )}

          {/* Р5 — installed-in-another-language hint. */}
          {otherLangInstalls > 0 && (
            <Alert
              variant="light"
              color="blue"
              icon={<IconInfoCircle size={16} />}
              p="xs"
            >
              <Text fz="sm">
                {t(
                  "{{count}} roles are installed in another language. A different language installs separately and appears as new.",
                  { count: otherLangInstalls },
                )}
              </Text>
            </Alert>
          )}

          <Accordion
            multiple
            defaultValue={
              viewBundles.length <= 3 && viewBundles[0]
                ? [viewBundles[0].id]
                : []
            }
            variant="separated"
          >
            {viewBundles.map((b) => (
              <BundlePanel
                key={b.id}
                bundle={b}
                selected={selected}
                result={results[b.id]}
                busyBundle={busyBundle}
                busyRole={busyRole}
                progress={progress}
                selectedCount={selectedImportable(b).length}
                importableCount={importable(b).length}
                onToggleRole={toggleRole}
                onToggleAll={toggleAll}
                onInstall={installBundle}
                onUpdateAll={updateBundleAll}
                onUpdateRole={updateRole}
                onRenameInstall={renameInstall}
                onDismissResult={(id) =>
                  setResults((r) => ({ ...r, [id]: undefined }))
                }
              />
            ))}
          </Accordion>
        </Stack>
      )}
    </Modal>
  );
}

const roleKey = (bundleId: string, slug: string) => `${bundleId}:${slug}`;

interface BundlePanelProps {
  bundle: CatalogViewBundle;
  selected: Record<string, boolean>;
  result: ImportResult | undefined;
  busyBundle: string | null;
  busyRole: string | null;
  progress: UpdateProgress | null;
  selectedCount: number;
  importableCount: number;
  onToggleRole: (bundleId: string, slug: string) => void;
  onToggleAll: (bundle: CatalogViewBundle) => void;
  onInstall: (bundle: CatalogViewBundle) => void;
  onUpdateAll: (bundle: CatalogViewBundle) => void;
  onUpdateRole: (bundleId: string, role: CatalogViewRole) => void;
  onRenameInstall: (bundleId: string, slug: string) => void;
  onDismissResult: (bundleId: string) => void;
}

/** One catalog bundle card: summary header + primary action + expandable rows. */
function BundlePanel({
  bundle: b,
  selected,
  result,
  busyBundle,
  busyRole,
  progress,
  selectedCount,
  importableCount,
  onToggleRole,
  onToggleAll,
  onInstall,
  onUpdateAll,
  onUpdateRole,
  onRenameInstall,
  onDismissResult,
}: BundlePanelProps) {
  const { t } = useTranslation();

  // Single tally pass shared by the summary and the primary action (F4).
  const counts = bundleCounts(b.roles);
  const impCount = importableCount;
  const upCount = counts.update;
  const installedCount = counts.installed;
  const busy = busyBundle === b.id || busyBundle === GLOBAL_SCOPE;
  const phase = bundlePhase(b.roles);

  // Summary status (Р1) — readable without expanding.
  const statusParts = (() => {
    if (phase === "allNew")
      return [
        <StatusDot key="n" color="blue">
          {t("{{count}} new — none installed", { count: impCount })}
        </StatusDot>,
      ];
    if (phase === "allInstalled")
      return [
        <StatusDot key="a" color="green">
          {t("All installed · up to date")}
        </StatusDot>,
      ];
    if (phase === "updates")
      return [
        <StatusDot key="u" color="orange">
          {t("{{count}} updates · {{installed}} up to date", {
            count: upCount,
            installed: installedCount,
          })}
        </StatusDot>,
      ];
    if (phase === "empty") return [];
    return [
      impCount ? (
        <StatusDot key="n" color="blue">
          {t("{{count}} new", { count: impCount })}
        </StatusDot>
      ) : null,
      installedCount ? (
        <StatusDot key="i" color="gray">
          {t("{{count}} installed", { count: installedCount })}
        </StatusDot>
      ) : null,
      upCount ? (
        <StatusDot key="u" color="orange">
          {t("{{count}} updates", { count: upCount })}
        </StatusDot>
      ) : null,
    ].filter(Boolean);
  })();

  // Primary action (Р2) — never a dead disabled Import button.
  const primary = (() => {
    if (phase === "empty") return null;
    if (phase === "allInstalled")
      return (
        <Group gap={5} c="green.7">
          <IconCheck size={16} />
          <Text fz="sm" fw={600}>
            {t("Installed")}
          </Text>
        </Group>
      );
    if (phase === "updates")
      return (
        <Button
          size="xs"
          color="orange"
          variant="light"
          loading={busy}
          onClick={(e) => {
            e.stopPropagation();
            onUpdateAll(b);
          }}
        >
          {progress?.scope === b.id
            ? t("Updating {{current}}/{{total}}…", {
                current: progress.current,
                total: progress.total,
              })
            : t("Update all ({{count}})", { count: upCount })}
        </Button>
      );
    const label =
      phase === "mixed"
        ? selectedCount > 0
          ? t("Install {{count}} selected", { count: selectedCount })
          : t("Install bundle")
        : t("Install bundle ({{count}})", { count: selectedCount });
    return (
      <Button
        size="xs"
        loading={busy}
        disabled={selectedCount === 0}
        onClick={(e) => {
          e.stopPropagation();
          onInstall(b);
        }}
      >
        {label}
      </Button>
    );
  })();

  const allChecked =
    impCount > 0 && b.roles
      .filter((r) => r.status === "import")
      .every((r) => selected[roleKey(b.id, r.slug)]);

  return (
    <Accordion.Item value={b.id}>
      <Accordion.Control>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <div style={{ minWidth: 0 }}>
            <Group gap="xs" align="baseline">
              <Text fw={600}>{b.name}</Text>
              <Text fz="sm" c="dimmed">
                {t("{{count}} roles", { count: b.roles.length })}
              </Text>
            </Group>
            {b.description && (
              <Text fz="sm" c="dimmed">
                {b.description}
              </Text>
            )}
            <Group gap="md" mt={4}>
              {statusParts}
            </Group>
          </div>
          {/* stopPropagation so a click on the action doesn't toggle the panel. */}
          {primary && (
            <Box onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
              {primary}
            </Box>
          )}
        </Group>
      </Accordion.Control>

      <Accordion.Panel>
        {/* Р7 — inline import/update result. */}
        {result && (
          <ResultBanner
            result={result}
            bundleId={b.id}
            onRename={onRenameInstall}
            onDismiss={() => onDismissResult(b.id)}
          />
        )}

        {/* Р3 — select / deselect all (secondary layer). */}
        {impCount > 1 && (
          <Group
            gap="sm"
            py={6}
            px="xs"
            mb={4}
            bg="var(--mantine-color-default-hover)"
            style={{ borderRadius: 6 }}
          >
            <Checkbox
              size="xs"
              checked={allChecked}
              indeterminate={!allChecked && selectedCount > 0}
              onChange={() => onToggleAll(b)}
              label={
                <Text fz="xs" fw={500}>
                  {t("{{selected}} of {{total}} selected", {
                    selected: selectedCount,
                    total: impCount,
                  })}
                </Text>
              }
            />
            <Anchor
              component="button"
              fz="xs"
              fw={600}
              ml="auto"
              onClick={() => onToggleAll(b)}
            >
              {allChecked ? t("Deselect all") : t("Select all")}
            </Anchor>
          </Group>
        )}

        {/* Р4 — one role row; only the right zone differs by status. */}
        <Stack gap={0}>
          {b.roles.map((r) => (
            <RoleRow
              key={r.slug}
              role={r}
              checked={!!selected[roleKey(b.id, r.slug)]}
              busy={busyRole === roleKey(b.id, r.slug)}
              onToggle={() => onToggleRole(b.id, r.slug)}
              onUpdate={() => onUpdateRole(b.id, r)}
            />
          ))}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

interface RoleRowProps {
  role: CatalogViewRole;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
  onUpdate: () => void;
}

/** A single role row — identical structure across all statuses (Р4). */
function RoleRow({ role: r, checked, busy, onToggle, onUpdate }: RoleRowProps) {
  const { t } = useTranslation();
  return (
    <Group
      gap="sm"
      wrap="nowrap"
      py={8}
      px="xs"
      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
    >
      <Text fz="lg" w={24} ta="center" style={{ flexShrink: 0 }}>
        {/* The catalog is a REMOTE preset source with its own glyph contract
            (still native emoji today); render a Lucide glyph if the value is an
            IconRef, otherwise show the remote string as-is — never raw JSON. */}
        {parseIconRef(r.emoji) ? (
          <LucideGlyph name={parseIconRef(r.emoji)?.name} size={18} />
        ) : (
          (r.emoji ?? "")
        )}
      </Text>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} align="baseline">
          <Text fz="sm" fw={600}>
            {r.name}
          </Text>
          <Text fz={11} c="dimmed">
            {t("v{{version}}", { version: r.version })}
          </Text>
        </Group>
        {r.description && (
          <Text fz="xs" c="dimmed" truncate>
            {r.description}
          </Text>
        )}
      </div>
      {/* fixed right zone — differs ONLY in content */}
      <Group justify="flex-end" style={{ minWidth: 100, flexShrink: 0 }}>
        {r.status === "import" && (
          <Checkbox
            checked={checked}
            onChange={onToggle}
            aria-label={r.name}
          />
        )}
        {r.status === "installed" && (
          <Badge color="gray" variant="light">
            {t("Installed")}
          </Badge>
        )}
        {r.status === "skipped" && (
          <Badge color="yellow" variant="light">
            {t("Skipped")}
          </Badge>
        )}
        {r.status === "update" && (
          <Group gap="xs" wrap="nowrap">
            <Badge color="orange" variant="light">
              {t("v{{from}} → v{{to}}", {
                from: r.version,
                to: r.newVersion,
              })}
            </Badge>
            <Button
              size="compact-xs"
              color="orange"
              variant="light"
              loading={busy}
              onClick={onUpdate}
            >
              {t("Update")}
            </Button>
          </Group>
        )}
      </Group>
    </Group>
  );
}

interface ResultBannerProps {
  result: ImportResult;
  bundleId: string;
  onRename: (bundleId: string, slug: string) => void;
  onDismiss: () => void;
}

/** Inline import/update result plaque (Р7). */
function ResultBanner({
  result,
  bundleId,
  onRename,
  onDismiss,
}: ResultBannerProps) {
  const { t } = useTranslation();

  if (result.type === "success") {
    return (
      <Alert
        variant="light"
        color="green"
        icon={<IconCheck size={16} />}
        p="xs"
        mb="sm"
        withCloseButton
        onClose={onDismiss}
      >
        <Text fz="sm" fw={500}>
          {result.renamed
            ? t("{{count}} roles installed · {{renamed}} renamed", {
                count: result.installed,
                renamed: result.renamed,
              })
            : t("{{count}} roles installed", { count: result.installed })}
        </Text>
      </Alert>
    );
  }
  if (result.type === "updated") {
    return (
      <Alert
        variant="light"
        color="green"
        icon={<IconCheck size={16} />}
        p="xs"
        mb="sm"
        withCloseButton
        onClose={onDismiss}
      >
        <Text fz="sm" fw={500}>
          {t("{{count}} roles updated", { count: result.count })}
        </Text>
      </Alert>
    );
  }
  // partial — Р7 partial success. The action (Rename & install) belongs ONLY to a
  // name-conflict skip; an already-installed race is informational (re-importing
  // the same slug+language would just skip again, so no button — otherwise the
  // click self-heals into a false "installed" with nothing actually installed).
  const offersRename = partialOffersRename(result.skipped);
  const nameConflict = offersRename
    ? result.skipped.find((s) => s.reason === "name-conflict")
    : undefined;
  const detail = nameConflict
    ? t('A role named "{{name}}" already exists in this workspace.', {
        name: nameConflict.name,
      })
    : t('"{{name}}" is already installed.', { name: result.skipped[0]?.name });
  return (
    <Alert
      variant="light"
      color="yellow"
      icon={<IconAlertTriangle size={16} />}
      p="xs"
      mb="sm"
    >
      <Group wrap="nowrap" align="flex-start">
        <div style={{ flex: 1 }}>
          <Text fz="sm" fw={600}>
            {t("Installed {{installed}} · {{skipped}} skipped", {
              installed: result.installed,
              skipped: result.skipped.length,
            })}
          </Text>
          {result.skipped.length > 0 && (
            <Text fz="xs" c="dimmed">
              {detail}
            </Text>
          )}
        </div>
        {nameConflict && (
          <Button
            size="compact-xs"
            color="yellow"
            variant="default"
            onClick={() => onRename(bundleId, nameConflict.slug)}
          >
            {t("Rename & install")}
          </Button>
        )}
      </Group>
    </Alert>
  );
}

/** Loading skeletons (Р8). */
function LoadingState() {
  return (
    <Stack gap="sm">
      {[0, 1].map((i) => (
        <Group
          key={i}
          justify="space-between"
          p="md"
          style={{
            border: "1px solid var(--mantine-color-default-border)",
            borderRadius: 8,
          }}
        >
          <Stack gap={8} style={{ flex: 1 }}>
            <Skeleton h={12} w="42%" />
            <Skeleton h={9} w="75%" />
            <Skeleton h={9} w="32%" />
          </Stack>
          <Skeleton h={30} w={130} />
        </Group>
      ))}
    </Stack>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Center py={48}>
      <Stack align="center" gap="sm">
        <ThemeIcon color="red" variant="light" size={46} radius="xl">
          <IconAlertTriangle size={22} />
        </ThemeIcon>
        <Text fw={600}>{t("Couldn’t load the catalog")}</Text>
        <Text fz="sm" c="dimmed" ta="center" maw={300}>
          {t(
            "Check your connection and try again. Installed roles are not affected.",
          )}
        </Text>
        <Button
          variant="default"
          leftSection={<IconRefresh size={16} />}
          onClick={onRetry}
          mt={4}
        >
          {t("Retry")}
        </Button>
      </Stack>
    </Center>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <Center py={48}>
      <Stack align="center" gap="sm">
        <ThemeIcon color="gray" variant="light" size={46} radius="xl">
          <IconFolderOff size={22} />
        </ThemeIcon>
        <Text fw={600}>{t("The catalog is empty")}</Text>
        <Text fz="sm" c="dimmed" ta="center" maw={300}>
          {t(
            "No role bundles are published for this language yet. Try switching the content language.",
          )}
        </Text>
      </Stack>
    </Center>
  );
}

// Status-dot color -> Mantine CSS variables (light/dark aware; no hardcoded hex).
const DOT_VARS: Record<string, string> = {
  blue: "var(--mantine-color-blue-6)",
  gray: "var(--mantine-color-gray-5)",
  orange: "var(--mantine-color-orange-6)",
  green: "var(--mantine-color-green-6)",
};
const DOT_TEXT: Record<string, string> = {
  blue: "blue.7",
  gray: "gray.6",
  orange: "orange.7",
  green: "green.7",
};

function StatusDot({
  color,
  children,
}: {
  color: "blue" | "gray" | "orange" | "green";
  children: React.ReactNode;
}) {
  return (
    <Group gap={6} wrap="nowrap">
      <Box
        w={7}
        h={7}
        style={{ borderRadius: "50%", background: DOT_VARS[color] }}
      />
      <Text fz="xs" fw={600} c={DOT_TEXT[color]}>
        {children}
      </Text>
    </Group>
  );
}
