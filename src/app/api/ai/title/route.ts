import { suggest_page_title } from "@/lib/ai";
import {
  is_local_request,
  forbidden_response,
} from "@/lib/local_api";
import OpenAI from "openai";

export async function POST(request: Request) {
  if (!is_local_request(request, true)) {
    return forbidden_response();
  }

  const content_type = request.headers
    .get("content-type")
    ?.split(";")[0]
    .trim();

  if (content_type !== "application/json") {
    return Response.json(
      { error: "Anropet måste innehålla JSON." },
      { status: 415 },
    );
  }

  const max_body_bytes = 16_384;
  const reader = request.body?.getReader();

  if (!reader) {
    return Response.json(
      { error: "Anropet saknar innehåll." },
      { status: 400 },
    );
  }

  let body: unknown;

  try {
    const chunks: Uint8Array[] = [];
    let total_bytes = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total_bytes += value.byteLength;

      if (total_bytes > max_body_bytes) {
        await reader.cancel();

        return Response.json(
          { error: "Anropet är för stort." },
          { status: 413 },
        );
      }

      chunks.push(value);
    }

    const body_text = Buffer.concat(chunks).toString("utf8");
    body = JSON.parse(body_text);
  } catch {
    return Response.json(
      { error: "Kunde inte läsa anropets JSON." },
      { status: 400 },
    );
  } finally {
    reader.releaseLock();
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("page_id" in body) ||
    typeof body.page_id !== "number" ||
    !Number.isSafeInteger(body.page_id) ||
    body.page_id < 1 ||
    !("current_title" in body) ||
    typeof body.current_title !== "string" ||
    body.current_title.length > 1000 ||
    !("instruction" in body) ||
    typeof body.instruction !== "string" ||
    !body.instruction.trim() ||
    body.instruction.length > 1000
  ) {
    return Response.json(
      { error: "Ange en giltig sida, titel och instruktion." },
      { status: 400 },
    );
  }

  try {
    const proposed_title = await suggest_page_title(
      body.current_title,
      body.instruction,
    );

    return Response.json(
      {
        page_id: body.page_id,
        original_title: body.current_title,
        proposed_title,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      console.error("AI-anrop misslyckades:", {
        status: error.status,
        code: error.code,
        type: error.type,
      });

      if (error.code === "credit_balance_exhausted") {
        return Response.json(
          {
            code: "AI_CREDITS_EXHAUSTED",
            error: "AI-kontots krediter är slut. Fyll på krediter innan du försöker igen.",
          },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
    } else {
      console.error(
        "AI-förslag misslyckades:",
        error instanceof Error ? error.message : "Okänt fel",
      );
    }

    return Response.json(
      { error: "Kunde inte skapa titelförslaget. Försök igen senare." },
      { status: 502 },
    );
  }
}
