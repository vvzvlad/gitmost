import React from "react";
import classes from "./comment.module.css";
import { MentionContent } from "@/features/editor/components/mention/mention-view";
import CommentEditor from "@/features/comment/components/comment-editor";

// Static, editor-free renderer of a comment body (ProseMirror JSON). It walks the
// document and emits plain DOM, avoiding the cost of a full TipTap/ProseMirror
// instance per comment (the panel used to spin up 400+ editors on mount).
//
// The supported node/mark set MUST mirror what CommentEditor enables
// (StarterKit + Mention + LinkExtension). Anything outside that set makes the
// whole comment degrade to the read-only CommentEditor via the fallback below,
// so we never show a half-rendered comment.

// Sentinel thrown when we hit a node/mark we don't know how to render statically.
// Caught at the top level to trigger the CommentEditor fallback for the whole comment.
class UnknownNodeError extends Error {}

// Protocol allowlist mirroring @tiptap/extension-link's default (the read-only
// CommentEditor path relies on it to blank javascript:/data: hrefs). The static
// renderer must apply the SAME sanitization because the backend stores comment
// content verbatim and React does not neutralize javascript: in an href.
const ALLOWED_URI_SCHEMES = /^(?:https?|ftps?|mailto|tel|callto|sms|cid|xmpp):/i;

function safeHref(href: unknown): string | undefined {
  if (typeof href !== "string") return undefined;
  // Strip control chars/whitespace that could smuggle a scheme past the test
  // (e.g. "java\tscript:").
  const cleaned = href.replace(/[\u0000-\u0020]/g, "").trim();
  // Allow relative/anchor/protocol-relative links (no scheme) — not script vectors.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return href;
  return ALLOWED_URI_SCHEMES.test(cleaned) ? href : undefined;
}

interface PMMark {
  type: string;
  attrs?: Record<string, any>;
}

interface PMNode {
  type: string;
  attrs?: Record<string, any>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
}

// Wrap a text node's string in its marks (marks nest, e.g. bold + italic).
function renderMarks(
  text: React.ReactNode,
  marks: PMMark[] | undefined,
  keyPrefix: string,
): React.ReactNode {
  if (!marks || marks.length === 0) return text;

  return marks.reduce<React.ReactNode>((acc, mark, i) => {
    const key = `${keyPrefix}-m${i}`;
    switch (mark.type) {
      case "bold":
        return <strong key={key}>{acc}</strong>;
      case "italic":
        return <em key={key}>{acc}</em>;
      case "strike":
        return <s key={key}>{acc}</s>;
      case "underline":
        // StarterKit enables the Underline extension by default (Mod-u) and
        // CommentEditor does not disable it, so real comments can carry this
        // mark. Render it here rather than degrading the whole comment.
        return <u key={key}>{acc}</u>;
      case "code":
        return <code key={key}>{acc}</code>;
      case "link": {
        // LinkExtension (TiptapLink) opens links in a new tab; keep the same
        // safe rel semantics the editor produces. Sanitize the href against the
        // extension's protocol allowlist — a disallowed scheme (javascript:,
        // data:) yields undefined so the anchor is non-navigable but still shows
        // its text, matching how extension-link blanks a bad href.
        const href = safeHref(mark.attrs?.href);
        return (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            {acc}
          </a>
        );
      }
      default:
        throw new UnknownNodeError(`Unknown mark type: ${mark.type}`);
    }
  }, text);
}

function renderNode(node: PMNode, key: string): React.ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p key={key}>{renderChildren(node.content, key)}</p>;
    case "text":
      return (
        <React.Fragment key={key}>
          {renderMarks(node.text ?? "", node.marks, key)}
        </React.Fragment>
      );
    case "hardBreak":
      return <br key={key} />;
    case "mention":
      return (
        <span key={key} style={{ display: "inline" }}>
          <MentionContent attrs={node.attrs as any} />
        </span>
      );
    default:
      throw new UnknownNodeError(`Unknown node type: ${node.type}`);
  }
}

function renderChildren(
  content: PMNode[] | undefined,
  keyPrefix: string,
): React.ReactNode {
  if (!content) return null;
  return content.map((child, i) => renderNode(child, `${keyPrefix}-${i}`));
}

// Reproduce the exact DOM nesting the read-only CommentEditor renders so the
// scoped CSS in comment.module.css (which targets
// `.commentEditor .ProseMirror :global(.ProseMirror)` and `.ProseMirror p`)
// applies pixel-for-pixel. Read-only => no data-editable / data-surface attrs.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={classes.commentEditor}>
      <div className={classes.ProseMirror}>
        <div className="ProseMirror">{children}</div>
      </div>
    </div>
  );
}

interface CommentContentViewProps {
  content: string | object;
}

export function CommentContentView({ content }: CommentContentViewProps) {
  // Degrade this single comment to the old editor-based render (safety valve).
  const fallback = () => {
    if (import.meta.env.DEV) {
      console.warn(
        "CommentContentView: unsupported comment content, falling back to editor",
      );
    }
    return <CommentEditor defaultContent={content} editable={false} />;
  };

  let doc: unknown = content;

  if (typeof content === "string") {
    try {
      doc = JSON.parse(content);
    } catch {
      const trimmed = content.trim();
      // Looks like it was meant to be JSON but is malformed -> safety-valve fallback.
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return fallback();
      }
      // Otherwise it's a legacy plain-text comment: render as a single paragraph.
      return (
        <Shell>
          <p>{content}</p>
        </Shell>
      );
    }
  }

  // Double-stringified / legacy plain-text stored as a JSON string.
  if (typeof doc === "string") {
    return (
      <Shell>
        <p>{doc}</p>
      </Shell>
    );
  }

  try {
    const pmDoc = doc as PMNode;
    if (!pmDoc || typeof pmDoc !== "object" || pmDoc.type !== "doc") {
      throw new UnknownNodeError("Not a ProseMirror doc");
    }
    return <Shell>{renderChildren(pmDoc.content, "n")}</Shell>;
  } catch (err) {
    if (err instanceof UnknownNodeError) {
      return fallback();
    }
    throw err;
  }
}

export default CommentContentView;
