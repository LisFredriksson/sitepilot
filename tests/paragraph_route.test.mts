import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parse_page_content, extract_paragraphs } from "../src/lib/gutenberg.ts";
import { update_paragraph_content } from "../src/lib/paragraph_update.ts";

const paragraph = (text: string) => `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
const raw = '<!-- wp:group --><div>' + paragraph("Original") + '</div><!-- /wp:group -->';
const page = parse_page_content(7, raw);
const payload = {
  page_id: 7, content_hash: page.content_hash, target: extract_paragraphs(page.blocks)[0],
  proposed_text: "Ny & bättre text", approved: true,
};

function compile(path: string, imports: Record<string, unknown>, extra = {}) {
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, URL, Buffer, Response, require: (name: string) => {
      if (!(name in imports)) throw new Error(`Oväntad import: ${name}`);
      return imports[name];
    }, ...extra,
  });
  return exports;
}

function harness() {
  const state = { raw, reads: 0, writes: [] as { id: number; raw: string }[], read_fail: false, write_fail: false, env: { NODE_ENV: "development" } };
  const local = compile("../src/lib/local_api.ts", { "server-only": {} }, { process: { env: state.env } });
  const route = compile("../src/app/api/wordpress/page/paragraph/route.ts", {
    "@/lib/local_api": local,
    "@/lib/gutenberg": { parse_page_content },
    "@/lib/paragraph_update": { update_paragraph_content },
    "@/lib/wordpress": {
      get_wordpress_page_content: async (id: number) => {
        state.reads++;
        if (state.read_fail) throw new Error("Private upstream error");
        return { page_id: id, content_raw: state.raw };
      },
      update_wordpress_content: async (id: number, content_raw: string) => {
        state.writes.push({ id, raw: content_raw });
        if (state.write_fail) throw new Error("Private timeout");
        state.raw = content_raw;
        return { page_id: id, content_raw };
      },
    },
  });
  const POST = route.POST as (request: Request) => Promise<Response>;
  function request(body: unknown = payload, headers = {}, body_text?: string) {
    return new Request("http://127.0.0.1:3100/api/wordpress/page/paragraph", {
      method: "POST", headers: {
        host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100",
        "content-type": "application/json", ...headers,
      }, body: body_text ?? JSON.stringify(body),
    });
  }
  return { state, POST, request };
}

test("godkänd paragraf uppdateras på vald sida med övrigt innehåll bevarat", async () => {
  const h = harness();
  const response = await h.POST(h.request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(h.state.writes, [{ id: 7, raw: raw.replace("<p>Original</p>", "<p>Ny &amp; bättre text</p>") }]);
  assert.deepEqual(await response.json(), {
    page_id: 7, saved: true, content_hash: parse_page_content(7, h.state.raw).content_hash,
  });
  // Samma gamla godkännande kan inte återanvändas efter lyckat sparande.
  assert.equal((await h.POST(h.request())).status, 409);
  assert.equal(h.state.writes.length, 1);
});

test("åtkomstkontroller stoppar främmande origin/host och produktionsläge före WordPress", async () => {
  const h = harness();
  for (const headers of [{ origin: "https://other.invalid" }, { host: "other.invalid" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await h.POST(h.request(payload, headers))).status, 403);
  }
  h.state.env.NODE_ENV = "production";
  assert.equal((await h.POST(h.request())).status, 403);
  assert.equal(h.state.reads, 0);
  assert.equal(h.state.writes.length, 0);
});

test("godkännande, sid-ID, hash, text och mål valideras före WordPress", async () => {
  const h = harness();
  for (const patch of [
    { approved: false }, { approved: undefined }, { page_id: -1 }, { page_id: "7" },
    { content_hash: "wrong" }, { proposed_text: "" }, { proposed_text: "x".repeat(5001) },
    { proposed_text: "Två\nrader" }, { target: null },
    { target: { ...payload.target, source: "block_html" } },
    { target: { ...payload.target, block_path: [-1] } },
    { target: { ...payload.target, block_path: ["0"] } },
  ]) assert.equal((await h.POST(h.request({ ...payload, ...patch }))).status, 400);
  assert.equal((await h.POST(h.request(payload, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await h.POST(h.request(payload, {}, "{"))).status, 400);
  assert.equal((await h.POST(h.request(payload, {}, " ".repeat(65_537)))).status, 413);
  assert.equal(h.state.reads, 0);
  assert.equal(h.state.writes.length, 0);
});

test("konflikt och nekad WordPress-läsning stoppar skrivningen", async () => {
  const h = harness();
  h.state.raw += " ";
  const response = await h.POST(h.request());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "CONTENT_CHANGED");
  h.state.read_fail = true;
  const denied = await h.POST(h.request());
  assert.equal(denied.status, 502);
  assert.equal((await denied.json()).code, "WORDPRESS_READ_FAILED");
  assert.equal(h.state.writes.length, 0);
});

test("fel originalreferens och formaterade stycken avvisas utan skrivning", async () => {
  const h = harness();
  for (const target of [{ ...payload.target, text: "Fel original" }, { ...payload.target, block_path: [99] }]) {
    assert.equal((await h.POST(h.request({ ...payload, target }))).status, 422);
  }
  h.state.raw = paragraph("Hej <strong>du</strong>");
  const formatted = parse_page_content(7, h.state.raw);
  const response = await h.POST(h.request({ ...payload, content_hash: formatted.content_hash, target: extract_paragraphs(formatted.blocks)[0] }));
  assert.equal(response.status, 422);
  assert.equal(h.state.writes.length, 0);
});

test("osäker skrivning ger omläsningskrav utan automatiska återförsök eller råa fel", async () => {
  const h = harness();
  h.state.write_fail = true;
  const response = await h.POST(h.request());
  const result = await response.json();
  assert.equal(response.status, 502);
  assert.equal(result.code, "SAVE_UNCONFIRMED");
  assert.match(result.error, /Hämta sidan igen/);
  assert.doesNotMatch(result.error, /Private/);
  assert.equal(h.state.writes.length, 1);
});
