import { test } from "node:test";
import assert from "node:assert/strict";
import { create_mock_text_proposal, get_text_candidates, resolve_text_response, parse_text_suggestion_response } from "../src/lib/text_proposal.ts";
import type { TextContentSnapshot } from "../src/lib/text_proposal.ts";

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

test("AI-kandidater hoppar över tom text utan att flytta ID eller exponera blockreferenser", () => {
  assert.deepEqual(get_text_candidates(snapshot()), [
    { candidate_id: 1, text: "Original" },
    { candidate_id: 2, text: "Annat stycke" },
  ]);
});

test("simulerat AI-förslag får sin fullständiga målreferens från originalet", () => {
  const content = snapshot();
  const before = JSON.stringify(content);
  const result = resolve_text_response(content, content.content_hash, " Förkorta ", {
    kind: "proposal", candidate_id: 2, proposed_text: " Kortare text ",
  });
  assert.equal(result.kind, "proposal");
  if (result.kind !== "proposal") throw new Error("Förslag förväntades.");
  assert.equal(result.proposal.page_id, 7);
  assert.equal(result.proposal.content_hash, content.content_hash);
  assert.deepEqual(result.proposal.target, content.paragraphs[2]);
  assert.equal(result.proposal.target.source, "block_html");
  assert.equal(result.proposal.target.html_paragraph_index, 2);
  assert.equal(result.proposal.instruction, "Förkorta");
  assert.equal(result.proposal.proposed_text, "Kortare text");
  result.proposal.target.block_path.push(99);
  assert.equal(JSON.stringify(content), before);
});

test("en följdfråga skapar inget ändringsförslag", () => {
  const content = snapshot();
  assert.deepEqual(resolve_text_response(content, content.content_hash, "Ändra texten", {
    kind: "clarification", question: " Menar du introduktionen? ",
  }), { kind: "clarification", question: "Menar du introduktionen?" });
});

test("ändrad hash stoppar både förslag och följdfråga", () => {
  const content = snapshot();
  for (const response of [
    { kind: "proposal", candidate_id: 1, proposed_text: "Ny text" },
    { kind: "clarification", question: "Vilken text?" },
  ]) {
    assert.throws(() => resolve_text_response(content, "b".repeat(64), "Ändra", response), /har ändrats/);
  }
});

test("negativa, obefintliga, tomma och feltypade kandidater avvisas", () => {
  const content = snapshot();
  for (const candidate_id of [-1, 0, 999, 1.5, "1", null]) {
    assert.throws(() => resolve_text_response(content, content.content_hash, "Ändra", {
      kind: "proposal", candidate_id, proposed_text: "Ny text",
    }));
  }
});

test("felaktiga svar, tomma texter, längdöverträdelser och egna målreferenser avvisas", () => {
  const content = snapshot();
  const invalid_responses = [null, [], {}, { kind: "unknown" },
    { kind: "clarification", question: " " },
    { kind: "clarification", question: "x".repeat(501) },
    { kind: "clarification", question: "Vilken?", candidate_id: 1 },
    { kind: "proposal", candidate_id: 1, proposed_text: " " },
    { kind: "proposal", candidate_id: 1, proposed_text: "x".repeat(5001) },
    { kind: "proposal", candidate_id: 1, proposed_text: "Ny", block_path: [99] },
  ];
  for (const response of invalid_responses) {
    assert.throws(() => resolve_text_response(content, content.content_hash, "Ändra", response));
  }
});

test("klienten accepterar bara förslag för samma sida, hash, instruktion och originalstycke", () => {
  const content = snapshot();
  const result = resolve_text_response(content, content.content_hash, "Ändra", {
    kind: "proposal", candidate_id: 2, proposed_text: "Ny text",
  });
  const data = { page_id: content.page_id, content_hash: content.content_hash, ...result };
  assert.deepEqual(parse_text_suggestion_response(content, "Ändra", data), result);
  assert.throws(() => parse_text_suggestion_response(content, "Ändra", { ...data, page_id: 99 }));
  assert.throws(() => parse_text_suggestion_response(content, "Ändra", { ...data, content_hash: "b".repeat(64) }));
  assert.throws(() => parse_text_suggestion_response(content, "Annat önskemål", data));
  if (result.kind !== "proposal") throw new Error("Förslag förväntades.");
  const changed = { ...data, proposal: { ...result.proposal, target: { ...result.proposal.target, text: "Fel originaltext" } } };
  assert.throws(() => parse_text_suggestion_response(content, "Ändra", changed));
  assert.deepEqual(parse_text_suggestion_response(content, "Ändra", {
    page_id: 7, content_hash: content.content_hash, kind: "clarification", question: "Vilket stycke?",
  }), { kind: "clarification", question: "Vilket stycke?" });
});
