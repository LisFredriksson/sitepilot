import { test } from "node:test";
import assert from "node:assert/strict";
import { update_paragraph_content } from "../src/lib/paragraph_update.ts";
import { parse_page_content, extract_paragraphs } from "../src/lib/gutenberg.ts";

const paragraph = (text: string) => `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
function input(raw: string, index = 0) {
  const page = parse_page_content(7, raw);
  return {
    page_id: 7, content_raw: raw, expected_content_hash: page.content_hash,
    target: extract_paragraphs(page.blocks)[index], proposed_text: "Ny text",
  };
}

test("byter bara målstyckets text och bevarar övriga tecken exakt", () => {
  const raw = 'Text före\n' + paragraph("Första") + '\n<!-- wp:heading --><h2>Rubrik</h2><!-- /wp:heading -->' + paragraph("Andra") + '\nSlut';
  assert.equal(update_paragraph_content(input(raw, 1)), raw.replace('<p>Andra</p>', '<p>Ny text</p>'));
});

test("hittar stycke i kolumn och bevarar blockattribut och p-attribut", () => {
  const raw = '<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div>' +
    '<!-- wp:paragraph {"className":"intro"} -->\n<p class="intro" title="a > b">Hej</p>\n<!-- /wp:paragraph -->' +
    '</div><!-- /wp:column --></div><!-- /wp:columns -->';
  const update = input(raw);
  assert.deepEqual(update.target.block_path, [0, 0, 0]);
  assert.equal(update_paragraph_content(update), raw.replace('>Hej</p>', '>Ny text</p>'));
});

test("escapar HTML, entiteter och blockkommentarer i ny text", () => {
  const update = input(paragraph("Hej &amp; välkommen"));
  update.proposed_text = 'Du & jag <3 <!-- wp:paragraph -->';
  const result = update_paragraph_content(update);
  assert.equal(result, paragraph('Du &amp; jag &lt;3 &lt;!-- wp:paragraph --&gt;'));
  assert.equal(extract_paragraphs(parse_page_content(7, result).blocks)[0].text, update.proposed_text);
});

test("tomt originalstycke kan fyllas", () => {
  assert.equal(update_paragraph_content(input(paragraph(""))), paragraph("Ny text"));
});

test("ändrad hash, originaltext och felaktiga sökvägar stoppas", () => {
  const update = input(paragraph("Hej"));
  assert.throws(() => update_paragraph_content({ ...update, expected_content_hash: "0".repeat(64) }), /ändrats/);
  assert.throws(() => update_paragraph_content({ ...update, target: { ...update.target, text: "Fel" } }), /Originaltext/);
  for (const block_path of [[], [-1], [1], [0, 0], [0.5]]) {
    assert.throws(() => update_paragraph_content({ ...update, target: { ...update.target, block_path } }));
  }
});

test("länkar, formatering, HTML-block och identiska stycken spärras", () => {
  for (const html of ['Hej <strong>du</strong>', '<a href="/">Länk</a>', 'Hej<br>du']) {
    assert.throws(() => update_paragraph_content(input(paragraph(html))), /formatering/);
  }
  assert.throws(() => update_paragraph_content(input('<!-- wp:html --><p>Hej</p><!-- /wp:html -->')), /vanliga paragrafblock/);
  assert.throws(() => update_paragraph_content(input(paragraph("Hej") + paragraph("Hej"))), /entydig/);
});

test("ogiltig ny text och ofullständiga block spärras", () => {
  const update = input(paragraph("Hej"));
  for (const proposed_text of ["", "   ", "x".repeat(5001), "Två\nrader", "Hej\u0000"]) {
    assert.throws(() => update_paragraph_content({ ...update, proposed_text }));
  }
  assert.throws(() => update_paragraph_content(input('<!-- wp:paragraph --><p>Hej</p>')), /gränser/);
});
