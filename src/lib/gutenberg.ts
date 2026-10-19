import { createHash } from "node:crypto";
import { parse } from "@wordpress/block-serialization-default-parser";
import { convert } from "html-to-text";
import { Parser } from "htmlparser2";

export type ContentBlock = {
  block_name: string | null;
  block_path: number[];
  attributes: Record<string, unknown>;
  inner_html: string;
  inner_content: (string | null)[];
  inner_blocks: ContentBlock[];
};

export type PageContent = {
  page_id: number;
  content_raw: string;
  content_hash: string;
  blocks: ContentBlock[];
};

export type ParagraphPreview = {
  block_path: number[];
  text: string;
} & (
  { source: "paragraph_block"; html_paragraph_index: null } |
  { source: "block_html"; html_paragraph_index: number }
);

export const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_BLOCKS = 2000;
const MAX_BLOCK_DEPTH = 30;

// Originalet bevaras exakt. Trädet är en läsmodell, inte en serializer.
export function parse_page_content(page_id: number, content_raw: string): PageContent {
  if (!Number.isSafeInteger(page_id) || page_id < 1) {
    throw new Error("Ogiltigt sid-ID.");
  }
  if (Buffer.byteLength(content_raw, "utf8") > MAX_CONTENT_BYTES) {
    throw new Error("Sidinnehållet är för stort för läsning i prototypen.");
  }

  let block_count = 0;
  function map_blocks(blocks: ReturnType<typeof parse>, parent_path: number[]): ContentBlock[] {
    return blocks.map((block, index) => {
      block_count += 1;
      const block_path = [...parent_path, index];
      if (block_count > MAX_BLOCKS || block_path.length > MAX_BLOCK_DEPTH) {
        throw new Error("Sidan innehåller för många block eller för djup nästling.");
      }
      return {
        block_name: block.blockName,
        block_path,
        attributes: block.attrs ?? {},
        inner_html: block.innerHTML,
        inner_content: [...block.innerContent],
        inner_blocks: map_blocks(block.innerBlocks, block_path),
      };
    });
  }

  return {
    page_id,
    content_raw,
    content_hash: createHash("sha256").update(content_raw, "utf8").digest("hex"),
    blocks: map_blocks(parse(content_raw), []),
  };
}

function paragraph_text(html: string) {
  return convert(html, {
    wordwrap: false,
    limits: { maxInputLength: Infinity, maxDepth: Infinity, maxChildNodes: Infinity, maxBaseElements: Infinity },
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "template", format: "skip" },
    ],
  }).trim();
}

export function extract_paragraphs(blocks: ContentBlock[]): ParagraphPreview[] {
  const paragraphs: ParagraphPreview[] = [];
  function visit(items: ContentBlock[]) {
    for (const block of items) {
      if (block.block_name === "core/paragraph") {
        paragraphs.push({
          block_path: [...block.block_path],
          source: "paragraph_block",
          html_paragraph_index: null,
          text: paragraph_text(block.inner_html),
        });
        visit(block.inner_blocks);
        continue;
      }

      // Läs bara ägarblockets egen HTML. Underblock besöks vid sina null-markörer.
      let paragraph_start: number | null = null;
      let paragraph_index = 0;
      let template_depth = 0;
      const parser = new Parser({
        onopentag(name) {
          if (name === "template") template_depth += 1;
          if (name === "p" && template_depth === 0) paragraph_start = parser.startIndex;
        },
        onclosetag(name) {
          if (name === "p" && paragraph_start !== null) {
            paragraphs.push({
              block_path: [...block.block_path],
              source: "block_html",
              html_paragraph_index: paragraph_index++,
              text: paragraph_text(block.inner_html.slice(paragraph_start, parser.endIndex + 1)),
            });
            paragraph_start = null;
          }
          if (name === "template") template_depth -= 1;
        },
      });
      let child_index = 0;
      for (const fragment of block.inner_content) {
        if (fragment !== null) {
          parser.write(fragment);
        } else {
          // Ett stycke som korsar en blockgräns kan inte få en entydig läsreferens.
          if (paragraph_start !== null) throw new Error("HTML-stycke korsar en blockgräns.");
          const child = block.inner_blocks[child_index++];
          if (!child) throw new Error("Underblock saknas i blockstrukturen.");
          if (template_depth === 0) visit([child]);
        }
      }
      parser.end();
      if (child_index !== block.inner_blocks.length) throw new Error("Felaktig ordning för underblock.");
    }
  }
  visit(blocks);
  return paragraphs;
}
