import { useEffect, useMemo, useState } from "react";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  Modal,
  Radio,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  useAiRoleCatalogBundleQuery,
  useAiRoleCatalogQuery,
  useImportAiRolesFromCatalogMutation,
  useUpdateAiRoleFromCatalogMutation,
} from "@/features/ai-chat/queries/ai-chat-query.ts";
import {
  IAiRole,
  IAiRoleCatalogBundleSummary,
  IAiRoleCatalogRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";

interface AiAgentRolesCatalogModalProps {
  opened: boolean;
  onClose: () => void;
  // The current admin role list (full view, including `source`). Used to compute
  // each catalog role's install state (import / installed / update available).
  roles: IAiRole[];
}

/** How a name collision with an existing role is handled on import. */
type Conflict = "skip" | "rename";

/**
 * Admin modal: browse the curated role catalog, import roles, and update an
 * imported role when the catalog ships a newer version.
 *
 * Import is per-bundle (the endpoint takes a single bundleId). Each bundle's
 * Accordion panel has its own "Import" button that imports only that bundle's
 * checked roles — the simplest mapping to the one-bundle-per-call API and the
 * clearest UX. Selection state is tracked per bundle.
 */
export default function AiAgentRolesCatalogModal({
  opened,
  onClose,
  roles,
}: AiAgentRolesCatalogModalProps) {
  const { t, i18n } = useTranslation();

  // Fetch the catalog only while the modal is open. `language` drives both the
  // catalog query (bundle names) and bundle reads (role content). Seed it
  // synchronously from the i18n base subtag (e.g. "ru-RU" => "ru") so the first
  // fetch already uses the user's language; the effect below still reconciles
  // against the catalog's offered languages once they load.
  const [language, setLanguage] = useState<string>(
    () => (i18n.language || "en").split("-")[0].toLowerCase(),
  );
  const catalogQuery = useAiRoleCatalogQuery(language || "en", opened);

  // On name conflict: Skip (default) or Rename to a free " (N)" name.
  const [conflict, setConflict] = useState<Conflict>("skip");

  // The currently expanded bundle id (Accordion is single-open: one bundle's
  // roles are fetched at a time).
  const [expanded, setExpanded] = useState<string | null>(null);

  // Per-bundle selected slugs (import-state roles checked for import).
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  const languages = catalogQuery.data?.languages;

  // Pick a sensible default language from the catalog once it loads: the i18n
  // base subtag (e.g. "ru-RU" => "ru") if offered, else "en", else the first.
  useEffect(() => {
    if (!languages || languages.length === 0) return;
    if (language && languages.includes(language)) return;
    const base = (i18n.language || "en").split("-")[0].toLowerCase();
    const preferred = languages.includes(base)
      ? base
      : languages.includes("en")
        ? "en"
        : languages[0];
    setLanguage(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languages]);

  // Reset per-language UI state when the language changes (the bundle content,
  // hence the install computations, are language-specific).
  useEffect(() => {
    setExpanded(null);
    setSelected({});
  }, [language]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("Role catalog")}
      size="lg"
    >
      <Stack>
        <Select
          label={t("Language")}
          data={languages ?? []}
          value={language || null}
          onChange={(value) => value && setLanguage(value)}
          allowDeselect={false}
          disabled={!languages || languages.length === 0}
          comboboxProps={{ withinPortal: true }}
        />

        <Radio.Group
          label={t("On name conflict")}
          value={conflict}
          onChange={(value) => setConflict(value as Conflict)}
        >
          <Group mt="xs">
            <Radio value="skip" label={t("Skip")} />
            <Radio value="rename" label={t("Rename")} />
          </Group>
        </Radio.Group>

        {catalogQuery.isLoading && (
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        )}

        {catalogQuery.isError && (
          <Alert
            color="red"
            icon={<IconAlertTriangle size={16} />}
            title={t("The role catalog is unavailable")}
          >
            {t("Please try again later.")}
          </Alert>
        )}

        {catalogQuery.data && catalogQuery.data.bundles.length === 0 && (
          <Text size="sm" c="dimmed">
            {t("No bundles available")}
          </Text>
        )}

        {catalogQuery.data && catalogQuery.data.bundles.length > 0 && (
          <Accordion
            variant="separated"
            value={expanded}
            onChange={setExpanded}
          >
            {catalogQuery.data.bundles.map((bundle) => (
              <BundlePanel
                key={bundle.id}
                bundle={bundle}
                language={language}
                expanded={expanded === bundle.id}
                roles={roles}
                conflict={conflict}
                selected={selected[bundle.id]}
                onToggleSlug={(slug, checked) =>
                  setSelected((prev) => {
                    const next = new Set(prev[bundle.id] ?? []);
                    if (checked) next.add(slug);
                    else next.delete(slug);
                    return { ...prev, [bundle.id]: next };
                  })
                }
                onSetSelected={(slugs) =>
                  setSelected((prev) => ({
                    ...prev,
                    [bundle.id]: new Set(slugs),
                  }))
                }
              />
            ))}
          </Accordion>
        )}

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            {t("Close")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface BundlePanelProps {
  bundle: IAiRoleCatalogBundleSummary;
  language: string;
  expanded: boolean;
  roles: IAiRole[];
  conflict: Conflict;
  selected: Set<string> | undefined;
  onToggleSlug: (slug: string, checked: boolean) => void;
  onSetSelected: (slugs: string[]) => void;
}

/** One catalog bundle: its roles (fetched when expanded) + a per-bundle import. */
function BundlePanel({
  bundle,
  language,
  expanded,
  roles,
  conflict,
  selected,
  onToggleSlug,
  onSetSelected,
}: BundlePanelProps) {
  const { t } = useTranslation();

  // Only fetch this bundle's roles once it is actually expanded.
  const bundleQuery = useAiRoleCatalogBundleQuery(
    bundle.id,
    language,
    expanded && !!language,
  );

  const importMutation = useImportAiRolesFromCatalogMutation();
  const updateMutation = useUpdateAiRoleFromCatalogMutation();

  // Compute each catalog role's install state against the current workspace
  // roles: an importable role matched by source.slug + source.language.
  const computed = useMemo(() => {
    const list = bundleQuery.data?.roles ?? [];
    return list.map((role) => {
      const installed = roles.find(
        (r) => r.source?.slug === role.slug && r.source?.language === language,
      );
      if (!installed) return { role, state: "import" as const };
      if ((installed.source?.version ?? 0) >= role.version) {
        return { role, state: "installed" as const, installed };
      }
      return { role, state: "update" as const, installed };
    });
  }, [bundleQuery.data, roles, language]);

  // Default-check every importable role once the bundle content arrives (unless
  // the user already touched the selection for this bundle).
  useEffect(() => {
    if (!bundleQuery.data || selected !== undefined) return;
    onSetSelected(
      computed.filter((c) => c.state === "import").map((c) => c.role.slug),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleQuery.data]);

  const importableSlugs = computed
    .filter((c) => c.state === "import")
    .map((c) => c.role.slug);
  const checkedSlugs = importableSlugs.filter((slug) => selected?.has(slug));

  function handleImport() {
    importMutation.mutate({
      bundleId: bundle.id,
      language,
      slugs: checkedSlugs,
      conflict,
    });
  }

  return (
    <Accordion.Item value={bundle.id}>
      <Accordion.Control>
        <Stack gap={2}>
          <Text fw={500}>{bundle.name}</Text>
          {bundle.description && (
            <Text size="xs" c="dimmed">
              {bundle.description}
            </Text>
          )}
        </Stack>
      </Accordion.Control>
      <Accordion.Panel>
        {bundleQuery.isLoading && (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        )}

        {bundleQuery.isError && (
          <Alert
            color="red"
            icon={<IconAlertTriangle size={16} />}
            title={t("The role catalog is unavailable")}
          >
            {t("Please try again later.")}
          </Alert>
        )}

        {bundleQuery.data && (
          <Stack gap="xs">
            {computed.map(({ role, state, installed }) => (
              <CatalogRoleRow
                key={role.slug}
                role={role}
                state={state}
                checked={state === "import" ? !!selected?.has(role.slug) : false}
                onToggle={(checked) => onToggleSlug(role.slug, checked)}
                fromVersion={installed?.source?.version}
                onUpdate={
                  state === "update" && installed
                    ? () => updateMutation.mutate(installed.id)
                    : undefined
                }
                updating={updateMutation.isPending}
              />
            ))}

            <Group justify="flex-end" mt="xs">
              <Button
                size="xs"
                onClick={handleImport}
                loading={importMutation.isPending}
                disabled={checkedSlugs.length === 0}
              >
                {t("Import")}
              </Button>
            </Group>
          </Stack>
        )}
      </Accordion.Panel>
    </Accordion.Item>
  );
}

interface CatalogRoleRowProps {
  role: IAiRoleCatalogRole;
  state: "import" | "installed" | "update";
  checked: boolean;
  onToggle: (checked: boolean) => void;
  // The installed role's current source version (only set in the "update" state).
  fromVersion?: number;
  onUpdate?: () => void;
  updating: boolean;
}

/** A single catalog role row with its install-state affordance. */
function CatalogRoleRow({
  role,
  state,
  checked,
  onToggle,
  fromVersion,
  onUpdate,
  updating,
}: CatalogRoleRowProps) {
  const { t } = useTranslation();

  return (
    <Group justify="space-between" wrap="nowrap" align="flex-start">
      <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
        {state === "import" && (
          <Checkbox
            checked={checked}
            onChange={(event) => onToggle(event.currentTarget.checked)}
            aria-label={role.name}
          />
        )}
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text fw={500} truncate>
            {role.emoji ? `${role.emoji} ` : ""}
            {role.name}
          </Text>
          {role.description && (
            <Text size="xs" c="dimmed">
              {role.description}
            </Text>
          )}
        </Stack>
      </Group>

      <Group gap="xs" wrap="nowrap" style={{ flex: "none" }}>
        {state === "installed" && (
          <Badge size="sm" variant="light" color="gray">
            {t("Installed")}
          </Badge>
        )}
        {state === "update" && (
          <>
            <Badge size="sm" variant="light" color="blue">
              {t("v{{from}} → v{{to}}", {
                from: fromVersion ?? 0,
                to: role.version,
              })}
            </Badge>
            <Button size="xs" variant="light" onClick={onUpdate} loading={updating}>
              {t("Update")}
            </Button>
          </>
        )}
      </Group>
    </Group>
  );
}
