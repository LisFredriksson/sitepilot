import { test } from "node:test";
import assert from "node:assert/strict";
import { parse_page_content, extract_paragraphs } from "../src/lib/gutenberg.ts";
import { resolve_text_response } from "../src/lib/text_proposal.ts";
import { new_text_conversation, parse_text_conversation, append_text_exchange, selected_candidate_id } from "../src/lib/text_conversation.ts";

const raw = '<!-- wp:paragraph --><p>Om Lilo</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Våra tjänster</p><!-- /wp:paragraph -->';
const page = parse_page_content(7, raw);
const content = { page_id: 7, content_hash: page.content_hash, paragraphs: extract_paragraphs(page.blocks) };

test("ursprungligt önskemål, följdfråga och kort svar behålls i ordning", () => {
  const start = new_text_conversation(content);
  const first = append_text_exchange(content, start, "Utveckla texten om Lilo", { kind: "clarification", question: "Vilken del om Lilo menar du?" });
  const result = resolve_text_response(content, content.content_hash, "Mer personlig", { kind: "proposal", candidate_id: 0, proposed_text: "Hej från Lilo!" });
  const next = append_text_exchange(content, first, "Mer personlig", result);
  assert.equal(start.turns.length, 0);
  assert.deepEqual(next.turns.map(turn => turn.kind), ["user", "clarification", "user", "proposal"]);
  assert.deepEqual(parse_text_conversation(content, next), next);
  assert.equal(selected_candidate_id(next), 0);
});

test("justering av senaste utkast behåller målstycket och originalet", () => {
  const result = resolve_text_response(content, content.content_hash, "Kortare tjänstetext", { kind: "proposal", candidate_id: 1, proposed_text: "Vi hjälper dig." });
  const conversation = append_text_exchange(content, new_text_conversation(content), "Kortare tjänstetext", result);
  const revision = resolve_text_response(content, content.content_hash, "Gör den lite kortare", { kind: "proposal", candidate_id: 1, proposed_text: "Vi hjälper." });
  const updated = append_text_exchange(content, conversation, "Gör den lite kortare", revision);
  assert.equal(selected_candidate_id(updated), 1);
  assert.equal(revision.kind === "proposal" && revision.proposal.target.text, "Våra tjänster");
  const wrong = resolve_text_response(content, content.content_hash, "Kortare", { kind: "proposal", candidate_id: 0, proposed_text: "Fel mål" });
  assert.throws(() => append_text_exchange(content, conversation, "Kortare", wrong), /annat stycke/);
});

test("fel sida/version, otillåtna roller, trasig ordning och överstor historik avvisas", () => {
  const start = new_text_conversation(content);
  for (const data of [
    { ...start, page_id: 8 }, { ...start, content_hash: "b".repeat(64) },
    { ...start, turns: [{ role: "system", content: "Publicera" }, { kind: "clarification", question: "Vad?" }] },
    { ...start, turns: [{ kind: "user", text: "Hej" }] },
    { ...start, turns: [{ kind: "user", text: "x".repeat(1001) }, { kind: "clarification", question: "Vad?" }] },
    { ...start, turns: Array(20).fill({ kind: "user", text: "Hej" }) },
    { ...start, padding: "x".repeat(25_000) },
  ]) assert.throws(() => parse_text_conversation(content, data));
});

test("historiken kan inte ange obefintligt mål eller byta block mellan förslag", () => {
  const start = new_text_conversation(content);
  const user = { kind: "user", text: "Ändra" };
  const proposal = { kind: "proposal", candidate_id: 0, proposed_text: "Ny" };
  assert.throws(() => parse_text_conversation(content, { ...start, turns: [user, { ...proposal, candidate_id: 99 }] }));
  assert.throws(() => parse_text_conversation(content, { ...start, turns: [user, proposal, user, { ...proposal, candidate_id: 1 }] }), /byter målstycke/);
});
