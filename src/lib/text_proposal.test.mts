import { test } from "node:test";
import assert from "node:assert/strict";
import { create_mock_text_proposal } from "./text_proposal.ts";
import type { TextContentSnapshot } from "./text_proposal.ts";

function snapshot(): TextContentSnapshot {
  return {
    page_id: 7,
    content_hash: "a".repeat(64),
    paragraphs: [
      { block_path: [0], source: "paragraph_block", html_paragraph_index: null, text: " " },
      { block_path: [1, 0], source: "paragraph_block", html_paragraph_index: null, text: "Original" },
      { block_path: [2], source: "block_html", html_paragraph_index: 2, text: "Annat stycke" },
    ],
  };
}

test("mocken väljer första icke-tomma stycket och binder förslaget till originalversionen", () => {
  const content = snapshot();
  const before = JSON.stringify(content);
  const proposal = create_mock_text_proposal(content, "  Gör texten välkomnande  ");
  assert.equal(proposal.page_id, 7);
  assert.equal(proposal.content_hash, content.content_hash);
  assert.deepEqual(proposal.target.block_path, [1, 0]);
  assert.equal(proposal.target.text, "Original");
  assert.equal(proposal.instruction, "Gör texten välkomnande");
  assert.notEqual(proposal.proposed_text, proposal.target.text);
  assert.equal(JSON.stringify(content), before);
  proposal.target.block_path.push(99);
  assert.equal(JSON.stringify(content), before);
});

test("mocken bevarar HTML-styckets ägarblock och styckeindex", () => {
  const content = snapshot();
  content.paragraphs = [content.paragraphs[2]];
  const proposal = create_mock_text_proposal(content, "Förkorta");
  assert.equal(proposal.target.source, "block_html");
  assert.equal(proposal.target.html_paragraph_index, 2);
  assert.deepEqual(proposal.target.block_path, [2]);
});

test("tomma instruktioner, för långa instruktioner och tomt innehåll avvisas", () => {
  assert.throws(() => create_mock_text_proposal(snapshot(), " "), /1–1000/);
  assert.throws(() => create_mock_text_proposal(snapshot(), "x".repeat(1001)), /1–1000/);
  const content = snapshot();
  content.paragraphs = [content.paragraphs[0]];
  assert.throws(() => create_mock_text_proposal(content, "Ändra"), /inget textstycke/);
  content.paragraphs = [];
  assert.throws(() => create_mock_text_proposal(content, "Ändra"), /inget textstycke/);
});

test("instruktionen påverkar ännu inte mocksvaret och olika original behåller egna referenser", () => {
  const content = snapshot();
  const first = create_mock_text_proposal(content, "Instruktion A");
  content.page_id = 8;
  content.content_hash = "b".repeat(64);
  const second = create_mock_text_proposal(content, "Instruktion B");
  assert.equal(first.proposed_text, second.proposed_text);
  assert.notEqual(first.page_id, second.page_id);
  assert.notEqual(first.content_hash, second.content_hash);
});
