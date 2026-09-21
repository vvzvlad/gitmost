// Verified draw.io shape catalog for the `drawioShapes` tool (issue #424,
// stage 2). This is the fix for AI-generated diagrams' #1 defect: guessed
// `shape=mxgraph.*` names that render as EMPTY BOXES because the stencil does
// not exist. Instead of guessing, the model queries this catalog and gets back
// an exact, verified style-string + the stencil's default width/height.
//
// DATA SOURCE — the bundled index is the REAL jgraph/drawio-mcp shape index
// (`shape-search/search-index.json`, Apache-2.0, ~10 446 shapes), fetched
// verbatim and gzip-compressed to `packages/mcp/data/drawio-shape-index.json.gz`
// (~4.7 MB -> ~430 KB). Each record is `{ style, w, h, title, tags, type }`.
//
// REGENERATING THE INDEX (keeps the catalog from going stale as draw.io ships
// new stencils): jgraph publishes `shape-search/generate-index.js`, which
// rebuilds `search-index.json` from a draw.io release's `app.min.js`. To update:
//   1. clone https://github.com/jgraph/drawio-mcp (Apache-2.0)
//   2. run `node shape-search/generate-index.js` per its README
//   3. `gzip -9 -c search-index.json > packages/mcp/data/drawio-shape-index.json.gz`
// The record shape and this module's search stay unchanged.
//
// CURATED OVERLAY — on top of the raw index this module carries a small,
// hand-maintained overlay drawn from the issue #424 appendix (the aws-
// architecture-diagram-skill knowledge): AWS service rebrandings whose stencil
// name lags the product name, a BLOCKLIST of known-broken stencils mapped to
// working replacements, the category fillColor palette, the AWS group/subnet
// stencils, and the Azure image-style paths. The overlay is applied BEFORE the
// raw search so a query for a rebranded/blocked name returns the correct answer
// with an explanatory note instead of the empty-box stencil.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** A single catalog record as returned to the model. */
export interface ShapeResult {
  /** The exact draw.io style-string to put on the cell. */
  style: string;
  /** Default width in px for this stencil. */
  w: number;
  /** Default height in px for this stencil. */
  h: number;
  /** Human-readable stencil name. */
  title: string;
  /** "vertex" | "edge" (from the index). */
  type: string;
  /** AWS category (Compute/Database/…) when derivable, else undefined. */
  category?: string;
  /**
   * Present when the overlay rewrote/annotated the answer: a rebrand, a
   * blocklist replacement, or a usage hint. The model should surface it.
   */
  note?: string;
}

/** Raw record shape in the bundled index. */
interface IndexRecord {
  style: string;
  w: number;
  h: number;
  title: string;
  tags: string;
  type: string;
}

// --- AWS category fillColor palette (appendix) -----------------------------
// Service-level icons MUST carry a fillColor (invisible in PNG export
// otherwise); the color is the AWS category color.
export const AWS_CATEGORY_FILL: Record<string, string> = {
  Compute: "#ED7100",
  Networking: "#8C4FFF",
  Database: "#C925D1",
  Storage: "#3F8624",
  Security: "#DD344C",
  Integration: "#E7157B",
  "AI/ML": "#01A88D",
};

/** Reverse lookup: fillColor hex -> category name (for annotating results). */
const FILL_TO_CATEGORY: Record<string, string> = Object.fromEntries(
  Object.entries(AWS_CATEGORY_FILL).map(([k, v]) => [v.toLowerCase(), k]),
);

/**
 * Build the canonical service-level AWS icon style for a resIcon name. Mirrors
 * the appendix's full template: strokeColor=#ffffff is MANDATORY and fillColor
 * is the category color (defaults to AWS ink #232F3E when the category is
 * unknown, so the glyph is never invisible).
 */
export function awsServiceStyle(resIcon: string, category?: string): string {
  const fill = (category && AWS_CATEGORY_FILL[category]) || "#232F3E";
  return (
    "sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;" +
    `fillColor=${fill};strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;` +
    "verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;" +
    `shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.${resIcon}`
  );
}

