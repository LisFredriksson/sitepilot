import { parse_page_content, extract_paragraphs } from "./gutenberg.ts";
import type { ParagraphPreview } from "./gutenberg.ts";

type ParagraphUpdate = {
  page_id: number;
  content_raw: string;
  expected_content_hash: string;
  target: ParagraphPreview;
  proposed_text: string;
};

// Ren funktion: bygger ett nytt original utan nätverksanrop eller mutation.
export function update_paragraph_content(input: ParagraphUpdate): string {
  const { page_id, content_raw, expected_content_hash, target, proposed_text } = input;
  const page = parse_page_content(page_id, content_raw);
  if (page.content_hash !== expected_content_hash) {
    throw new Error("Sidinnehållet har ändrats. Hämta sidan igen.");
  }
  if (target.source !== "paragraph_block" || target.html_paragraph_index !== null ||
      !target.block_path.length || target.block_path.some(index => !Number.isSafeInteger(index) || index < 0)) {
    throw new Error("Endast vanliga paragrafblock kan ändras.");
  }
  if (!proposed_text.trim() || proposed_text.length > 5000 || /[\r\n\u0000-\u001f\u007f]/.test(proposed_text)) {
    throw new Error("Ange en text på en rad med 1–5000 tecken.");
  }

  let siblings = page.blocks;
  let block = siblings[target.block_path[0]];
  for (const index of target.block_path.slice(1)) {
    siblings = block?.inner_blocks ?? [];
    block = siblings[index];
  }
  if (!block || block.block_name !== "core/paragraph" || block.inner_blocks.length ||
      Object.hasOwn(block.attributes, "content")) {
    throw new Error("Referensen pekar inte på ett stött paragrafblock.");
  }
  const original = extract_paragraphs([block])[0];
  if (!original || original.text !== target.text) {
    throw new Error("Originaltexten stämmer inte med förslaget.");
  }

  // Konservativt: ett enda p-element, utan HTML inuti. Taggar/attribut bevaras.
  // Citerade attribut får innehålla > utan att det avslutar öppningstaggen.
  const match = /^(\s*<p\b(?:[^<>"']|"[^"]*"|'[^']*')*>)([^<>]*)(<\/p>\s*)$/.exec(block.inner_html);
  if (!match) throw new Error("Stycken med länkar eller formatering stöds inte för sparande ännu.");

  // Läsmodellen saknar källoffsetar. Kräv ett unikt, exakt HTML-område;
  // identiska stycken spärras hellre än att vi gissar vilket som ska ändras.
  const start = content_raw.indexOf(block.inner_html);
  if (start < 0 || content_raw.indexOf(block.inner_html, start + 1) !== -1) {
    throw new Error("Styckets position är inte entydig i originalet.");
  }
  const opening_start = content_raw.lastIndexOf("<!--", start);
  const opening = content_raw.slice(opening_start, start);
  const closing = content_raw.slice(start + block.inner_html.length);
  if (!/^<!--\s+wp:paragraph(?:\s+\{[\s\S]*\})?\s+-->$/.test(opening) ||
      !/^<!--\s+\/wp:paragraph\s+-->/.test(closing)) {
    throw new Error("Paragrafblockets gränser kunde inte bekräftas.");
  }
  const escaped = proposed_text.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const updated_html = match[1] + escaped + match[3];
  const updated_raw = content_raw.slice(0, start) + updated_html + content_raw.slice(start + block.inner_html.length);

  // Kontrollera storleksgränser och att resultatet fortfarande går att tolka.
  parse_page_content(page_id, updated_raw);
  return updated_raw;
}
