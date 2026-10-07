import { remark } from "remark";
import html from "remark-html";
import gfm from "remark-gfm";
import slug from "remark-slug";
import autolinkHeadings from "remark-autolink-headings";
import emoji from "remark-emoji";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import {
  buildMarkdownSourceMap,
  positionedEmojiTransformer,
  type MarkdownSourceExclusionV1,
  type MarkdownSourceMapV1,
} from "./source-map.js";

export interface RenderOptions {
  mermaidConfig?: Record<string, any>;
  sanitize?: boolean;
  omitFencedCodeLanguages?: readonly string[];
}

export interface PositionedMarkdownRenderResult {
  html: string;
  sourceMap: MarkdownSourceMapV1;
}

/**
 * Renders markdown content to HTML with Mermaid diagram support
 * @param markdown - The markdown content to render
 * @param options - Rendering options
 * @returns Rendered HTML string
 */
export async function renderMarkdown(
  markdown: string,
  options: RenderOptions = {}
): Promise<string> {
  const { sanitize = false } = options;

  const result = await remark()
    .use(gfm)
    .use(emoji)
    .use(slug as any)
    .use(autolinkHeadings as any)
    .use(() => (tree) => {
      visit(tree, "code", (node: any, index: number | undefined, parent: any) => {
        if (!parent || typeof index !== "number") return;

        // Handle mermaid code blocks
        if (node.lang === "mermaid") {
          parent.children[index] = {
            type: "html",
            value: `<div class="mermaid">${node.value}</div>`,
          };
          return;
        }

        // Handle regular code blocks with syntax highlighting
        const langClass = node.lang ? ` language-${node.lang}` : "";
        const escaped = String(node.value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        parent.children[index] = {
          type: "html",
          value: `<pre><code class="${langClass.trim()}">${escaped}</code></pre>`,
        };
      });
    })
    .use(html, { sanitize })
    .process(markdown);

  return result.toString();
}

export async function renderMarkdownWithSourceMap(
  markdown: string,
  options: RenderOptions = {},
): Promise<PositionedMarkdownRenderResult> {
  const { sanitize = false } = options;
  const omitted = new Set(
    (options.omitFencedCodeLanguages ?? []).map((language) =>
      language.trim().toLowerCase(),
    ),
  );
  const omittedExclusions: MarkdownSourceExclusionV1[] = [];
  let sourceMap: MarkdownSourceMapV1 | undefined;

  const result = await remark()
    .use(gfm)
    .use(() => positionedEmojiTransformer(markdown))
    .use(() => stripReservedSourceRefAttributes)
    .use(() => (tree: Root) => {
      visit(tree, "code", (node: any, index: number | undefined, parent: any) => {
        if (!parent || typeof index !== "number") return;
        const language = String(node.lang ?? "").trim().toLowerCase();
        if (!omitted.has(language)) return;
        const start = node.position?.start;
        const end = node.position?.end;
        if (
          Number.isInteger(start?.offset) &&
          Number.isInteger(end?.offset)
        ) {
          omittedExclusions.push({
            sourceStart: {
              offset: start.offset,
              line: start.line,
              column: start.column,
            },
            sourceEnd: {
              offset: end.offset,
              line: end.line,
              column: end.column,
            },
            reason: "omitted",
          });
        }
        parent.children.splice(index, 1);
        return index;
      });
    })
    .use(slug as any)
    .use(autolinkHeadings as any)
    .use(() => (tree: Root) => {
      const built = buildMarkdownSourceMap(
        tree,
        markdown,
        options,
        omittedExclusions,
      );
      sourceMap = built.map;
      visit(tree, ["text", "inlineCode"], (node: any, index: number | undefined, parent: any) => {
        if (!parent || typeof index !== "number") return;
        const segment = built.segmentByNode.get(node);
        if (!segment) return;
        const value = String(node.value ?? "");
        parent.children[index] = {
          type: "html",
          value: node.type === "inlineCode"
            ? `<code><span data-mdmaid-source-ref="${segment.ref}">${escapeHtml(value)}</span></code>`
            : `<span data-mdmaid-source-ref="${segment.ref}">${escapeHtml(value)}</span>`,
        };
      });
      visit(tree, "code", (node: any, index: number | undefined, parent: any) => {
        if (!parent || typeof index !== "number") return;
        const segments = built.segmentsByNode.get(node);
        if (!segments || segments.length === 0) return;
        const langClass = node.lang ? ` language-${node.lang}` : "";
        const positioned = segments
          .map((segment) =>
            `<span data-mdmaid-source-ref="${segment.ref}">${escapeHtml(segment.text)}</span>`
          )
          .join("");
        parent.children[index] = {
          type: "html",
          value: `<pre><code class="${langClass.trim()}">${positioned}</code></pre>`,
        };
      });
    })
    .use(() => (tree) => {
      visit(tree, "code", (node: any, index: number | null, parent: any) => {
        if (!parent || typeof index !== "number") return;

        if (node.lang === "mermaid") {
          parent.children[index] = {
            type: "html",
            value: `<div class="mermaid">${node.value}</div>`,
          };
          return;
        }

        const langClass = node.lang ? ` language-${node.lang}` : "";
        const escaped = escapeHtml(String(node.value));
        parent.children[index] = {
          type: "html",
          value: `<pre><code class="${langClass.trim()}">${escaped}</code></pre>`,
        };
      });
    })
    .use(html, { sanitize })
    .process(markdown);

  if (!sourceMap) throw new Error("Markdown source map was not produced.");
  return { html: result.toString(), sourceMap };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripReservedSourceRefAttributes(tree: Root): void {
  visit(tree, "html", (node: any) => {
    node.value = String(node.value).replace(
      /\sdata-mdmaid-source-ref(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi,
      "",
    );
  });
}

/**
 * Extract mermaid blocks from markdown for pre-rendering
 * @param markdown - The markdown content
 * @returns Array of mermaid diagram code blocks
 */
export function extractMermaidBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(markdown))) {
    blocks.push(match[1].trim());
  }

  return blocks;
}