// --- AWS rebrandings (appendix "gotcha" table) -----------------------------
// The stencil name lags the AWS product name; a naive query for the product
// name would miss (or return an empty box). Each alias maps to the REAL resIcon.
interface Rebrand {
  aliases: string[];
  resIcon: string;
  category?: string;
  note: string;
}
export const AWS_REBRANDS: Rebrand[] = [
  {
    aliases: ["opensearch", "open search", "amazon opensearch"],
    resIcon: "elasticsearch_service",
    category: "Database",
    note: "Amazon OpenSearch's stencil is still named `elasticsearch_service` (renamed in 2021).",
  },
  {
    aliases: ["eventbridge", "event bridge", "cloudwatch events"],
    resIcon: "eventbridge",
    category: "Integration",
    note: "Amazon EventBridge uses resIcon `eventbridge` (formerly CloudWatch Events).",
  },
  {
    aliases: ["vpc peering", "peering"],
    resIcon: "peering",
    category: "Networking",
    note: "VPC Peering is resIcon `peering`, NOT `vpc_peering` (which renders empty).",
  },
  {
    aliases: ["msk", "kafka", "managed streaming", "amazon msk"],
    resIcon: "managed_streaming_for_kafka",
    category: "Integration",
    note: "Amazon MSK is resIcon `managed_streaming_for_kafka`, NOT `msk`.",
  },
  {
    aliases: ["iam identity center", "identity center", "sso", "single sign on"],
    resIcon: "single_sign_on",
    category: "Security",
    note: "IAM Identity Center is resIcon `single_sign_on`, NOT `iam_identity_center`.",
  },
];

// --- BLOCKLIST of broken stencils (appendix) -------------------------------
// A query that names one of these gets the working replacement + a note; the
// broken stencil is never returned.
interface Blocked {
  bad: string;
  good: string;
  goodStyle?: (idx: IndexRecord[]) => ShapeResult | null;
  note: string;
}
export const AWS_BLOCKLIST: Blocked[] = [
  {
    bad: "dynamodb_table",
    good: "dynamodb",
    note: "`dynamodb_table` renders as an empty box; use resIcon `dynamodb`.",
  },
  {
    bad: "general_saml_token",
    good: "traditional_server",
    note: "`general_saml_token` is broken; use resIcon `traditional_server`.",
  },
  {
    bad: "kinesis_data_streams",
    good: "kinesis_data_streams",
    note: "`kinesis_data_streams` is unreliable across draw.io versions; verify it renders, or fall back to resIcon `kinesis`.",
  },
];

// --- AWS group / container stencils (appendix) -----------------------------
// Groups are transparent containers; these are the verified stencil names.
export const AWS_GROUP_STENCILS: ShapeResult[] = [
  {
    title: "AWS Cloud (group)",
    style:
      "points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];" +
      "outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;" +
      "pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_aws_cloud_alt;" +
      "strokeColor=#232F3E;fillColor=none;verticalAlign=top;align=left;spacingLeft=30;fontColor=#232F3E;dashed=0;",
    w: 400,
    h: 300,
    type: "vertex",
    note: "AWS Cloud boundary — transparent container (grIcon=group_aws_cloud_alt).",
  },
  {
    title: "VPC (group)",
    style:
      "points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];" +
      "outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;" +
      "pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_vpc2;" +
      "strokeColor=#8C4FFF;fillColor=none;verticalAlign=top;align=left;spacingLeft=30;fontColor=#8C4FFF;dashed=0;",
    w: 350,
    h: 250,
    type: "vertex",
    note: "VPC boundary — transparent container (grIcon=group_vpc2).",
  },
  {
    title: "Public Subnet (group)",
    style:
      "sketch=0;outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;" +
      "pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_public_subnet;" +
      "grStroke=0;strokeColor=none;fillColor=#E9F3E6;verticalAlign=top;align=left;spacingLeft=30;fontColor=#248814;dashed=0;",
    w: 300,
    h: 200,
    type: "vertex",
    note: "Public subnet — transparent container (grIcon=group_public_subnet).",
  },
  {
    title: "Private Subnet (group)",
    style:
      "sketch=0;outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;" +
      "pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_private_subnet;" +
      "grStroke=0;strokeColor=none;fillColor=#E6F2F8;verticalAlign=top;align=left;spacingLeft=30;fontColor=#147EBA;dashed=0;",
    w: 300,
    h: 200,
    type: "vertex",
    note: "Private subnet — transparent container (grIcon=group_private_subnet).",
  },
];

