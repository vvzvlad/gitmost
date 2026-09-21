/**
 * Reusable round-trip-STABILITY matrix helper (fixtures-first).
 *
 * A single stored node authored WITHOUT a given string attribute (attr
 * absent / undefined) must not gain a phantom EMPTY-STRING value after a
 * markdown round-trip — the "empty-string-vs-absent" churn class. This helper,
 * given a node spec, drives a matrix of attribute combinations through the REAL
 * converter (`convertProseMirrorToMarkdown` -> `markdownToProseMirror`) and
 * asserts byte-stability on two contours:
 *
 *   1. RAW round-trip: for the node under test, every attribute the round-trip
 *      materializes must equal what the INPUT authored — an authored attr keeps
 *      its value, an ABSENT attr may only reappear at its SCHEMA DEFAULT. If an
 *      absent attr comes back as a NON-default value (e.g. `alt: ""` where the
 *      default is `null`), that is an instability and is reported precisely as
 *      `type.attr: absent -> "<got>"`. This is the contour git-sync / stored
 *      JSON diffs on, so masking it only in `canonicalize` would leave the noise.
 *
 *   2. CANONICAL round-trip: `canonicalizeContent(original)` must deep-equal
 *      `canonicalizeContent(roundtrip)` (a second, semantic contour).
 *
 * The ONLY normalization the helper treats as allowed (not an instability) is
 * the DOCUMENTED numeric width/height/size/aspectRatio -> string coercion the
 * converter performs on purpose (a stored numeric `640` re-parses via
 * `getAttribute` as the string `"640"`). It is encoded here as an explicit
 * per-spec `numericStringAttrs` set applied to BOTH contours, NOT a silent skip.
 *
 * The helper is node-type agnostic: image and the whole media family share the
 * `align !== "center"` predicate + `<!--name {…}-->` comment machinery, so one
 * matrix guards the shared class.
 */
import { getSchema } from "@tiptap/core";
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  canonicalizeContent,
  docmostExtensions,
} from "../src/lib/index.js";
import { firstDivergence } from "./roundtrip-helpers.js";

/** One attribute's two probe values. */
export interface AttrMatrixEntry {
  /** Attribute name on the node. */
  attr: string;
  /**
   * The "default" pick. `undefined` means the attribute is OMITTED entirely
   * (the absent case — the one that can materialize an empty string on import).
   * A concrete value is authored verbatim.
   */
  default: unknown;
  /** A representative NON-default value to exercise (must survive verbatim). */
  nonDefault: unknown;
  /**
   * Marks the attr as a member of the EMPTY-STRING class the fix targets: a
   * string attr whose schema default is `null`/absent and whose parseHTML
   * coerces `"" -> default` (image/drawio `alt`+`title`, video `alt` via
   * aria-label, pdf/attachment `name`, attachment `mime`). Set true to also
   * drive the THIRD-STATE convergence case (see runConvergenceCase) for this
   * attr. Attrs whose default is NOT null (e.g. embed `provider`, default "")
   * or that are not `""`-coerced (control attrs) are left unset.
   */
  emptyStringClass?: boolean;
}

/** A node type + the attribute matrix to sweep for it. */
export interface NodeStabilitySpec {
  /** Node type (e.g. "image", "video"). */
  type: string;
  /** Attributes always present on the node (e.g. `{ src: "/i.png" }`). */
  baseAttrs?: Record<string, unknown>;
  /** Attributes to sweep at default and non-default. */
  attrMatrix: AttrMatrixEntry[];
  /**
   * Attributes whose numeric -> string coercion on round-trip is DOCUMENTED and
   * intentional; compared modulo `String(x)` on both sides. Defaults to the
   * converter's known sizing set.
   */
  numericStringAttrs?: string[];
}

/** A single unstable finding, legible enough to tie a gate-lock to. */
export interface Instability {
  type: string;
  attr: string;
  /** What the input authored: the literal value, or the ABSENT sentinel. */
  authored: unknown | typeof ABSENT;
  /** What the round-trip produced. */
  got: unknown;
  /** What a stable round-trip should have produced (authored value or default). */
  expected: unknown;
}

/** One matrix cell's result. */
export interface ComboResult {
  label: string;
  authored: Record<string, unknown>;
  /** RAW-contour instabilities on the node under test. */
  raw: Instability[];
  /** CANONICAL-contour divergence (path + values) or null when equal. */
  canonical: { path: string; a: unknown; b: unknown } | null;
  /** True when the node type failed to round-trip at all (structural loss). */
  missing: boolean;
  md: string;
}

