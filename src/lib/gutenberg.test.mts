import { test } from "node:test";
import assert from "node:assert/strict";
import { parse_page_content, extract_paragraphs, MAX_CONTENT_BYTES } from "./gutenberg.ts";

const paragraph = (html: string) => `<!-- wp:paragraph --><p>${html}</p><!-- /wp:paragraph -->`;

test("väljer endast paragrafer och behåller positioner bland andra block", () => {
  const raw = paragraph("Första") + '<!-- wp:heading --><h2>Rubrik</h2><!-- /wp:heading -->' + paragraph("Andra");
  const page = parse_page_content(7, raw);
  assert.equal(page.blocks.length, 3);
  assert.deepEqual(extract_paragraphs(page.blocks), [
    { block_path: [0], text: "Första", source: "paragraph_block", html_paragraph_index: null }, { block_path: [2], text: "Andra", source: "paragraph_block", html_paragraph_index: null },
  ]);
});

test("läser nästlade paragrafer i dokumentordning och bevarar attribut", () => {
  const raw = '<!-- wp:group {"className":"custom"} --><div>' + paragraph("Inuti") +
    '<!-- wp:columns --><div><!-- wp:column --><div>' + paragraph("Djupt") +
    '</div><!-- /wp:column --></div><!-- /wp:columns --></div><!-- /wp:group -->' + paragraph("Sist");
  const page = parse_page_content(7, raw);
  assert.equal(page.blocks[0].attributes.className, "custom");
  assert.deepEqual(extract_paragraphs(page.blocks), [
    { block_path: [0, 0], text: "Inuti", source: "paragraph_block", html_paragraph_index: null },
    { block_path: [0, 1, 0, 0], text: "Djupt", source: "paragraph_block", html_paragraph_index: null },
    { block_path: [1], text: "Sist", source: "paragraph_block", html_paragraph_index: null },
  ]);
});

test("behåller tomma stycken och tomma dokument", () => {
  assert.deepEqual(extract_paragraphs(parse_page_content(7, paragraph("") + paragraph(" ")).blocks), [
    { block_path: [0], text: "", source: "paragraph_block", html_paragraph_index: null }, { block_path: [1], text: "", source: "paragraph_block", html_paragraph_index: null },
  ]);
  assert.deepEqual(extract_paragraphs(parse_page_content(7, "").blocks), []);
});

test("avkodar entiteter och bevarar radbrytningar utan länkmål eller skript", () => {
  const html = 'Hej <strong>Anna</strong> &amp; <a href="https://example.com">välkommen</a>!<br>Rad två<script>alert(1)</script><style>p{color:red}</style>';
  const page = parse_page_content(7, paragraph(html));
  assert.equal(extract_paragraphs(page.blocks)[0].text, "Hej Anna & välkommen!\nRad två");
  assert.equal(page.blocks[0].inner_html, `<p>${html}</p>`);
});

test("bevarar exakt original och reproducerbar hash utan mutation vid extraktion", () => {
  const raw = '\n' + paragraph("Text") + '\n\n';
  const page = parse_page_content(7, raw);
  const before = JSON.stringify(page);
  extract_paragraphs(page.blocks);
  assert.equal(JSON.stringify(page), before);
  assert.equal(page.content_raw, raw);
  assert.equal(page.content_hash, parse_page_content(7, raw).content_hash);
  assert.notEqual(page.content_hash, parse_page_content(7, raw + " ").content_hash);
  assert.match(page.content_hash, /^[a-f0-9]{64}$/);
});

test("klassisk HTML får egen källtyp och refererade mönster följs inte", () => {
  const raw = '<p>Klassisk text</p><!-- wp:block {"ref":42} /-->';
  const page = parse_page_content(7, raw);
  assert.equal(page.blocks[0].block_name, null);
  assert.equal(page.blocks[1].attributes.ref, 42);
  assert.deepEqual(extract_paragraphs(page.blocks), [
    { block_path: [0], text: "Klassisk text", source: "block_html", html_paragraph_index: 0 },
  ]);
});

test("avvisar för stort innehåll, för många block och för djup nästling", () => {
  assert.throws(() => parse_page_content(7, "å".repeat(MAX_CONTENT_BYTES)), /för stort/);
  assert.throws(() => parse_page_content(7, paragraph("x").repeat(2001)), /för många/);
  const deep = '<!-- wp:group --><div>'.repeat(31) + paragraph("x") + '</div><!-- /wp:group -->'.repeat(31);
  assert.throws(() => parse_page_content(7, deep), /djup nästling/);
});

test("blandar HTML-stycken och underblock i rätt ordning utan dubbletter", () => {
  const raw = '<!-- wp:columns --><div><!-- wp:column --><div>' +
    '<p>Före</p>' + paragraph("Eget block") + '<p>Efter</p><p></p>' +
    '</div><!-- /wp:column --><!-- wp:column --><div><p>Andra kolumnen</p></div><!-- /wp:column --></div><!-- /wp:columns -->';
  const page = parse_page_content(7, raw);
  const before = JSON.stringify(page);
  assert.deepEqual(extract_paragraphs(page.blocks), [
    { block_path: [0, 0], text: "Före", source: "block_html", html_paragraph_index: 0 },
    { block_path: [0, 0, 0], text: "Eget block", source: "paragraph_block", html_paragraph_index: null },
    { block_path: [0, 0], text: "Efter", source: "block_html", html_paragraph_index: 1 },
    { block_path: [0, 0], text: "", source: "block_html", html_paragraph_index: 2 },
    { block_path: [0, 1], text: "Andra kolumnen", source: "block_html", html_paragraph_index: 0 },
  ]);
  assert.equal(JSON.stringify(page), before);
  assert.equal(page.content_raw, raw);
});

test("HTML-stycken avkodar text och hoppar över skript, stil och mallinnehåll", () => {
  const raw = '<!-- wp:group --><div><template><p>Dold mall</p></template>' +
    '<script>const text="<p>Inte ett stycke</p>";</script>' +
    '<p><a href="https://example.com"><strong>Hej</strong></a> &amp; välkommen<br>Ny rad<style>p{color:red}</style></p>' +
    '</div><!-- /wp:group -->';
  assert.deepEqual(extract_paragraphs(parse_page_content(7, raw).blocks), [
    { block_path: [0], text: "Hej & välkommen\nNy rad", source: "block_html", html_paragraph_index: 0 },
  ]);
});

test("ägarblockets öppna HTML-element kan fortsätta efter ett underblock", () => {
  const raw = '<!-- wp:group --><section><div><p>A</p>' +
    '<!-- wp:group --><div><p>B</p></div><!-- /wp:group -->' +
    '<p>C</p></div></section><!-- /wp:group -->';
  assert.deepEqual(extract_paragraphs(parse_page_content(7, raw).blocks).map(item => item.text), ["A", "B", "C"]);
});

test("avvisar HTML-stycken som korsar en underblocksgräns", () => {
  const raw = '<!-- wp:group --><div><p>Före' + paragraph("Inuti") + 'Efter</p></div><!-- /wp:group -->';
  assert.throws(() => extract_paragraphs(parse_page_content(7, raw).blocks), /korsar en blockgräns/);
});
