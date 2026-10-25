import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as proposals from "../src/lib/text_proposal.ts";
import * as conversations from "../src/lib/text_conversation.ts";

const content: proposals.TextContentSnapshot = {
  page_id: 7, content_hash: "a".repeat(64),
  paragraphs: [{ block_path: [2], text: "Original", source: "block_html", html_paragraph_index: 1 }],
};
type Element = { type: unknown; props: Record<string, unknown> };

// Kör komponentens riktiga händelsehanterare med simulerade hooks och fetch.
// Detta testar klientlogik, inte webbläsarens layout eller DOM.
function harness(snapshot = content) {
  let cursor = 0;
  const hooks: unknown[] = [];
  const cleanups: (() => void)[] = [];
  const calls: { url: string; options: RequestInit }[] = [];
  const result = proposals.resolve_text_response(snapshot, snapshot.content_hash, "Ändra", {
    kind: "proposal", candidate_id: 0, proposed_text: "Ny text",
  });
  let respond: () => Promise<Response> = async () => Response.json({ page_id: 7, content_hash: content.content_hash, ...result });
  let state_changes = 0;
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], (value: unknown) => {
        state_changes++;
        hooks[index] = typeof value === "function" ? value(hooks[index]) : value;
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect: () => () => void) {
      const index = cursor++;
      if (!(index in hooks)) { hooks[index] = true; cleanups.push(effect()); }
    },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const exports: Record<string, unknown> = {};
  const source = ts.transpileModule(readFileSync(new URL("../src/components/wordpress_text_proposal.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(source, {
    exports, AbortController, AbortSignal,
    require: (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "@/lib/text_proposal") return proposals;
      if (name === "@/lib/text_conversation") return conversations;
      throw new Error(`Oväntad import ${name}`);
    },
    fetch: async (url: string, options: RequestInit) => { calls.push({ url, options }); return respond(); },
  });
  const callbacks = { saved: 0, reload: 0 };
  const component = exports.default as (props: { content: proposals.TextContentSnapshot; on_saved: () => void; on_reload: () => void }) => Element;
  function render() { cursor = 0; return component({ content: snapshot, on_saved: () => { callbacks.saved++; }, on_reload: () => { callbacks.reload++; } }); }
  function nodes(value: unknown): Element[] {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap(nodes);
    const node = value as Element;
    return [node, ...nodes(node.props?.children)];
  }
  function find(type: string) {
    const node = nodes(render()).find(node => node.type === type);
    assert.ok(node, `Saknar ${type}`);
    return node;
  }
  function instruction(value: string) {
    (find("textarea").props.onChange as (event: unknown) => void)({ target: { value } });
  }
  function submit() {
    (find("form").props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  }
  return {
    render, nodes, find, calls, instruction, submit, callbacks,
    set_response(fn: () => Promise<Response>) { respond = fn; },
    unmount() { cleanups.forEach(fn => fn()); },
    state_changes: () => state_changes,
  };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("klienten skickar bara AI-anropet och visar original/förslag utan sparknapp", async () => {
  const ui = harness();
  ui.instruction("Ändra");
  ui.submit();
  assert.equal(ui.find("textarea").props.disabled, true);
  ui.submit(); // skydd även före nästa React-rendering
  assert.equal(ui.calls.length, 1);
  await flush();
  assert.deepEqual(JSON.parse(ui.calls[0].options.body as string), {
    page_id: 7, content_hash: content.content_hash, instruction: "Ändra", conversation: conversations.new_text_conversation(content),
  });
  assert.equal(ui.calls[0].url, "/api/ai/text");
  assert.equal(ui.find("textarea").props.disabled, false);
  const descriptions = ui.nodes(ui.render()).filter(node => node.type === "dd").map(node => node.props.children);
  assert.deepEqual(descriptions, ["Original", "Ny text"]);
  assert(!ui.nodes(ui.render()).some(node => node.type === "button" && String(node.props.children).includes("Godkänn")));
});

test("följdfråga får ett separat kort svar medan originalinstruktionen behålls", async () => {
  const ui = harness();
  ui.set_response(async () => Response.json({ page_id: 7, content_hash: content.content_hash, kind: "clarification", question: "Vilket stycke?" }));
  ui.instruction("Utveckla texten om Lilo"); ui.submit(); await flush();
  assert(ui.nodes(ui.render()).some(node => node.props?.children === "Vilket stycke?"));
  assert(!ui.nodes(ui.render()).some(node => node.type === "dd"));
  assert.equal(ui.find("textarea").props.value, "");
  ui.instruction("Mer personlig");
  assert(ui.nodes(ui.render()).some(node => node.props?.children === "Vilket stycke?"));
  const next_result = proposals.resolve_text_response(content, content.content_hash, "Mer personlig", {
    kind: "proposal", candidate_id: 0, proposed_text: "Personligare text",
  });
  ui.set_response(async () => Response.json({ page_id: 7, content_hash: content.content_hash, ...next_result }));
  ui.submit(); await flush();
  assert.equal(ui.calls.length, 2);
  const sent = JSON.parse(ui.calls[1].options.body as string);
  assert.equal(sent.instruction, "Mer personlig");
  assert.deepEqual(sent.conversation.turns, [
    { kind: "user", text: "Utveckla texten om Lilo" },
    { kind: "clarification", question: "Vilket stycke?" },
  ]);
  assert.deepEqual(ui.nodes(ui.render()).filter(node => node.type === "dd").map(node => node.props.children), ["Original", "Personligare text"]);
});

test("innehållskonflikt kräver ny hämtning medan kreditfel visar rätt meddelande", async () => {
  const ui = harness();
  ui.set_response(async () => Response.json({ code: "CONTENT_CHANGED", error: "Hämta sidan igen." }, { status: 409 }));
  ui.instruction("Ändra"); ui.submit(); await flush();
  assert.equal(ui.find("textarea").props.disabled, true);
  ui.submit(); await flush();
  assert.equal(ui.calls.length, 1);
  const retry = harness();
  retry.set_response(async () => Response.json({ code: "AI_CREDITS_EXHAUSTED", error: "AI-kontots krediter är slut." }, { status: 503 }));
  retry.instruction("Ändra"); retry.submit(); await flush();
  assert(retry.nodes(retry.render()).some(node => node.props?.children === "AI-kontots krediter är slut."));
  assert.equal(retry.find("textarea").props.disabled, false);
});

test("sidbyte avbryter anropet och ett sent svar orsakar inga nya tillståndsuppdateringar", async () => {
  const ui = harness();
  let finish: ((response: Response) => void) | undefined;
  ui.set_response(() => new Promise(resolve => { finish = resolve; }));
  ui.instruction("Ändra"); ui.submit();
  const signal = ui.calls[0].options.signal;
  assert.ok(signal);
  ui.unmount();
  assert.equal(signal.aborted, true);
  const before = ui.state_changes();
  finish?.(Response.json({ page_id: 7, content_hash: content.content_hash, kind: "clarification", question: "Vilket stycke?" }));
  await flush();
  assert.equal(ui.state_changes(), before);
});

const editable: proposals.TextContentSnapshot = {
  ...content, paragraphs: [{ block_path: [2], text: "Original", source: "paragraph_block", html_paragraph_index: null }],
};
function click(ui: ReturnType<typeof harness>, label: string) {
  const button = ui.nodes(ui.render()).find(node => node.type === "button" && node.props.children === label);
  assert.ok(button, `Saknar knappen ${label}`);
  (button.props.onClick as () => void)();
}

test("godkännande skickar exakt granskat förslag, spärrar dubbelklick och begär omläsning efter framgång", async () => {
  const ui = harness(editable);
  ui.instruction("Ändra"); ui.submit(); await flush();
  let finish: ((response: Response) => void) | undefined;
  ui.set_response(() => new Promise(resolve => { finish = resolve; }));
  click(ui, "Godkänn och spara");
  assert.equal(ui.find("textarea").props.disabled, true);
  click(ui, "Sparar…");
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[1].url, "/api/wordpress/page/paragraph");
  assert.deepEqual(JSON.parse(ui.calls[1].options.body as string), {
    page_id: 7, content_hash: editable.content_hash, target: editable.paragraphs[0], proposed_text: "Ny text", approved: true,
  });
  finish?.(Response.json({ saved: true, page_id: 7, content_hash: "b".repeat(64) }));
  await flush();
  assert.equal(ui.callbacks.saved, 1);
  assert(!ui.nodes(ui.render()).some(node => node.type === "dd"));
});