// --- Azure image-style stencils (appendix) ---------------------------------
// `shape=mxgraph.azure2.*` does not render in every host; the image-style path
// is the portable form. These are the verified known-working paths.
interface AzureIcon {
  aliases: string[];
  path: string;
  title: string;
}
const AZURE_ICONS: AzureIcon[] = [
  { aliases: ["front door", "front doors"], path: "networking/Front_Doors.svg", title: "Azure Front Door" },
  { aliases: ["api management", "apim"], path: "app_services/API_Management_Services.svg", title: "Azure API Management" },
  { aliases: ["cosmos", "cosmos db"], path: "databases/Azure_Cosmos_DB.svg", title: "Azure Cosmos DB" },
  { aliases: ["managed identity", "managed identities"], path: "identity/Managed_Identities.svg", title: "Azure Managed Identity" },
  { aliases: ["azure monitor", "monitor"], path: "management_governance/Monitor.svg", title: "Azure Monitor" },
  { aliases: ["application insights", "app insights"], path: "devops/Application_Insights.svg", title: "Azure Application Insights" },
];

/** Build the portable Azure image-style for a lib path (appendix template). */
export function azureImageStyle(path: string): string {
  return `sketch=0;points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],[0.5,1,0],[0.75,1,0],[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]];shadow=0;dashed=0;html=1;strokeColor=none;fillColor=#5E9BD9;labelPosition=center;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;image;aspect=fixed;image=img/lib/azure2/${path};`;
}

// --- index loading (lazy, cached) ------------------------------------------

let _index: IndexRecord[] | null = null;

/** Path to the bundled gzipped index, resolved relative to the built module. */
function indexPath(): URL {
  // build/lib/drawio-shapes.js -> ../../data/… -> packages/mcp/data/…
  return new URL("../../data/drawio-shape-index.json.gz", import.meta.url);
}

/** Load + decompress + parse the bundled index once, then cache it. */
export function loadShapeIndex(): IndexRecord[] {
  if (_index) return _index;
  const gz = readFileSync(indexPath());
  const json = gunzipSync(gz).toString("utf-8");
  const arr = JSON.parse(json) as IndexRecord[];
  _index = arr;
  return arr;
}