/** Whole-matrix report for one node spec. */
export interface MatrixReport {
  type: string;
  combos: ComboResult[];
}

/** Sentinel marking an attribute the input did NOT author. */
export const ABSENT = Symbol("ABSENT");

const DEFAULT_NUMERIC_STRING_ATTRS = [
  "width",
  "height",
  "size",
  "aspectRatio",
];

// The ProseMirror schema the converter targets — its attribute `default`s are
// the authoritative "what an absent attr should re-materialize as" oracle.
const schema = getSchema(docmostExtensions);

/** Read the schema default for every attribute of a node type. */
function schemaDefaults(type: string): Record<string, unknown> {
  const specAttrs = (schema.nodes[type]?.spec?.attrs ?? {}) as Record<
    string,
    { default: unknown }
  >;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(specAttrs)) out[k] = v.default;
  return out;
}

/** Find the first node of a given type anywhere in a PM doc tree. */
function findFirst(node: any, type: string): any {
  if (node && node.type === type) return node;
  for (const child of node?.content ?? []) {
    const hit = findFirst(child, type);
    if (hit) return hit;
  }
  return null;
}

/** Coerce a scalar for the documented numeric->string comparison. */
const numStr = (x: unknown): unknown => (x == null ? x : String(x));

/**
 * Enumerate the cartesian product of the matrix: every attribute independently
 * at its default (index 0) or non-default (index 1) pick. The all-default
 * corner is included (the baseline). Small by construction (2^N over a handful
 * of at-risk string attrs).
 */
function enumerateCombos(matrix: AttrMatrixEntry[]): number[][] {
  let combos: number[][] = [[]];
  for (let i = 0; i < matrix.length; i++) {
    const next: number[][] = [];
    for (const c of combos) {
      next.push([...c, 0]);
      next.push([...c, 1]);
    }
    combos = next;
  }
  return combos;
}

/** Build the authored attrs for one combo pick vector. */
function authoredAttrs(
  spec: NodeStabilitySpec,
  picks: number[],
): Record<string, unknown> {
  const attrs: Record<string, unknown> = { ...(spec.baseAttrs ?? {}) };
  spec.attrMatrix.forEach((entry, i) => {
    if (picks[i] === 1) {
      attrs[entry.attr] = entry.nonDefault;
    } else if (entry.default !== undefined) {
      attrs[entry.attr] = entry.default;
    }
    // default === undefined -> OMIT the attr entirely (the absent case).
  });
  return attrs;
}

/** Human-readable label for a combo (which attrs are at non-default). */
function comboLabel(spec: NodeStabilitySpec, picks: number[]): string {
  const on = spec.attrMatrix
    .filter((_, i) => picks[i] === 1)
    .map((e) => e.attr);
  return on.length === 0 ? "<all-default>" : on.join("+");
}

/**
 * Run the full stability matrix for one node spec and return a structured
 * report (does NOT throw — the caller asserts, so a failure can print the whole
 * report). Every combo runs the real export->import pipeline once.
 */
export async function runStabilityMatrix(
  spec: NodeStabilitySpec,
): Promise<MatrixReport> {
  const numericStringAttrs = new Set(
    spec.numericStringAttrs ?? DEFAULT_NUMERIC_STRING_ATTRS,
  );
  const defaults = schemaDefaults(spec.type);
  const combos: ComboResult[] = [];

  for (const picks of enumerateCombos(spec.attrMatrix)) {
    const authored = authoredAttrs(spec, picks);
    const doc = { type: "doc", content: [{ type: spec.type, attrs: authored }] };
    const md = convertProseMirrorToMarkdown(doc);
    const rt = await markdownToProseMirror(md);
    const node = findFirst(rt, spec.type);

    const result: ComboResult = {
      label: comboLabel(spec, picks),
      authored,
      raw: [],
      canonical: null,
      missing: node == null,
      md,
    };

    if (node != null) {
      // RAW contour: every materialized attr must equal the authored value, or
      // (for an absent attr) the schema default — modulo the documented numeric
      // string coercion.
      const rtAttrs = (node.attrs ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(rtAttrs)) {
        const authoredHas = Object.prototype.hasOwnProperty.call(authored, key);
        const expected = authoredHas ? authored[key] : defaults[key];
        let got = rtAttrs[key];
        let exp = expected;
        if (numericStringAttrs.has(key)) {
          got = numStr(got);
          exp = numStr(exp);
        }
        if (firstDivergence(got, exp) !== null) {
          result.raw.push({
            type: spec.type,
            attr: key,
            authored: authoredHas ? authored[key] : ABSENT,
            got: rtAttrs[key],
            expected,
          });
        }
      }

      // CANONICAL contour: canonical forms deep-equal, modulo the same numeric
      // string coercion (applied to both trees so a documented coercion is not
      // counted as a divergence).
      const ca = normalizeNumeric(canonicalizeContent(doc), numericStringAttrs);
      const cb = normalizeNumeric(canonicalizeContent(rt), numericStringAttrs);
      result.canonical = firstDivergence(ca, cb);
    }

    combos.push(result);
  }

  return { type: spec.type, combos };
}

