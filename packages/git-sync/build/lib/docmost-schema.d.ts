import { Node, Extension, Mark } from "@tiptap/core";
export declare const clampCalloutType: (value: string | null | undefined) => string;
export declare const sanitizeCssColor: (value: string | null | undefined) => string | null;
/**
 * Full extension list. Image is block-level (matches Docmost); the
 * ProseMirror DOM parser hoists <img> found inside <p> automatically.
 * StarterKit v3 already bundles the link extension, configured here.
 */
export declare const docmostExtensions: (Node<any, any> | Mark<any, any> | Extension<any, any> | Extension<import("@tiptap/starter-kit").StarterKitOptions, any> | Node<import("@tiptap/extension-image").ImageOptions, any> | Node<import("@tiptap/extension-task-list").TaskListOptions, any> | Node<import("@tiptap/extension-task-item").TaskItemOptions, any> | Mark<import("@tiptap/extension-highlight").HighlightOptions, any> | Mark<import("@tiptap/extension-subscript").SubscriptExtensionOptions, any>)[];