/** Derive an AWS category from a service-level icon's fillColor, if present. */
function categoryOf(style: string): string | undefined {
  const m = /fillColor=(#[0-9a-fA-F]{6})/.exec(style);
  if (!m) return undefined;
  return FILL_TO_CATEGORY[m[1].toLowerCase()];
}

function toResult(r: IndexRecord): ShapeResult {
  return {
    style: r.style,
    w: r.w,
    h: r.h,
    title: r.title,
    type: r.type,
    category: categoryOf(r.style),
  };
}

/** Find the best index record whose style carries `resIcon=<name>`. */
function findByResIcon(idx: IndexRecord[], name: string): IndexRecord | null {
  const needle = `resIcon=mxgraph.aws4.${name}`;
  // Prefer the service-level resourceIcon form; fall back to any style match.
  let fallback: IndexRecord | null = null;
  for (const r of idx) {
    if (r.style.includes(needle) && r.style.includes("resourceIcon")) return r;
    if (!fallback && r.style.includes(needle)) fallback = r;
  }
  return fallback;
}

/**
 * Score a record against a lowercased query. Higher is better; 0 = no match.
 * Exact title match ranks highest, then title substring, tag word, then a loose
 * style/tag substring. This is a cheap substring+token scorer, not a real fuzzy
 * matcher, which is plenty for the "give me the lambda icon" use case.
 */
function score(r: IndexRecord, q: string): number {
  const title = r.title.toLowerCase();
  const tags = r.tags.toLowerCase();
  const style = r.style.toLowerCase();
  let s = title === q ? 100 : 0;
  if (title !== q && title.includes(q)) s += 40 - Math.min(20, title.length - q.length);
  const words = q.split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (title.includes(w)) s += 12;
    if (new RegExp(`(^|\\W)${escapeRe(w)}(\\W|$)`).test(tags)) s += 8;
    else if (tags.includes(w)) s += 4;
    if (style.includes(w)) s += 2;
  }
  // Prefer the current AWS icon generation (aws4) over the deprecated aws3
  // stencils, which are the older visual style and often not what's wanted.
  if (s > 0) {
    if (style.includes("mxgraph.aws4")) s += 6;
    else if (style.includes("mxgraph.aws3")) s -= 12;
  }
  return s;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SearchShapesOptions {
  category?: string;
  limit?: number;
}

/**
 * Search the catalog. Applies the curated overlay first (blocklist replacement,
 * AWS rebrand, AWS group stencils, Azure image-style), then substring/tag/fuzzy
 * search over the bundled ~10 446-shape index. Returns up to `limit` results
 * (default 12) with exact style-strings and default sizes.
 */
export function searchShapes(
  query: string,
  opts: SearchShapesOptions = {},
): ShapeResult[] {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 12));
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const idx = loadShapeIndex();
  const out: ShapeResult[] = [];
  const seen = new Set<string>();
  const push = (r: ShapeResult) => {
    if (seen.has(r.style)) return;
    seen.add(r.style);
    out.push(r);
  };

  // 1. BLOCKLIST: a query naming a broken stencil returns the replacement.
  for (const b of AWS_BLOCKLIST) {
    if (q.includes(b.bad) || b.bad.includes(q.replace(/\s+/g, "_"))) {
      const rec = findByResIcon(idx, b.good);
      if (rec) push({ ...toResult(rec), note: b.note });
    }
  }

  // 2. AWS rebrandings: surface the correct resIcon with the rename note.
  for (const rb of AWS_REBRANDS) {
    if (rb.aliases.some((a) => q === a || q.includes(a) || a.includes(q))) {
      const rec = findByResIcon(idx, rb.resIcon);
      if (rec) {
        push({ ...toResult(rec), category: rec ? categoryOf(rec.style) ?? rb.category : rb.category, note: rb.note });
      } else {
        push({
          style: awsServiceStyle(rb.resIcon, rb.category),
          w: 78,
          h: 78,
          title: rb.resIcon,
          type: "vertex",
          category: rb.category,
          note: rb.note,
        });
      }
    }
  }

  // 3. Azure image-style icons.
  for (const az of AZURE_ICONS) {
    if (az.aliases.some((a) => q.includes(a) || a.includes(q))) {
      push({
        style: azureImageStyle(az.path),
        w: 68,
        h: 68,
        title: az.title,
        type: "vertex",
        category: "Azure",
        note: "Azure: portable image-style (shape=mxgraph.azure2.* does not render in every host).",
      });
    }
  }

  // 4. AWS group/container stencils.
  if (/\b(group|container|boundary|vpc|subnet|cloud|account)\b/.test(q)) {
    for (const g of AWS_GROUP_STENCILS) {
      if (g.title.toLowerCase().includes(q) || q.split(/\s+/).some((w) => g.title.toLowerCase().includes(w))) {
        push(g);
      }
    }
  }

  // 5. General index search (substring + tags + loose fuzzy).
  const catFilter = opts.category?.toLowerCase();
  const scored: { r: IndexRecord; s: number }[] = [];
  for (const r of idx) {
    const s = score(r, q);
    if (s <= 0) continue;
    if (catFilter) {
      const cat = categoryOf(r.style)?.toLowerCase();
      const inStyle = r.style.toLowerCase().includes(catFilter);
      if (cat !== catFilter && !inStyle) continue;
    }
    scored.push({ r, s });
  }
  scored.sort((a, b) => b.s - a.s || a.r.title.length - b.r.title.length);
  for (const { r } of scored) {
    if (out.length >= limit) break;
    push(toResult(r));
  }

  return out.slice(0, limit);
}
