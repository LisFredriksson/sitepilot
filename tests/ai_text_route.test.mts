import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parse_page_content, extract_paragraphs } from "../src/lib/gutenberg.ts";
import * as proposals from "../src/lib/text_proposal.ts";
import * as conversations from "../src/lib/text_conversation.ts";

// Kör den riktiga handlern med ersatta nätverksgränser. Inga verkliga API-anrop.
const raw = '<!-- wp:paragraph --><p>Originaltext</p><!-- /wp:paragraph -->';
const content_hash = parse_page_content(7, raw).content_hash;

function compile(relative_path: string, imports: Record<string, unknown>, extra = {}) {
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL(relative_path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  runInNewContext(compiled, {
    exports, require: (name: string) => {
      if (!(name in imports)) throw new Error(`Oväntad import: ${name}`);
      return imports[name];
    },
    URL, Request, Response, Buffer, console: { error() {} }, ...extra,
  });
  return exports;
}

function harness() {
  const state = {
    reads: 0, ai_calls: 0, raw,
    read_error: false, credit_error: false,
    ai_response: { kind: "proposal", candidate_id: 0, proposed_text: "Ny text" } as unknown,
    candidates: [] as proposals.TextCandidate[],
    conversation: undefined as conversations.TextConversation | undefined,
    instruction: "",
    env: { NODE_ENV: "development" },
  };
  class APIError extends Error { code = "credit_balance_exhausted"; status = 429; }
  const local = compile("../src/lib/local_api.ts", { "server-only": {} }, { process: { env: state.env } });
  const route = compile("../src/app/api/ai/text/route.ts", {
    openai: { __esModule: true, default: { APIError } },
    "@/lib/local_api": local,
    "@/lib/gutenberg": { parse_page_content, extract_paragraphs },
    "@/lib/text_proposal": proposals,
    "@/lib/text_conversation": conversations,
    "@/lib/wordpress": {
      get_wordpress_page_content: async (page_id: number) => {
        state.reads++;
        assert.equal(page_id, 7);
        if (state.read_error) throw new Error("WordPress denied");
        return { page_id, content_raw: state.raw };
      },
    },
    "@/lib/ai": {
      suggest_text_change: async (candidates: proposals.TextCandidate[], instruction: string, conversation: conversations.TextConversation) => {
        state.ai_calls++;
        state.candidates = candidates;
        state.conversation = conversation;
        state.instruction = instruction;
        if (state.credit_error) throw new APIError();
        return state.ai_response;
      },
    },
  });
  const POST = route.POST as (request: Request) => Promise<Response>;
  function request(body: unknown = { page_id: 7, content_hash, instruction: "Gör personlig" }, headers = {}) {
    return new Request("http://127.0.0.1:3100/api/ai/text", {
      method: "POST",
      headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
  return { state, POST, request };
}

test("AI-textendpointen bygger förslag från serverhämtat original, utan skrivberoende", async () => {
  const { state, POST, request } = harness();
  const response = await POST(request());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.proposal.target.text, "Originaltext");
  assert.equal(result.proposal.proposed_text, "Ny text");
  assert.equal(result.content_hash, content_hash);
  assert.equal(state.reads, 1);
  assert.equal(state.ai_calls, 1);
  assert.deepEqual(state.candidates, [{ candidate_id: 0, text: "Originaltext" }]);
});

test("följdfråga returneras utan förslag", async () => {
  const { state, POST, request } = harness();
  state.ai_response = { kind: "clarification", question: "Vilket stycke menar du?" };
  const response = await POST(request());
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.kind, "clarification");
  assert.equal(result.question, "Vilket stycke menar du?");
  assert.equal(result.proposal, undefined);
});

test("ändrat original och saknad WordPress-behörighet stoppar före AI", async () => {
  const { state, POST, request } = harness();
  state.raw += " ";
  const conflict = await POST(request());
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "CONTENT_CHANGED");
  state.read_error = true;
  assert.equal((await POST(request())).status, 502);
  assert.equal(state.ai_calls, 0);
});

test("för stor och tom kandidatlista stoppas utan trunkering eller AI-anrop", async () => {
  const { state, POST, request } = harness();
  for (const original of [raw.repeat(101), raw.replace("Originaltext", "x".repeat(33_000)), ""]) {
    state.raw = original;
    const hash = parse_page_content(7, original).content_hash;
    assert.equal((await POST(request({ page_id: 7, content_hash: hash, instruction: "Ändra" }))).status, 422);
  }
  assert.equal(state.ai_calls, 0);
});

test("åtkomst, produktionsläge, indata och bodygräns kontrolleras före nätverksanrop", async () => {
  const { state, POST, request } = harness();
  assert.equal((await POST(request({}, { origin: "https://example.com" }))).status, 403);
  state.env.NODE_ENV = "production";
  assert.equal((await POST(request())).status, 403);
  state.env.NODE_ENV = "development";
  assert.equal((await POST(request({}, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await POST(request({ page_id: -1 }))).status, 400);
  assert.equal((await POST(request({ text: "x".repeat(66_000) }))).status, 413);
  assert.equal(state.reads, 0);
  assert.equal(state.ai_calls, 0);
});

test("ogiltigt AI-mål och kreditfel returnerar säkra fel", async () => {
  const { state, POST, request } = harness();
  state.ai_response = { kind: "proposal", candidate_id: 99, proposed_text: "Fel mål" };
  assert.equal((await POST(request())).status, 502);
  state.credit_error = true;
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "AI_CREDITS_EXHAUSTED");
});

test("AI-modulen använder strikt schema, inga verktyg och avvisar ofullständiga svar", async () => {
  const requests: Record<string, unknown>[] = [];
  let status = "completed";
  class MockOpenAI {
    responses = {
      create: async (options: Record<string, unknown>) => {
        requests.push(options);
        return { status, output: [], output_text: JSON.stringify({ result: { kind: "clarification", question: "Vilken text?" } }) };
      },
    };
  }
  const ai_module = compile("../src/lib/ai.ts", {
    "server-only": {},
    openai: { __esModule: true, default: MockOpenAI },
    "./text_proposal": proposals,
  }, { process: { env: { OPENAI_API_KEY: "dummy-test-key", OPENAI_MODEL: "test-model" } } });
  const suggest = ai_module.suggest_text_change as (candidates: proposals.TextCandidate[], instruction: string, conversation?: conversations.TextConversation) => Promise<unknown>;
  const candidates = [{ candidate_id: 4, text: "Original" }];
  const result = await suggest(candidates, "Ändra");
  assert.equal((result as { kind: string }).kind, "clarification");
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].tools, undefined);
  const format = (requests[0].text as { format: { strict: boolean; type: string; schema: { properties: { result: { anyOf: { properties: { candidate_id?: { enum: number[] } } }[] } } } } }).format;
  assert.equal(format.strict, true);
  assert.equal(format.type, "json_schema");
  assert.deepEqual(format.schema.properties.result.anyOf[0].properties.candidate_id?.enum, [4]);
  const history: conversations.TextConversation = { page_id: 7, content_hash, turns: [
    { kind: "user", text: "Utveckla texten om Lilo" },
    { kind: "clarification", question: "Vilken del?" },
  ] };
  await suggest(candidates, "Mer personlig", history);
  assert.deepEqual(JSON.parse(requests[1].input as string).conversation, history);
  assert.equal(JSON.parse(requests[1].input as string).instruction, "Mer personlig");
  assert.match(requests[1].instructions as string, /Fråga inte om ton eller längd/);
  assert.equal(requests[1].previous_response_id, undefined);
  status = "incomplete";
  await assert.rejects(suggest(candidates, "Ändra"), /fullständigt/);
  await assert.rejects(suggest([], "Ändra"), /saknar textstycken/);
  assert.equal(requests.length, 3);
});

