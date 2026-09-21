// Progressive-disclosure authoring reference for the `drawioGuide` tool
// (issue #424, stage 2). The FULL draw.io authoring guide would bloat every
// context window, so it is split into small sections the model reads on demand:
//   skeleton | layout | containers | icons-aws | icons-azure
// Content is written directly from the issue #424 appendix (the layout
// heuristics, container rules, AWS icon patterns + gotchas + blocklist, and
// Azure image-style paths). ACCEPTANCE: each section stays <= ~4 KB so pulling
// one is cheap.

export type GuideSection =
  | "skeleton"
  | "layout"
  | "containers"
  | "icons-aws"
  | "icons-azure";

export const GUIDE_SECTIONS: GuideSection[] = [
  "skeleton",
  "layout",
  "containers",
  "icons-aws",
  "icons-azure",
];

const SKELETON = `# drawioGuide: skeleton

Canonical mxGraph skeleton. id="0" and id="1" are MANDATORY sentinels; every
real cell has parent="1" (or a container id). Set adaptiveColors="auto" on the
model so Docmost's dark theme adapts strokeColor/fillColor/fontColor="default".

\`\`\`xml
<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" adaptiveColors="auto"
    page="1" pageWidth="850" pageHeight="1100">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="Start" style="rounded=1;whiteSpace=wrap;html=1;"
        vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="140" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="3" value="Store" style="shape=cylinder3;whiteSpace=wrap;html=1;"
        vertex="1" parent="1">
      <mxGeometry x="40" y="200" width="80" height="80" as="geometry"/>
    </mxCell>
    <mxCell id="e1" edge="1" parent="1" source="2" target="3"
        style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>
\`\`\`

Three accepted inputs to drawioCreate/drawioUpdate: a bare <mxGraphModel>, a
full <mxfile> (decoded to its first page), or a raw list of <mxCell> (the server
wraps it and adds the id=0/id=1 sentinels).

Hard rules: a cell is vertex="1" XOR edge="1" (a container/group is neither);
every edge has a child <mxGeometry relative="1" as="geometry"/>; ids are unique;
no XML comments; put html=1 in styles and XML-escape value (& -> &amp;,
< -> &lt;); a newline in a label is &#xa;, never a literal \\n. Don't guess
shape=mxgraph.* names — call drawioShapes first (a wrong name renders empty).`;

const LAYOUT = `# drawioGuide: layout

Turn "make it look good" into checkable numbers. Or pass layout:"elk" to
drawioCreate/drawioUpdate and the server computes coordinates for you (ELK
layered layout, honouring nested containers) — you declare structure, it places
pixels.

Spacing (when placing by hand):
- Horizontal gap between shapes 200-220px; vertical between rows/lanes 250px;
  auxiliary services (monitoring, DLQ) sit below the main flow with 280px+ gap.
- Coordinates are multiples of 10 (grid). Base sizes: rectangle 140x60, diamond
  140x80, circle 60x60; cloud icons 78x78 primary / 65x65 secondary; font 12px.
- Main flow left-to-right, one primary axis; <=3-4 lanes/zones; one icon/service.

Edges:
- <=1 bend per edge (ideally 0); an edge must not cross another shape's bbox;
  two edges must not lie on top of each other.
- Give explicit exitX/exitY/entryX/entryY for every non-straight link or the
  orthogonal router drives lines through shapes. Vertical link:
  exitX=0.5;exitY=1 -> entryX=0.5;entryY=0. For 2+ links on one node, spread the
  attach points 0.25 / 0.5 / 0.75.
- Base edge style:
  edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;strokeWidth=2;exitX=1;exitY=0.5;entryX=0;entryY=0.5;
- Edge labels: 1-2 words max, labelBackgroundColor=#F5F5F5;fontSize=11;. Don't
  label an obvious flow (Lambda->DynamoDB needs no "Write"); prefer numbering
  stages (1,2,3) over many labels.
- Line semantics: solid = main/sync; dashed=1 = async; red dashed
  strokeColor=#DD344C = error path.

Alignment: centre a child under its parent by math, not by eye:
child.x = parent.center_x - child.width/2.

The linter returns quality WARNINGS (bbox overlap, edge through a shape,
edge-on-edge, gap <150px, label wider than its shape, negative/off-page coords).
They do not block the write — fix them and retry, max 2 iterations.`;