test("konflikt, osäkert sparande, nätverksfel och ogiltigt svar spärrar nya anrop tills omläsning", async () => {
  for (const respond of [
    async () => Response.json({ error: "Innehållet har ändrats", code: "CONTENT_CHANGED" }, { status: 409 }),
    async () => Response.json({ error: "Hämta sidan igen", code: "SAVE_UNCONFIRMED" }, { status: 502 }),
    async () => { throw new TypeError("Network error"); },
    async () => Response.json({ saved: true, page_id: 8, content_hash: "b".repeat(64) }),
  ]) {
    const ui = harness(editable);
    ui.instruction("Ändra"); ui.submit(); await flush();
    ui.set_response(respond);
    click(ui, "Godkänn och spara"); await flush();
    assert.equal(ui.find("textarea").props.disabled, true);
    click(ui, "Godkänn och spara"); ui.submit(); await flush();
    assert.equal(ui.calls.length, 2);
    assert.equal(ui.callbacks.saved, 0);
    click(ui, "Hämta aktuellt innehåll");
    assert.equal(ui.callbacks.reload, 1);
  }
});

test("sidbyte under sparande ignorerar sent svar utan att påstå att WordPress avbröt skrivningen", async () => {
  const ui = harness(editable);
  ui.instruction("Ändra"); ui.submit(); await flush();
  let finish: ((response: Response) => void) | undefined;
  ui.set_response(() => new Promise(resolve => { finish = resolve; }));
  click(ui, "Godkänn och spara");
  ui.unmount();
  const before = ui.state_changes();
  finish?.(Response.json({ saved: true, page_id: 7, content_hash: "b".repeat(64) }));
  await flush();
  assert.equal(ui.state_changes(), before);
  assert.equal(ui.callbacks.saved, 0);
});