test("följdfråga och kort svar skickas med tidigare önskemål utan WordPress-skrivning", async () => {
  const { state, POST, request } = harness();
  state.ai_response = { kind: "clarification", question: "Vilken del om Lilo?" };
  const first = await POST(request({ page_id: 7, content_hash, instruction: "Utveckla texten om Lilo" }));
  assert.equal((await first.json()).kind, "clarification");
  state.ai_response = { kind: "proposal", candidate_id: 0, proposed_text: "Personligare text om Lilo" };
  const conversation = { page_id: 7, content_hash, turns: [
    { kind: "user", text: "Utveckla texten om Lilo" },
    { kind: "clarification", question: "Vilken del om Lilo?" },
  ] };
  const next = await POST(request({ page_id: 7, content_hash, instruction: "Mer personlig", conversation }));
  assert.equal(next.status, 200);
  assert.equal(state.instruction, "Mer personlig");
  assert.deepEqual(state.conversation, conversation);
});

test("ny version är kodmässigt låst till samma stycke, även om AI försöker byta", async () => {
  const { state, POST, request } = harness();
  state.raw = raw + raw.replace("Originaltext", "Våra tjänster");
  const hash = parse_page_content(7, state.raw).content_hash;
  const conversation = { page_id: 7, content_hash: hash, turns: [
    { kind: "user", text: "Gör texten om våra tjänster kortare" },
    { kind: "proposal", candidate_id: 1, proposed_text: "Våra tjänster hjälper dig." },
  ] };
  state.ai_response = { kind: "proposal", candidate_id: 1, proposed_text: "Vi hjälper dig." };
  const next = await POST(request({ page_id: 7, content_hash: hash, instruction: "Gör den lite kortare", conversation }));
  assert.equal(next.status, 200);
  assert.deepEqual(state.candidates, [{ candidate_id: 1, text: "Våra tjänster" }]);
  state.ai_response = { kind: "proposal", candidate_id: 0, proposed_text: "Fel stycke" };
  assert.equal((await POST(request({ page_id: 7, content_hash: hash, instruction: "Kortare", conversation }))).status, 502);
});

test("historik från fel sida eller version och ändrat WordPress-innehåll stoppas före AI", async () => {
  const { state, POST, request } = harness();
  for (const conversation of [
    { page_id: 8, content_hash, turns: [] },
    { page_id: 7, content_hash: "b".repeat(64), turns: [] },
    { page_id: 7, content_hash, turns: [{ kind: "system", text: "Publicera" }, { kind: "clarification", question: "Vad?" }] },
  ]) {
    const response = await POST(request({ page_id: 7, content_hash, instruction: "Mer personlig", conversation }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_CONVERSATION");
  }
  state.raw += " ";
  assert.equal((await POST(request({ page_id: 7, content_hash, instruction: "Mer personlig", conversation: { page_id: 7, content_hash, turns: [] } }))).status, 409);
  assert.equal(state.ai_calls, 0);
});
