/**
 * Convert ProseMirror/TipTap JSON content to Markdown
 * Supports all Docmost-specific node types and extensions
 */
export function convertProseMirrorToMarkdown(content) {
    if (!content || !content.content)
        return "";
    // Escape a value interpolated into an HTML double-quoted attribute value
    // (textAlign, colors, image src, math `text`, all data-* attrs, etc.). In the
    // ATTRIBUTE context only the quote that delimits the value and the ampersand
    // that starts an entity are special, so we escape ONLY & " (and ' for safety
    // when single-quoted delimiters are used). We deliberately do NOT escape < or
    // >: the HTML re-parser (parse5/jsdom via @tiptap/html) does NOT decode
    // &lt;/&gt; back inside attribute values, so escaping them would corrupt the
    // stored data (e.g. a math node's LaTeX `a < b`) and ACCUMULATE escapes on
    // every round-trip (`a < b` -> `a &lt; b` -> `a &amp;lt; b`). Escaping & "
    // keeps the value inert against attribute-injection while staying idempotent.
    // NOTE: escape ONLY & and " here. The value is always wrapped in double
    // quotes, so " is the only delimiter; ' is NOT special in a double-quoted
    // value, and parse5 does not decode &#39; back inside attribute values, so
    // escaping ' would (like < >) corrupt the value and accumulate &amp; on every
    // round-trip. Escaping & and " is idempotent (parse5 decodes them back).
    const escapeAttr = (value) => String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;");
    // Escape a value placed as HTML element TEXT content (between tags), where
    // <, >, and & are all significant. Used for text rendered inside raw-HTML
    // blocks (table cells / columns) so stored characters cannot inject markup.
    const escapeHtmlText = (value) => String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    // Percent-encode characters that would break out of a markdown URL target
    // (...) — whitespace/newlines and parentheses — so a stored src stays a
    // single inert token (used for image/video/youtube srcs).
    const encodeMdUrl = (value) => String(value || "")
        .replace(/\s/g, (c) => (c === " " ? "%20" : encodeURIComponent(c)))
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29");
    const processNode = (node) => {
        const type = node.type;
        const nodeContent = node.content || [];
        switch (type) {
            case "doc":
                return nodeContent.map(processNode).join("\n\n");
            case "paragraph":
                const text = nodeContent.map(processNode).join("");
                const align = node.attrs?.textAlign;
                if (align && align !== "left") {
                    return `<div align="${escapeAttr(align)}">${text}</div>`;
                }
                return text || "";
            case "heading":
                const level = node.attrs?.level || 1;
                const headingText = nodeContent.map(processNode).join("");
                return "#".repeat(level) + " " + headingText;
            case "text":
                let textContent = node.text || "";
                // Apply marks (bold, italic, code, etc.)
                if (node.marks) {
                    // The schema's `code` mark declares `excludes: "_"` — it excludes every
                    // other inline mark — so the editor can NEVER produce a text run that
                    // carries `code` together with another mark, and on import any
                    // co-occurring mark is always dropped (the run comes back as code-only).
                    // The lossless, byte-stable behavior is therefore: when a run has the
                    // `code` mark, emit ONLY the backtick code span and ignore every other
                    // mark, so md1 is already code-only and md2 === md1. Runs WITHOUT a code
                    // mark are rendered exactly as before.
                    const markTypes = node.marks.map((m) => m.type);
                    const hasCode = markTypes.includes("code");
                    if (hasCode) {
                        textContent = `\`${textContent}\``;
                        return textContent;
                    }
                    const codeCombined = false;
                    for (const mark of node.marks) {
                        switch (mark.type) {
                            case "bold":
                                textContent = codeCombined
                                    ? `<strong>${textContent}</strong>`
                                    : `**${textContent}**`;
                                break;
                            case "italic":
                                textContent = codeCombined
                                    ? `<em>${textContent}</em>`
                                    : `*${textContent}*`;
                                break;
                            case "code":
                                // When combined with another mark, wrap as <code> so the
                                // surrounding HTML marks can nest around it; otherwise use the
                                // plain backtick span.
                                textContent = codeCombined
                                    ? `<code>${textContent}</code>`
                                    : `\`${textContent}\``;
                                break;
                            case "link": {
                                const href = mark.attrs?.href || "";
                                const title = mark.attrs?.title;
                                if (codeCombined) {
                                    // Emit an HTML anchor so it can wrap the nested <code>.
                                    const safeHref = escapeAttr(href);
                                    if (title) {
                                        textContent = `<a href="${safeHref}" title="${escapeAttr(String(title))}">${textContent}</a>`;
                                    }
                                    else {
                                        textContent = `<a href="${safeHref}">${textContent}</a>`;
                                    }
                                }
                                else if (title) {
                                    // Emit the optional markdown link title; escape an embedded
                                    // double-quote so it cannot terminate the title string early.
                                    const safeTitle = String(title).replace(/"/g, '\\"');
                                    textContent = `[${textContent}](${href} "${safeTitle}")`;
                                }
                                else {
                                    textContent = `[${textContent}](${href})`;
                                }
                                break;
                            }
                            case "strike":
                                textContent = codeCombined
                                    ? `<s>${textContent}</s>`
                                    : `~~${textContent}~~`;
                                break;
                            case "underline":
                                textContent = `<u>${textContent}</u>`;
                                break;
                            case "subscript":
                                textContent = `<sub>${textContent}</sub>`;
                                break;
                            case "superscript":
                                textContent = `<sup>${textContent}</sup>`;
                                break;
                            case "highlight": {
                                // Preserve a null/empty color as a plain highlight (a bare
                                // <mark> with no background-color); only emit the style when a
                                // color is actually set, so a plain highlight is not forced to
                                // yellow on export.
                                const color = mark.attrs?.color;
                                textContent = color
                                    ? `<mark style="background-color: ${escapeAttr(color)}">${textContent}</mark>`
                                    : `<mark>${textContent}</mark>`;
                                break;
                            }
                            case "textStyle":
                                if (mark.attrs?.color) {
                                    textContent = `<span style="color: ${escapeAttr(mark.attrs.color)}">${textContent}</span>`;
                                }
                                break;
                            case "comment": {
                                // Emit the inline comment anchor so highlights round-trip. The
                                // schema's Comment mark parses span[data-comment-id] (attrs
                                // commentId/resolved).
                                const cid = mark.attrs?.commentId;
                                if (cid) {
                                    const resolvedAttr = mark.attrs?.resolved
                                        ? ` data-resolved="true"`
                                        : "";
                                    textContent = `<span data-comment-id="${escapeAttr(cid)}"${resolvedAttr}>${textContent}</span>`;
                                }
                                break;
                            }
                        }
                    }
                }
                return textContent;
            case "codeBlock":
                const language = node.attrs?.language || "";
                // Strip ALL trailing newlines so the export is idempotent: marked
                // re-adds exactly one trailing "\n" on import, so trimming only one
                // here would let the text grow by "\n" on each round-trip. Removing
                // every trailing newline makes repeated cycles stable.
                const code = nodeContent
                    .map(processNode)
                    .join("")
                    .replace(/\n+$/, "");
                return "```" + language + "\n" + code + "\n```";
            case "bulletList":
                return nodeContent
                    .map((item) => processListItem(item, "-"))
                    .join("\n");
            case "orderedList":
                return nodeContent
                    .map((item, index) => processListItem(item, `${index + 1}.`))
                    .join("\n");
            case "taskList":
                return nodeContent.map((item) => processTaskItem(item)).join("\n");
            case "taskItem":
                // Delegate to the same helper used by taskList so multi-block and
                // nested task items render and indent consistently.
                return processTaskItem(node);
            case "listItem":
                return nodeContent.map(processNode).join("\n");
            case "blockquote":
                // Prefix EVERY line of EVERY child with "> " and separate block-level
                // children with a blank ">" line so code blocks / multi-paragraph
                // quotes round-trip correctly.
                return nodeContent
                    .map((n) => processNode(n)
                    .split("\n")
                    .map((line) => (line.length ? `> ${line}` : ">"))
                    .join("\n"))
                    .join("\n>\n");
            case "horizontalRule":
                return "---";
            case "hardBreak":
                // Two trailing spaces before the newline encode a markdown hard break;
                // a bare "\n" would be reimported as a soft break and lost.
                return "  \n";
            case "image":
                const imgAlt = node.attrs?.alt || "";
                // Neutralize characters that could break out of the markdown image
                // URL: spaces/newlines and parentheses would terminate the (...) target
                // and let a stored src inject following markdown/HTML. Percent-encode
                // them so the URL stays a single inert token.
                const imgSrc = encodeMdUrl(node.attrs?.src);
                // No "caption" attribute exists in the Docmost image schema, so we do
                // not emit one (the previous caption branch was dead).
                return `![${imgAlt}](${imgSrc})`;
            case "video": {
                // Emit the schema-matching <video> element so generateJSON rebuilds the
                // node with its attrs intact. The schema's parseHTML reads src/aria-label
                // from the standard attributes and the remaining attrs from data-*.
                const attrs = node.attrs || {};
                const parts = [`src="${escapeAttr(attrs.src ?? "")}"`];
                if (attrs.alt)
                    parts.push(`aria-label="${escapeAttr(attrs.alt)}"`);
                if (attrs.attachmentId)
                    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
                if (attrs.width != null)
                    parts.push(`width="${escapeAttr(attrs.width)}"`);
                if (attrs.height != null)
                    parts.push(`height="${escapeAttr(attrs.height)}"`);
                if (attrs.size != null)
                    parts.push(`data-size="${escapeAttr(attrs.size)}"`);
                if (attrs.align)
                    parts.push(`data-align="${escapeAttr(attrs.align)}"`);
                if (attrs.aspectRatio != null)
                    parts.push(`data-aspect-ratio="${escapeAttr(attrs.aspectRatio)}"`);
                // Wrap in a block <div> so marked treats it as a block (a bare <video>
                // is inline-level HTML and marked wraps it in <p>, leaving a spurious
                // empty paragraph beside the hoisted block atom). The wrapper has no
                // data-type, so the schema parser ignores it and just hoists the video.
                return `<div><video ${parts.join(" ")}></video></div>`;
            }
            case "youtube": {
                // Emit the schema-matching div[data-type="youtube"]; the schema reads
                // src from data-src and width/height/align from data-* attributes.
                const attrs = node.attrs || {};
                const parts = [
                    `data-type="youtube"`,
                    `data-src="${escapeAttr(attrs.src ?? "")}"`,
                ];
                if (attrs.width != null)
                    parts.push(`data-width="${escapeAttr(attrs.width)}"`);
                if (attrs.height != null)
                    parts.push(`data-height="${escapeAttr(attrs.height)}"`);
                if (attrs.align)
                    parts.push(`data-align="${escapeAttr(attrs.align)}"`);
                return `<div ${parts.join(" ")}></div>`;
            }
            case "table": {
                // A GFM pipe table cannot represent merged cells. If ANY cell carries
                // colspan>1 or rowspan>1, a pipe table would corrupt the grid on
                // re-import, so emit the WHOLE table as raw HTML <table> instead: the
                // schema's table family parseHTML (tag table/tr/td/th, with colspan/
                // rowspan read from the same-named HTML attrs and align via parseHTML)
                // round-trips it faithfully. Otherwise keep the lighter GFM pipe table.
                const tableRows = nodeContent;
                if (tableRows.length === 0)
                    return "";
                const hasSpan = tableRows.some((row) => (row.content || []).some((cell) => (cell.attrs?.colspan ?? 1) > 1 || (cell.attrs?.rowspan ?? 1) > 1));
                if (hasSpan) {
                    // Render each cell's block children to HTML (marked does NOT parse
                    // markdown inside a raw HTML block, so emitting markdown here would
                    // leak literal ** / `` into the cell). blockToHtml mirrors the schema
                    // HTML so inner formatting re-parses into the right marks/nodes.
                    const renderHtmlCell = (cell) => {
                        const tag = cell.type === "tableHeader" ? "th" : "td";
                        const a = cell.attrs || {};
                        const cellParts = [];
                        if ((a.colspan ?? 1) > 1)
                            cellParts.push(`colspan="${escapeAttr(a.colspan)}"`);
                        if ((a.rowspan ?? 1) > 1)
                            cellParts.push(`rowspan="${escapeAttr(a.rowspan)}"`);
                        if (a.align)
                            cellParts.push(`align="${escapeAttr(a.align)}"`);
                        const open = cellParts.length
                            ? `<${tag} ${cellParts.join(" ")}>`
                            : `<${tag}>`;
                        const inner = (cell.content || [])
                            .map((block) => blockToHtml(block))
                            .join("");
                        return `${open}${inner}</${tag}>`;
                    };
                    const htmlRows = tableRows
                        .map((row) => `<tr>${(row.content || []).map(renderHtmlCell).join("")}</tr>`)
                        .join("");
                    return `<table><tbody>${htmlRows}</tbody></table>`;
                }
                // No merged cells: emit a GFM table (header row + separator) so the
                // markdown can be parsed back into a table on re-import.
                const rows = tableRows.map(processNode);
                const headerCells = tableRows[0]?.content || [];
                const columns = headerCells.length || 1;
                // Derive alignment markers (:--, :-:, --:) from each header cell.
                const markers = Array.from({ length: columns }, (_, i) => {
                    const align = headerCells[i]?.attrs?.align;
                    switch (align) {
                        case "left":
                            return ":--";
                        case "center":
                            return ":-:";
                        case "right":
                            return "--:";
                        default:
                            return "---";
                    }
                });
                const separator = "| " + markers.join(" | ") + " |";
                return [rows[0], separator, ...rows.slice(1)].join("\n");
            }
            case "tableRow":
                return "| " + nodeContent.map(processNode).join(" | ") + " |";
            case "tableCell":
            case "tableHeader": {
                // Join multiple block children with a space (not "") so adjacent blocks
                // like a paragraph followed by a list don't collide into "line1- a".
                // Then collapse newlines and escape pipes so a cell containing "|" or a
                // line break cannot corrupt the surrounding GFM row.
                return nodeContent
                    .map(processNode)
                    .join(" ")
                    .replace(/\r?\n/g, " ")
                    .replace(/\|/g, "\\|");
            }
            case "callout":
                const calloutType = node.attrs?.type || "info";
                const calloutContent = nodeContent.map(processNode).join("\n");
                return `:::${calloutType.toLowerCase()}\n${calloutContent}\n:::`;
            case "details":
                return nodeContent.map(processNode).join("\n");
            case "detailsSummary":
                const summaryText = nodeContent.map(processNode).join("");
                return `<details>\n<summary>${summaryText}</summary>\n`;
            case "detailsContent":
                const detailsText = nodeContent.map(processNode).join("\n");
                return `${detailsText}\n</details>`;
            case "mathInline": {
                // The schema's `text` attribute has no parseHTML, so TipTap's default
                // parser reads it from the `text` HTML attribute (NOT the element's text
                // content). Emit span[data-type="mathInline"] carrying the LaTeX in a
                // `text="..."` attribute so it round-trips. marked cannot parse $...$
                // back, so the previous form was lossy.
                const inlineMath = node.attrs?.text || "";
                return `<span data-type="mathInline" data-katex="true" text="${escapeAttr(inlineMath)}"></span>`;
            }
            case "mathBlock": {
                // Same as mathInline: the LaTeX must ride in the `text` HTML attribute
                // for the schema's default parser to recover it.
                const blockMath = node.attrs?.text || "";
                return `<div data-type="mathBlock" data-katex="true" text="${escapeAttr(blockMath)}"></div>`;
            }
            case "mention": {
                // Emit span[data-type="mention"] with the schema's data-* attributes so
                // generateJSON rebuilds the mention node instead of leaving "@label"
                // plain text that cannot re-parse.
                const attrs = node.attrs || {};
                const parts = [`data-type="mention"`];
                if (attrs.id)
                    parts.push(`data-id="${escapeAttr(attrs.id)}"`);
                if (attrs.label)
                    parts.push(`data-label="${escapeAttr(attrs.label)}"`);
                if (attrs.entityType)
                    parts.push(`data-entity-type="${escapeAttr(attrs.entityType)}"`);
                if (attrs.entityId)
                    parts.push(`data-entity-id="${escapeAttr(attrs.entityId)}"`);
                if (attrs.slugId)
                    parts.push(`data-slug-id="${escapeAttr(attrs.slugId)}"`);
                if (attrs.creatorId)
                    parts.push(`data-creator-id="${escapeAttr(attrs.creatorId)}"`);
                if (attrs.anchorId)
                    parts.push(`data-anchor-id="${escapeAttr(attrs.anchorId)}"`);
                // Keep the label as visible text content too; the schema reads attrs
                // from data-*, so the inner text is purely cosmetic and harmless.
                const mentionLabel = attrs.label || attrs.id || "";
                // The label is visible element TEXT content here (the data-* attrs above
                // carry the real values), so escape it for the text context, not attrs.
                return `<span ${parts.join(" ")}>@${escapeHtmlText(mentionLabel)}</span>`;
            }
            case "attachment": {
                // BUG FIX: the old code read node.attrs.fileName / node.attrs.src, but
                // the schema stores name/url (plus mime/size/attachmentId). Emit the
                // schema-matching div[data-type="attachment"] with data-attachment-*
                // attrs so the node round-trips instead of degrading to a markdown link.
                const attrs = node.attrs || {};
                const parts = [
                    `data-type="attachment"`,
                    `data-attachment-url="${escapeAttr(attrs.url ?? "")}"`,
                ];
                if (attrs.name)
                    parts.push(`data-attachment-name="${escapeAttr(attrs.name)}"`);
                if (attrs.mime)
                    parts.push(`data-attachment-mime="${escapeAttr(attrs.mime)}"`);
                if (attrs.size != null)
                    parts.push(`data-attachment-size="${escapeAttr(attrs.size)}"`);
                if (attrs.attachmentId)
                    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
                return `<div ${parts.join(" ")}></div>`;
            }
            case "drawio":
            case "excalidraw": {
                // Emit the schema-matching div[data-type=...] carrying the diagram's
                // attrs as data-* (the schema's diagramAttributes reads src/title/alt/
                // width/height/size/aspectRatio/align/attachmentId from data-*), so the
                // diagram round-trips instead of degrading to a lossy placeholder.
                const attrs = node.attrs || {};
                const parts = [
                    `data-type="${type}"`,
                    `data-src="${escapeAttr(attrs.src ?? "")}"`,
                ];
                if (attrs.title != null)
                    parts.push(`data-title="${escapeAttr(attrs.title)}"`);
                if (attrs.alt != null)
                    parts.push(`data-alt="${escapeAttr(attrs.alt)}"`);
                if (attrs.width != null)
                    parts.push(`data-width="${escapeAttr(attrs.width)}"`);
                if (attrs.height != null)
                    parts.push(`data-height="${escapeAttr(attrs.height)}"`);
                if (attrs.size != null)
                    parts.push(`data-size="${escapeAttr(attrs.size)}"`);
                if (attrs.aspectRatio != null)
                    parts.push(`data-aspect-ratio="${escapeAttr(attrs.aspectRatio)}"`);
                if (attrs.align)
                    parts.push(`data-align="${escapeAttr(attrs.align)}"`);
                if (attrs.attachmentId)
                    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
                return `<div ${parts.join(" ")}></div>`;
            }
            case "embed": {
                // Emit the schema-matching div[data-type="embed"]; the schema reads
                // src/provider/align/width/height from data-* attributes so the node
                // (and its provider iframe info) survives the round-trip.
                const attrs = node.attrs || {};
                const parts = [
                    `data-type="embed"`,
                    `data-src="${escapeAttr(attrs.src ?? "")}"`,
                    `data-provider="${escapeAttr(attrs.provider ?? "")}"`,
                ];
                if (attrs.align)
                    parts.push(`data-align="${escapeAttr(attrs.align)}"`);
                if (attrs.width != null)
                    parts.push(`data-width="${escapeAttr(attrs.width)}"`);
                if (attrs.height != null)
                    parts.push(`data-height="${escapeAttr(attrs.height)}"`);
                return `<div ${parts.join(" ")}></div>`;
            }
            case "audio": {
                // Emit the schema-matching <audio> element (was emitting nothing). The
                // schema reads src from src and attachmentId/size from data-*.
                const attrs = node.attrs || {};
                const parts = [`src="${escapeAttr(attrs.src ?? "")}"`];
                if (attrs.attachmentId)
                    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
                if (attrs.size != null)
                    parts.push(`data-size="${escapeAttr(attrs.size)}"`);
                // Wrap in a block <div> for the same reason as video: a bare <audio> is
                // inline-level HTML that marked would wrap in <p>.
                return `<div><audio ${parts.join(" ")}></audio></div>`;
            }
            case "pdf": {
                // Emit the schema-matching div[data-type="pdf"] (was emitting nothing).
                // The schema reads src/width/height from standard attrs and name/
                // attachmentId/size from data-*.
                const attrs = node.attrs || {};
                const parts = [
                    `data-type="pdf"`,
                    `src="${escapeAttr(attrs.src ?? "")}"`,
                ];
                if (attrs.name)
                    parts.push(`data-name="${escapeAttr(attrs.name)}"`);
                if (attrs.attachmentId)
                    parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
                if (attrs.size != null)
                    parts.push(`data-size="${escapeAttr(attrs.size)}"`);
                if (attrs.width != null)
                    parts.push(`width="${escapeAttr(attrs.width)}"`);
                if (attrs.height != null)
                    parts.push(`height="${escapeAttr(attrs.height)}"`);
                return `<div ${parts.join(" ")}></div>`;
            }
            case "columns": {
                // Emit the schema-matching div[data-type="columns"] wrapper so the
                // multi-column layout survives. Without a case the children were
                // concatenated with no separator and the text merged. The schema reads
                // layout from data-layout and widthMode from data-width-mode. The whole
                // block is raw HTML, so render children via blockToHtml (NOT markdown,
                // which marked would not re-parse inside a raw HTML block).
                const attrs = node.attrs || {};
                const parts = [`data-type="columns"`];
                if (attrs.layout)
                    parts.push(`data-layout="${escapeAttr(attrs.layout)}"`);
                if (attrs.widthMode && attrs.widthMode !== "normal")
                    parts.push(`data-width-mode="${escapeAttr(attrs.widthMode)}"`);
                const inner = nodeContent.map((n) => blockToHtml(n)).join("");
                return `<div ${parts.join(" ")}>${inner}</div>`;
            }
            case "column": {
                // Emit the schema-matching div[data-type="column"]; the schema reads the
                // column width from data-width. Children are rendered as HTML so their
                // formatting survives inside this raw HTML block.
                const attrs = node.attrs || {};
                const parts = [`data-type="column"`];
                if (attrs.width)
                    parts.push(`data-width="${escapeAttr(attrs.width)}"`);
                const inner = nodeContent.map((n) => blockToHtml(n)).join("");
                return `<div ${parts.join(" ")}>${inner}</div>`;
            }
            case "pageBreak":
                // Emit the schema-matching div[data-type="pageBreak"] so marked passes
                // it through as a block and generateJSON rebuilds the pageBreak atom.
                // Without this case the node fell through to `default` and rendered ""
                // (the divider silently disappeared and could not round-trip).
                return `<div data-type="pageBreak"></div>`;
            case "subpages":
                return "{{SUBPAGES}}";
            default:
                // Fallback: process children
                return nodeContent.map(processNode).join("");
        }
    };
    // Render inline content (text runs + their marks) to HTML. Used by the raw
    // HTML fallbacks (spanned tables, columns) where marked will NOT re-parse
    // markdown, so backtick/asterisk/bracket syntax would otherwise leak as
    // literal characters. Each mark is mirrored to the HTML the schema's parseHTML
    // accepts so it re-imports as the matching ProseMirror mark.
    const inlineToHtml = (inlineNodes) => (inlineNodes || [])
        .map((n) => {
        if (n.type === "hardBreak")
            return "<br>";
        if (n.type !== "text") {
            // Inline atoms (mention, mathInline) already emit schema HTML.
            return processNode(n);
        }
        let t = escapeHtmlText(n.text || "");
        for (const mark of n.marks || []) {
            switch (mark.type) {
                case "bold":
                    t = `<strong>${t}</strong>`;
                    break;
                case "italic":
                    t = `<em>${t}</em>`;
                    break;
                case "code":
                    t = `<code>${t}</code>`;
                    break;
                case "strike":
                    t = `<s>${t}</s>`;
                    break;
                case "underline":
                    t = `<u>${t}</u>`;
                    break;
                case "subscript":
                    t = `<sub>${t}</sub>`;
                    break;
                case "superscript":
                    t = `<sup>${t}</sup>`;
                    break;
                case "link":
                    t = `<a href="${escapeAttr(mark.attrs?.href || "")}">${t}</a>`;
                    break;
                case "highlight":
                    t = mark.attrs?.color
                        ? `<mark style="background-color: ${escapeAttr(mark.attrs.color)}">${t}</mark>`
                        : `<mark>${t}</mark>`;
                    break;
                case "textStyle":
                    if (mark.attrs?.color)
                        t = `<span style="color: ${escapeAttr(mark.attrs.color)}">${t}</span>`;
                    break;
                case "comment":
                    // Inline comment anchor inside a raw-HTML container (columns /
                    // spanned table cells), so commented text there also round-trips.
                    if (mark.attrs?.commentId) {
                        const r = mark.attrs?.resolved ? ` data-resolved="true"` : "";
                        t = `<span data-comment-id="${escapeAttr(mark.attrs.commentId)}"${r}>${t}</span>`;
                    }
                    break;
            }
        }
        return t;
    })
        .join("");
    // Emit the schema-matching <img> for an image node. Shared so the image is
    // emitted as real HTML wherever a raw-HTML container needs it (inside a column
    // or a spanned table cell), where markdown `![](...)` would NOT be re-parsed
    // and would survive as literal text. The Image extension reads src/alt from
    // the standard attributes; the Docmost extra attrs (width/height/align/size/
    // attachmentId/aspectRatio) are global attributes read from same-named DOM
    // attributes, so emit them by name.
    const imageToHtml = (node) => {
        const attrs = node.attrs || {};
        const parts = [`src="${escapeAttr(attrs.src ?? "")}"`];
        if (attrs.alt)
            parts.push(`alt="${escapeAttr(attrs.alt)}"`);
        if (attrs.title)
            parts.push(`title="${escapeAttr(attrs.title)}"`);
        if (attrs.width != null)
            parts.push(`width="${escapeAttr(attrs.width)}"`);
        if (attrs.height != null)
            parts.push(`height="${escapeAttr(attrs.height)}"`);
        if (attrs.align)
            parts.push(`align="${escapeAttr(attrs.align)}"`);
        if (attrs.size != null)
            parts.push(`data-size="${escapeAttr(attrs.size)}"`);
        if (attrs.attachmentId)
            parts.push(`data-attachment-id="${escapeAttr(attrs.attachmentId)}"`);
        if (attrs.aspectRatio != null)
            parts.push(`data-aspect-ratio="${escapeAttr(attrs.aspectRatio)}"`);
        return `<img ${parts.join(" ")}>`;
    };
    // Emit the schema-matching div[data-type="callout"] for a callout node. The
    // schema reads the banner type from data-callout-type. Children are rendered
    // as HTML so they survive inside a raw-HTML container.
    const calloutToHtml = (node) => {
        const type = (node.attrs?.type || "info").toLowerCase();
        const inner = (node.content || []).map(blockToHtml).join("");
        return `<div data-type="callout" data-callout-type="${escapeAttr(type)}">${inner}</div>`;
    };
    // Emit a schema-matching <details> tree. The schema parses <details>,
    // summary[data-type="detailsSummary"], and div[data-type="detailsContent"].
    const detailsToHtml = (node) => {
        const inner = (node.content || []).map(blockToHtml).join("");
        return `<details>${inner}</details>`;
    };
    const detailsSummaryToHtml = (node) => `<summary data-type="detailsSummary">${inlineToHtml(node.content || [])}</summary>`;
    const detailsContentToHtml = (node) => {
        const inner = (node.content || []).map(blockToHtml).join("");
        return `<div data-type="detailsContent">${inner}</div>`;
    };
    // Emit the schema-matching taskList/taskItem HTML. bridgeTaskLists (in
    // collaboration.ts) recognizes ul[data-type="taskList"] with
    // li[data-type="taskItem"][data-checked]; emitting that directly here keeps
    // task lists inside columns/cells from degrading to literal "- [ ]" text.
    const taskListToHtml = (node) => {
        const items = (node.content || [])
            .map((it) => {
            const checked = it.attrs?.checked ? "true" : "false";
            return `<li data-type="taskItem" data-checked="${checked}">${blockChildrenToHtml(it)}</li>`;
        })
            .join("");
        return `<ul data-type="taskList">${items}</ul>`;
    };
    // Render a block node to HTML for the raw-HTML containers (spanned tables,
    // columns). marked does NOT re-parse markdown inside a raw-HTML block, so
    // EVERY block type that can appear inside a column or a spanned cell must be
    // emitted as schema-matching HTML here — never as markdown, or it would land
    // as literal text on re-import. Nodes whose processNode case already produces
    // schema-matching HTML (math/media/embed/attachment/nested columns/spanned
    // table) are delegated to processNode; the markdown-emitting cases
    // (image/blockquote/callout/details/hr/taskList) get explicit HTML here.
    const blockToHtml = (block) => {
        const children = block.content || [];
        switch (block.type) {
            case "paragraph":
                return `<p>${inlineToHtml(children)}</p>`;
            case "heading": {
                const level = block.attrs?.level || 1;
                return `<h${level}>${inlineToHtml(children)}</h${level}>`;
            }
            case "bulletList":
                return `<ul>${children
                    .map((li) => `<li>${blockChildrenToHtml(li)}</li>`)
                    .join("")}</ul>`;
            case "orderedList":
                return `<ol>${children
                    .map((li) => `<li>${blockChildrenToHtml(li)}</li>`)
                    .join("")}</ol>`;
            case "codeBlock": {
                const lang = block.attrs?.language || "";
                // The code itself is element TEXT content (between <code> tags), so it
                // must escape < > & — NOT the attribute escaper. The language rides in
                // a class ATTRIBUTE, so it uses escapeAttr.
                const code = escapeHtmlText(children
                    .map(processNode)
                    .join("")
                    .replace(/\n+$/, ""));
                const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
                return `<pre><code${cls}>${code}</code></pre>`;
            }
            case "image":
                return imageToHtml(block);
            case "blockquote":
                return `<blockquote>${children.map(blockToHtml).join("")}</blockquote>`;
            case "horizontalRule":
                return "<hr>";
            case "callout":
                return calloutToHtml(block);
            case "details":
                return detailsToHtml(block);
            case "detailsSummary":
                return detailsSummaryToHtml(block);
            case "detailsContent":
                return detailsContentToHtml(block);
            case "taskList":
                return taskListToHtml(block);
            case "taskItem":
                // A bare taskItem (outside a taskList) still needs a wrapping list so
                // the schema parses it; wrap it in a single-item taskList.
                return taskListToHtml({ content: [block] });
            // table (incl. spanned), columns/column, math, media, embed, attachment,
            // mention, etc. already emit schema-matching HTML from processNode.
            case "table":
            case "columns":
            case "column":
            case "mathBlock":
            case "video":
            case "audio":
            case "pdf":
            case "youtube":
            case "embed":
            case "attachment":
            case "drawio":
            case "excalidraw":
                return processNode(block);
            default:
                // Any still-unhandled block type: NEVER fall back to markdown inside a
                // raw-HTML block (it would become literal text). Wrap its rendered
                // children in a <div> so their content is preserved; if it has no block
                // children, render its inline content instead.
                if (children.length && children.some((c) => c.type !== "text")) {
                    return `<div>${children.map(blockToHtml).join("")}</div>`;
                }
                return `<div>${inlineToHtml(children)}</div>`;
        }
    };
    // Render the block children of a list item to HTML (a listItem holds block+
    // content). Mirrors processListItem but for the HTML fallback path.
    const blockChildrenToHtml = (item) => (item.content || []).map((b) => blockToHtml(b)).join("");
    // Indent the rendered children of a list item under a marker prefix.
    // Each child block is a (possibly multi-line) string. The very first physical
    // line of the first child carries the marker (e.g. "- " or "1. "); EVERY
    // other line — the remaining lines of the first child AND all lines of every
    // subsequent child (nested lists, code blocks, extra paragraphs) — is indented
    // to align under the marker. Without indenting these continuation lines, the
    // 2nd/3rd line of a nested child collapses to column 0 and escapes the list.
    //
    // The continuation indent MUST equal the LIST marker width, which is not the
    // same as the visible prefix width:
    //   - bullet "- "          -> 2 columns
    //   - task   "- [ ] "      -> marker is still "- " (the "[ ] " is content), 2
    //   - ordered "1. "/"10. " -> 3/4 columns, scaling with the number's digits
    // CommonMark anchors nested content to the marker column, so an ordered item
    // indented to only 2 columns would be re-parsed as a sibling/loose content on
    // re-import. Callers therefore pass the exact indent width to use.
    const indentItemChildren = (childStrings, prefix, indentWidth) => {
        const indent = " ".repeat(indentWidth);
        const lines = [];
        childStrings.forEach((child, childIndex) => {
            child.split("\n").forEach((line, lineIndex) => {
                if (childIndex === 0 && lineIndex === 0) {
                    // First physical line of the first block gets the marker.
                    lines.push(`${prefix} ${line}`);
                }
                else {
                    // Indent every continuation line by the marker width; keep blank
                    // lines blank rather than emitting trailing whitespace.
                    lines.push(line.length ? `${indent}${line}` : "");
                }
            });
        });
        return lines.join("\n");
    };
    const processListItem = (item, prefix) => {
        const itemContent = item.content || [];
        const childStrings = itemContent.map(processNode);
        if (childStrings.length === 0)
            return prefix;
        // The rendered marker is `${prefix} ` (prefix + one space), so its width —
        // and thus the continuation indent — is prefix.length + 1. This is correct
        // for both bullet ("-" -> 2) and ordered ("1." -> 3, "10." -> 4) markers,
        // since for those the visible prefix IS the list marker.
        return indentItemChildren(childStrings, prefix, prefix.length + 1);
    };
    const processTaskItem = (item) => {
        const checked = item.attrs?.checked || false;
        const checkbox = checked ? "[x]" : "[ ]";
        const prefix = `- ${checkbox}`;
        const itemContent = item.content || [];
        const childStrings = itemContent.map(processNode);
        // An empty task item still needs its checkbox marker; without this guard
        // the indent below produces "" and the "- [ ]"/"- [x]" row disappears.
        if (childStrings.length === 0)
            return prefix;
        // The list marker for a task item is just "- " (2 columns); the "[ ] "/"[x] "
        // checkbox is item content, NOT part of the marker. So the continuation
        // indent is a fixed 2 — do NOT derive it from the wider prefix.length.
        return indentItemChildren(childStrings, prefix, 2);
    };
    return processNode(content).trim();
}
