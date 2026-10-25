import OpenAI from "openai";
import { suggest_text_change } from "@/lib/ai";
import { get_wordpress_page_content } from "@/lib/wordpress";
import { parse_page_content, extract_paragraphs } from "@/lib/gutenberg";
import { get_text_candidates, resolve_text_response, validate_text_ai_input } from "@/lib/text_proposal";
import type { TextContentSnapshot } from "@/lib/text_proposal";
import { is_local_request, forbidden_response } from "@/lib/local_api";
import { parse_text_conversation, selected_candidate_id } from "@/lib/text_conversation";

function error_response(error: string, status: number, code?: string) {
  return Response.json({ error, ...(code ? { code } : {}) }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  if (!is_local_request(request, true)) return forbidden_response();
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return error_response("Anropet måste innehålla JSON.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) return error_response("Anropet saknar innehåll.", 400);
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
        return error_response("Anropet är för stort.", 413);
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return error_response("Kunde inte läsa anropets JSON.", 400);
  } finally {
    reader.releaseLock();
  }

  if (typeof body !== "object" || body === null ||
      !("page_id" in body) || typeof body.page_id !== "number" ||
      !Number.isSafeInteger(body.page_id) || body.page_id < 1 ||
      !("content_hash" in body) || typeof body.content_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.content_hash) ||
      !("instruction" in body) || typeof body.instruction !== "string" ||
      !body.instruction.trim() || body.instruction.length > 1000) {
    return error_response("Ange en giltig sida, innehållshash och instruktion på 1–1000 tecken.", 400);
  }

  let original: Awaited<ReturnType<typeof get_wordpress_page_content>>;
  try {
    original = await get_wordpress_page_content(body.page_id);
  } catch {
    return error_response("Kunde inte läsa originalet från WordPress. Kontrollera anslutning och behörighet.", 502);
  }

  let content: TextContentSnapshot;
  try {
    const page = parse_page_content(original.page_id, original.content_raw);
    if (page.content_hash !== body.content_hash) {
      return error_response("Sidinnehållet har ändrats. Hämta sidan igen innan du skapar ett nytt förslag.", 409, "CONTENT_CHANGED");
    }
    content = { page_id: page.page_id, content_hash: page.content_hash, paragraphs: extract_paragraphs(page.blocks) };
  } catch {
    return error_response("Kunde inte tolka sidans text inom prototypens innehållsgränser.", 422);
  }
  let conversation;
  try {
    conversation = parse_text_conversation(content, "conversation" in body ? body.conversation : undefined);
  } catch {
    return error_response("Samtalet är ogiltigt eller för långt. Starta en ny redigering.", 400, "INVALID_CONVERSATION");
  }
  const locked_id = selected_candidate_id(conversation);
  const all_candidates = get_text_candidates(content);
  const candidates = locked_id === null ? all_candidates : all_candidates.filter(item => item.candidate_id === locked_id);
  try {
    validate_text_ai_input(candidates, body.instruction);
  } catch (error) {
    return error_response(error instanceof Error ? error.message : "Innehållet kan inte användas för ett AI-förslag.", 422);
  }

  let ai_stage = "request";
  try {
    const response = await suggest_text_change(candidates, body.instruction, conversation);
    ai_stage = "validate_response";
    const result = resolve_text_response(content, body.content_hash, body.instruction, response);
    if (result.kind === "proposal" && locked_id !== null &&
        typeof response === "object" && response !== null && "candidate_id" in response && response.candidate_id !== locked_id) {
      throw new Error("AI valde ett annat stycke än den pågående redigeringen.");
    }
    return Response.json({ page_id: content.page_id, content_hash: content.content_hash, ...result }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      console.error("AI-textanrop misslyckades:", JSON.stringify({
        stage: ai_stage, status: error.status, code: error.code,
        type: error.type, param: error.param, request_id: error.requestID,
      }));
      if (error.code === "credit_balance_exhausted") {
        return error_response("AI-kontots krediter är slut. Fyll på krediter innan du försöker igen.", 503, "AI_CREDITS_EXHAUSTED");
      }
    } else {
      // Logga bara kända, fasta feltexter. Råa modellsvar kan innehålla sidtext.
      const safe_messages = new Set([
        "OPENAI_API_KEY saknas i .env.local.",
        "OPENAI_MODEL saknas i .env.local.",
        "AI kunde inte lämna ett fullständigt textförslag.",
        "AI returnerade inte förväntat svarsformat.",
        "AI-svaret har ett ogiltigt format.",
        "AI returnerade inte en giltig följdfråga.",
        "AI returnerade inte ett giltigt textförslag.",
        "AI valde ett stycke som inte finns bland kandidaterna.",
      ]);
      console.error("AI-textanrop misslyckades:", JSON.stringify({
        stage: ai_stage,
        error_name: error instanceof Error ? error.name : typeof error,
        // Koder och stackens anropsrader visar tekniska fel utan felmeddelandets
        // eventuella sidtext. Första stackraden innehåller meddelandet och utelämnas.
        stack: error instanceof Error ? error.stack?.split("\n").slice(1, 5).join("\n") : undefined,
        cause_code: error instanceof Error && error.cause &&
          typeof error.cause === "object" && "code" in error.cause &&
          typeof error.cause.code === "string" && /^[A-Z_0-9]+$/.test(error.cause.code)
          ? error.cause.code : undefined,
        reason: error instanceof Error && safe_messages.has(error.message)
          ? error.message : "Oväntat fel eller ogiltig JSON från AI.",
      }));
    }
    return error_response("Kunde inte skapa textförslaget. Ingen brödtext har sparats.", 502);
  }
}