/**
 * Deep-copy a canonical tree, coercing the documented numeric->string attrs to
 * their string form so an intentional `640 -> "640"` coercion is not reported
 * as a canonical divergence. Only touches the listed attribute keys.
 */
function normalizeNumeric(node: any, attrs: Set<string>): any {
  if (Array.isArray(node)) return node.map((n) => normalizeNumeric(n, attrs));
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    if (key === "attrs" && node.attrs && typeof node.attrs === "object") {
      const a: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.attrs)) {
        a[k] = attrs.has(k) ? numStr(v) : v;
      }
      out.attrs = a;
    } else {
      out[key] = normalizeNumeric(node[key], attrs);
    }
  }
  return out;
}

/** Flatten a report to just its unstable combos (for a terse assertion). */
export function unstableCombos(report: MatrixReport): ComboResult[] {
  return report.combos.filter(
    (c) => c.missing || c.raw.length > 0 || c.canonical !== null,
  );
}

// ---------------------------------------------------------------------------
// THIRD STATE: an EXPLICITLY-STORED empty string on a string attr.
//
// The matrix above sweeps TWO states per string attr: absent/default and a
// non-default value — and asserts FIRST-pass byte-stability for both. There is
// a third, degenerate state the matrix does NOT cover: the attr stored as a
// LITERAL `""`. This is DISTINCT from "the node never had the attr": a user
// types an alt in the editor, then deletes it, and Tiptap's
// `updateAttributes({ alt: "" })` persists a literal `alt: ""` in the stored
// JSON. There is no absent-vs-"" distinction in the DOM once serialized, so the
// fix's `getAttribute("alt") || null` coercion canonicalizes BOTH to the
// default (`null`).
//
// Consequence — and this is CORRECT, not a bug: a doc carrying an explicit `""`
// converges to the default on the FIRST round-trip (a ONE-TIME diff: `"" ->
// null`), then is byte-stable from the SECOND round-trip on (idempotent). So
// this state must be pinned with a DIFFERENT contract than the matrix's:
//   - do NOT assert first-pass byte-stability (the first pass legitimately
//     changes `""` -> default), and
//   - DO assert the first pass converges to the default AND the second pass is
//     idempotent (rt2 deep-equals rt1).
//
// A future sync/QA pass diffing stored pages will see this one-time `"" -> null`
// normalization exactly once per affected node; it is the converter canon, not
// corruption, and must not be flagged as data loss.
// ---------------------------------------------------------------------------

/** Result of the third-state ("explicit empty string") convergence probe. */
export interface ConvergenceResult {
  type: string;
  attr: string;
  /** The schema default the attr must converge to on pass 1 (null / absent). */
  expectedDefault: unknown;
  /** rt1's materialized value for the attr — must equal `expectedDefault`. */
  firstPassValue: unknown;
  /** True when the node round-tripped AND rt1 converged the attr to default. */
  convergedToDefault: boolean;
  /** rt1-vs-rt2 divergence; MUST be null (idempotent from pass 2 on). */
  secondPassDivergence: { path: string; a: unknown; b: unknown } | null;
  /** True when the node type failed to round-trip at all (structural loss). */
  missing: boolean;
}

/** Round-trip a full PM doc through the real converter once. */
async function roundtripDoc(doc: any): Promise<any> {
  return markdownToProseMirror(convertProseMirrorToMarkdown(doc));
}