test("kort justering skickar senaste utkast och tar bort gammalt godkännande", async () => {
  const ui = harness(editable);
  ui.instruction("Ändra"); ui.submit(); await flush();
  ui.instruction("Gör den lite kortare");
  assert(!ui.nodes(ui.render()).some(node => node.props.children === "Godkänn och spara"));
  const result = proposals.resolve_text_response(editable, editable.content_hash, "Gör den lite kortare", {
    kind: "proposal", candidate_id: 0, proposed_text: "Kort text",
  });
  ui.set_response(async () => Response.json({ page_id: 7, content_hash: editable.content_hash, ...result }));
  ui.submit(); await flush();
  const sent = JSON.parse(ui.calls[1].options.body as string);
  assert.deepEqual(sent.conversation.turns, [
    { kind: "user", text: "Ändra" }, { kind: "proposal", candidate_id: 0, proposed_text: "Ny text" },
  ]);
  click(ui, "Godkänn och spara"); await flush();
  assert.equal(JSON.parse(ui.calls[2].options.body as string).proposed_text, "Kort text");
});

test("avböjt förslag rensar sammanhanget och gör inget sparanrop", async () => {
  const ui = harness(editable);
  ui.instruction("Ändra"); ui.submit(); await flush();
  click(ui, "Avfärda förslag");
  assert(!ui.nodes(ui.render()).some(node => node.type === "dd"));
  ui.instruction("Ny uppgift"); ui.submit(); await flush();
  assert.deepEqual(JSON.parse(ui.calls[1].options.body as string).conversation.turns, []);
  assert(ui.calls.every(call => call.url === "/api/ai/text"));
});

test("avbrutet pågående AI-anrop och sidbyte kan inte återuppliva tidigare konversation", async () => {
  const ui = harness(editable);
  let finish: ((response: Response) => void) | undefined;
  ui.set_response(() => new Promise(resolve => { finish = resolve; }));
  ui.instruction("Ändra"); ui.submit();
  click(ui, "Avbryt och starta ny redigering");
  assert.equal(ui.calls[0].options.signal?.aborted, true);
  finish?.(Response.json({ page_id: 7, content_hash: editable.content_hash, kind: "clarification", question: "Gammal fråga" }));
  await flush();
  assert(!ui.nodes(ui.render()).some(node => node.props.children === "Gammal fråga"));
  ui.unmount();
  const new_page = harness({ ...editable, page_id: 8, content_hash: "b".repeat(64) });
  new_page.instruction("Ny sida"); new_page.submit(); await flush();
  const sent = JSON.parse(new_page.calls[0].options.body as string);
  assert.equal(sent.page_id, 8);
  assert.equal(sent.conversation.page_id, 8);
  assert.deepEqual(sent.conversation.turns, []);
});
