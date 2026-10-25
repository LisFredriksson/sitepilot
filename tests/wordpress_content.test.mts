import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Riktig WordPress-modul med simulerad fetch och påhittade anslutningsuppgifter.
function harness() {
  const calls: { url: URL; options: RequestInit }[] = [];
  const state = { status: 200, data: { id: 7, content: { raw: "Ny text" } } as unknown, fail: false };
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL("../src/lib/wordpress.ts", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, URL, Buffer, AbortSignal,
    require: (name: string) => {
      if (name === "server-only") return {};
      if (name === "./gutenberg") return { MAX_CONTENT_BYTES: 512 * 1024 };
      throw new Error(`Oväntad import: ${name}`);
    },
    process: { env: {
      WORDPRESS_BASE_URL: "https://test.invalid", WORDPRESS_USERNAME: "test",
      WORDPRESS_APPLICATION_PASSWORD: "fake-password",
    } },
    fetch: async (url: URL, options: RequestInit) => {
      calls.push({ url, options });
      if (state.fail) throw new Error("Simulerad timeout");
      return Response.json(state.data, { status: state.status });
    },
  });
  return {
    calls, state,
    update: exports.update_wordpress_content as (id: number, raw: string) => Promise<{ page_id: number; content_raw: string }>,
    title: exports.update_wordpress_title as (id: number, title: string) => Promise<unknown>,
    read: exports.get_wordpress_page_content as (id: number) => Promise<unknown>,
  };
}

test("innehållssparande skickar bara content till vald sida och behåller transportsäkerheten", async () => {
  const h = harness();
  const result = await h.update(7, "Ny text");
  assert.equal(result.page_id, 7);
  assert.equal(result.content_raw, "Ny text");
  assert.equal(h.calls.length, 1);
  const { url, options } = h.calls[0];
  assert.equal(url.pathname, "/wp-json/wp/v2/pages/7");
  assert.equal(url.searchParams.get("context"), "edit");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body as string), { content: "Ny text" });
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal);
  assert.equal((options.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("test:fake-password").toString("base64")}`);
});

test("ogiltigt ID och för stort innehåll stoppas före fetch", async () => {
  const h = harness();
  for (const id of [0, -1, NaN, 1.5]) await assert.rejects(h.update(id, "Text"));
  await assert.rejects(h.update(7, "å".repeat(262145)));
  assert.equal(h.calls.length, 0);
});

test("felaktigt svar, filtrerat innehåll, nekad behörighet och timeout bekräftar inte sparande", async () => {
  const h = harness();
  for (const data of [{ id: 8, content: { raw: "Ny text" } }, { id: 7 }, { id: 7, content: { raw: "Filtrerad" } }]) {
    h.state.data = data;
    await assert.rejects(h.update(7, "Ny text"));
  }
  h.state.status = 403;
  await assert.rejects(h.update(7, "Ny text"), /HTTP 403/);
  h.state.fail = true;
  await assert.rejects(h.update(7, "Ny text"), /timeout/);
});

test("titelsparande och läsning använder fortfarande sina tidigare payloads", async () => {
  const h = harness();
  h.state.data = { id: 7, title: { raw: "Titel" } };
  await h.title(7, "Titel");
  assert.deepEqual(JSON.parse(h.calls[0].options.body as string), { title: "Titel" });
  h.state.data = { id: 7, content: { raw: "Original" } };
  await h.read(7);
  assert.equal(h.calls[1].options.method, "GET");
  assert.equal(h.calls[1].options.body, undefined);
});
