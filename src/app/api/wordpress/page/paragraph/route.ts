import { is_local_request, forbidden_response } from "@/lib/local_api";
import { get_wordpress_page_content, update_wordpress_content } from "@/lib/wordpress";
import { parse_page_content } from "@/lib/gutenberg";
import { update_paragraph_content } from "@/lib/paragraph_update";

function error_response(error: string, status: number, code: string) {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!is_local_request(request, true)) return forbidden_response();
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return error_response("Anropet måste innehålla JSON.", 415, "INVALID_REQUEST");
  }
  const reader = request.body?.getReader();
  if (!reader) return error_response("Anropet saknar innehåll.", 400, "INVALID_REQUEST");
  let body: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return error_response("Anropet är för stort.", 413, "INVALID_REQUEST");
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return error_response("Kunde inte läsa anropets JSON.", 400, "INVALID_REQUEST");
  } finally {
    reader.releaseLock();
  }

  if (typeof body !== "object" || body === null ||
      !("approved" in body) || body.approved !== true ||
      !("page_id" in body) || typeof body.page_id !== "number" || !Number.isSafeInteger(body.page_id) || body.page_id < 1 ||
      !("content_hash" in body) || typeof body.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(body.content_hash) ||
      !("proposed_text" in body) || typeof body.proposed_text !== "string" || !body.proposed_text.trim() ||
      body.proposed_text.length > 5000 || /[\r\n\u0000-\u001f\u007f]/.test(body.proposed_text) ||
      !("target" in body) || typeof body.target !== "object" || body.target === null) {
    return error_response("Ange en giltig sida, ett förslag och ett uttryckligt godkännande.", 400, "INVALID_REQUEST");
  }
  const target = body.target;
  if (!("source" in target) || target.source !== "paragraph_block" ||
      !("html_paragraph_index" in target) || target.html_paragraph_index !== null ||
      !("text" in target) || typeof target.text !== "string" ||
      !("block_path" in target) || !Array.isArray(target.block_path) ||
      target.block_path.length < 1 || target.block_path.length > 30 ||
      target.block_path.some(index => typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)) {
    return error_response("Endast ett giltigt paragrafblock kan sparas.", 400, "INVALID_TARGET");
  }

  let original: Awaited<ReturnType<typeof get_wordpress_page_content>>;
  try {
    // context=edit låter WordPress kontrollera den anslutna användarens behörighet.
    original = await get_wordpress_page_content(body.page_id);
  } catch {
    return error_response("Kunde inte läsa originalet. Kontrollera WordPress-anslutningen och behörigheten.", 502, "WORDPRESS_READ_FAILED");
  }

  let updated_raw: string;
  try {
    const page = parse_page_content(body.page_id, original.content_raw);
    if (page.content_hash !== body.content_hash) {
      return error_response("Sidinnehållet har ändrats. Hämta sidan och granska ett nytt förslag.", 409, "CONTENT_CHANGED");
    }
    updated_raw = update_paragraph_content({
      page_id: body.page_id, content_raw: original.content_raw,
      expected_content_hash: body.content_hash,
      target: {
        source: "paragraph_block", html_paragraph_index: null,
        block_path: [...target.block_path], text: target.text,
      },
      proposed_text: body.proposed_text,
    });
  } catch {
    return error_response("Stycket kan inte sparas säkert. Kontrollera originaltext, blockreferens och att stycket saknar länkar eller formatering.", 422, "UNSUPPORTED_UPDATE");
  }

  try {
    const saved = await update_wordpress_content(body.page_id, updated_raw);
    const page = parse_page_content(saved.page_id, saved.content_raw);
    return Response.json({ page_id: page.page_id, content_hash: page.content_hash, saved: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Timeout betyder inte att WordPress säkert avbröt skrivningen. Återförsök inte.
    return error_response("Kunde inte bekräfta sparandet. WordPress kan ha sparat ändringen. Hämta sidan igen innan ett nytt försök.", 502, "SAVE_UNCONFIRMED");
  }
}