const CONTAINERS = `# drawioGuide: containers

Groups/zones are TRANSPARENT containers. A coloured group fill is an instant
"AI-generated" tell — never fill a group.

- Every group: container=1;dropTarget=1;fillColor=none;. It is a cell with
  vertex unset AND edge unset.
- Children set parent="<groupId>" and their coordinates are RELATIVE to the
  group's top-left, not absolute.
- An edge between cells in DIFFERENT containers must be parent="1" (the layer),
  otherwise it is clipped to one container and disappears.
- Keep the group title off the group icon:
  spacingLeft=40;spacingTop=-4;.
- Leave >=30px padding between children and the group frame.
- Draw edges on the BACK layer (place their <mxCell> BEFORE the shapes in XML)
  and keep >=20px between an arrow and a label.

Swimlanes: style=swimlane;horizontal=0;startSize=110;. Lanes are parent="1";
their members are children of the lane.

Example (transparent zone with two children and an internal edge):
\`\`\`xml
<mxCell id="z1" value="VPC" style="rounded=0;container=1;dropTarget=1;fillColor=none;verticalAlign=top;spacingLeft=40;spacingTop=-4;html=1;"
    vertex="1" parent="1">
  <mxGeometry x="40" y="40" width="320" height="200" as="geometry"/>
</mxCell>
<mxCell id="a" value="App" style="rounded=1;html=1;" vertex="1" parent="z1">
  <mxGeometry x="30" y="40" width="120" height="60" as="geometry"/>
</mxCell>
<mxCell id="b" value="DB" style="shape=cylinder3;html=1;" vertex="1" parent="z1">
  <mxGeometry x="30" y="120" width="80" height="60" as="geometry"/>
</mxCell>
<mxCell id="ab" edge="1" parent="z1" source="a" target="b">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
\`\`\``;

const ICONS_AWS = `# drawioGuide: icons-aws

Two mutually-exclusive AWS icon patterns — mixing them is the #1 cause of empty
boxes. Always call drawioShapes for the exact resIcon name; do not guess.

| Level | style | strokeColor |
|---|---|---|
| Service | shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.<NAME> | #ffffff (required) |
| Resource | shape=mxgraph.aws4.<NAME> | none (required) |

Full service-level template (fillColor is REQUIRED — the glyph is invisible in
PNG export without it):
\`\`\`
sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=<category>;strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.<NAME>
\`\`\`

Category fillColor: Compute #ED7100, Networking #8C4FFF, Database #C925D1,
Storage #3F8624, Security #DD344C, Integration #E7157B, AI/ML #01A88D.

Rebrandings (stencil name lags the product name):
- Amazon OpenSearch -> resIcon elasticsearch_service (renamed 2021)
- Amazon EventBridge -> resIcon eventbridge (was CloudWatch Events)
- VPC Peering -> resIcon peering (NOT vpc_peering -> empty box)
- Amazon MSK -> resIcon managed_streaming_for_kafka (NOT msk)
- IAM Identity Center -> resIcon single_sign_on (NOT iam_identity_center)

Blocklist -> replacement: dynamodb_table -> dynamodb; general_saml_token ->
traditional_server; kinesis_data_streams is unreliable. An unknown service ->
generic resIcon=mxgraph.aws4.general_AWScloud WITH a label; an unnamed coloured
rectangle is forbidden.

Group stencils (transparent containers): AWS Cloud group_aws_cloud_alt, VPC
group_vpc2, Subnet group_security_group, Account group_account; subnets use
shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_public_subnet;.`;

const ICONS_AZURE = `# drawioGuide: icons-azure

shape=mxgraph.azure2.* does NOT render in every host. Use the portable
image-style instead:
\`\`\`
image;aspect=fixed;html=1;image=img/lib/azure2/<category>/<Icon>.svg;
\`\`\`

Known working paths:
- networking/Front_Doors.svg
- app_services/API_Management_Services.svg
- databases/Azure_Cosmos_DB.svg
- identity/Managed_Identities.svg
- management_governance/Monitor.svg
- devops/Application_Insights.svg

For maximum robustness (e.g. PNG export on a host without the bundled lib), use
an absolute URL fallback for the image:
\`\`\`
https://raw.githubusercontent.com/jgraph/drawio/dev/src/main/webapp/img/lib/azure2/<category>/<Icon>.svg
\`\`\`

Call drawioShapes with the service name (e.g. "cosmos", "api management",
"front door") to get the exact image-style string and default 68x68 size.`;

const CONTENT: Record<GuideSection, string> = {
  skeleton: SKELETON,
  layout: LAYOUT,
  containers: CONTAINERS,
  "icons-aws": ICONS_AWS,
  "icons-azure": ICONS_AZURE,
};

/**
 * Return one guide section, or (when `section` is omitted/unknown) an index
 * listing the available sections plus a one-line summary each. Each section is
 * kept under ~4 KB so pulling it does not bloat the model's context.
 */
export function getGuideSection(section?: string): {
  section: string;
  content: string;
  sections: GuideSection[];
} {
  const key = (section ?? "").trim().toLowerCase() as GuideSection;
  if (section && GUIDE_SECTIONS.includes(key)) {
    return { section: key, content: CONTENT[key], sections: GUIDE_SECTIONS };
  }
  const index =
    "# drawioGuide\n\nProgressive-disclosure draw.io authoring reference. " +
    "Call drawioGuide(section) with one of:\n" +
    "- skeleton — canonical mxGraph XML, sentinels, the three accepted inputs, hard rules\n" +
    "- layout — spacing heuristics, edge routing, the layout:\"elk\" option, quality warnings\n" +
    "- containers — transparent groups, relative child coords, cross-container edges, swimlanes\n" +
    "- icons-aws — the service/resource icon patterns, category colors, rebrandings, blocklist\n" +
    "- icons-azure — the portable image-style paths\n\n" +
    "Also call drawioShapes(query) for verified stencil style-strings.";
  return { section: "index", content: index, sections: GUIDE_SECTIONS };
}