/**
 * Third-state convergence probe for one string attr of the empty-string class.
 *
 * (a) builds a doc with the attr EXPLICITLY set to `""` (baseAttrs + `""`),
 * (b) rt1 = roundtrip(doc); asserts rt1's attr equals the schema default — the
 *     documented ONE-TIME `"" -> default` normalization (NOT byte-stable vs the
 *     `""` input, so first-pass stability is deliberately NOT asserted here),
 * (c) rt2 = roundtrip(rt1); asserts rt2 deep-equals rt1 — idempotent from the
 *     second round-trip on.
 *
 * Returns a structured result (does NOT throw) so the caller can assert and
 * print. Reusable across the whole node family: drive it for every attr flagged
 * `emptyStringClass` on every spec (see convergenceCasesFor / the test driver).
 */
export async function runConvergenceCase(
  spec: NodeStabilitySpec,
  attr: string,
): Promise<ConvergenceResult> {
  const expectedDefault = schemaDefaults(spec.type)[attr];

  // (a) The degenerate third state: attr persisted as a LITERAL "".
  const authored = { ...(spec.baseAttrs ?? {}), [attr]: "" };
  const doc = { type: "doc", content: [{ type: spec.type, attrs: authored }] };

  // (b) First round-trip: "" must normalize to the default (a one-time diff).
  const rt1 = await roundtripDoc(doc);
  const node1 = findFirst(rt1, spec.type);
  const firstPassValue = node1?.attrs?.[attr];
  const convergedToDefault =
    node1 != null && firstDivergence(firstPassValue, expectedDefault) === null;

  // (c) Second round-trip: must be byte-stable (rt2 deep-equals rt1). We compare
  // the WHOLE docs — both are converter OUTPUTS already in the same materialized
  // form (numeric attrs are strings on both sides), so no numeric normalization
  // is needed here, unlike the raw/canonical contours above.
  const rt2 = node1 != null ? await roundtripDoc(rt1) : rt1;
  const secondPassDivergence =
    node1 != null ? firstDivergence(rt1, rt2) : null;

  return {
    type: spec.type,
    attr,
    expectedDefault,
    firstPassValue,
    convergedToDefault,
    secondPassDivergence,
    missing: node1 == null,
  };
}

/** The attrs of a spec flagged as members of the empty-string class. */
export function convergenceCasesFor(spec: NodeStabilitySpec): string[] {
  return spec.attrMatrix
    .filter((e) => e.emptyStringClass)
    .map((e) => e.attr);
}

/** True when a convergence result honours the "converges once, then stable" contract. */
export function convergenceOk(r: ConvergenceResult): boolean {
  return !r.missing && r.convergedToDefault && r.secondPassDivergence === null;
}

/** Render a convergence result as a legible one-liner for a failed assertion. */
export function formatConvergence(r: ConvergenceResult): string {
  if (r.missing) return `${r.type}.${r.attr}: DID-NOT-ROUND-TRIP`;
  const parts: string[] = [];
  if (!r.convergedToDefault) {
    parts.push(
      `pass1 did NOT converge: got ${JSON.stringify(r.firstPassValue)} (expected default ${JSON.stringify(r.expectedDefault)})`,
    );
  }
  if (r.secondPassDivergence) {
    parts.push(
      `pass2 NOT idempotent @ ${r.secondPassDivergence.path}: ${JSON.stringify(r.secondPassDivergence.a)} vs ${JSON.stringify(r.secondPassDivergence.b)}`,
    );
  }
  const status = parts.length === 0 ? "converges-once-then-stable" : parts.join("; ");
  return `${r.type}.${r.attr}: ${status}`;
}

/** Render a report as a legible multi-line string for a failed assertion. */
export function formatReport(report: MatrixReport): string {
  const lines: string[] = [`node "${report.type}":`];
  for (const c of report.combos) {
    const flags: string[] = [];
    if (c.missing) flags.push("DID-NOT-ROUND-TRIP");
    for (const i of c.raw) {
      const authored =
        i.authored === ABSENT ? "absent" : JSON.stringify(i.authored);
      flags.push(
        `RAW ${i.type}.${i.attr}: ${authored} -> ${JSON.stringify(i.got)} (expected ${JSON.stringify(i.expected)})`,
      );
    }
    if (c.canonical) {
      flags.push(
        `CANON @ ${c.canonical.path}: ${JSON.stringify(c.canonical.a)} vs ${JSON.stringify(c.canonical.b)}`,
      );
    }
    const status = flags.length === 0 ? "stable" : flags.join("; ");
    lines.push(`  [${c.label}] ${status}`);
  }
  return lines.join("\n");
}
