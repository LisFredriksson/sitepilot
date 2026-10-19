import { get_wordpress_page, update_wordpress_title } from "@/lib/wordpress";

import { is_local_request, forbidden_response } from "@/lib/local_api";

export async function GET(request: Request) {
  if (!is_local_request(request)) return forbidden_response();

  const id_parameter = new URL(request.url).searchParams.get("page_id");
  const page_id = id_parameter === null ? undefined : Number(id_parameter);
  if (page_id !== undefined && (!Number.isSafeInteger(page_id) || page_id < 1)) {
    return Response.json({ error: "Ogiltigt sid-ID." }, { status: 400 });
  }

  try {
    const page = await get_wordpress_page(page_id);

    return Response.json(page, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Skicka inte anslutningsuppgifter eller råa fel från WordPress till klienten.
    return Response.json(
      { error: "Kunde inte hämta sidan. Kontrollera WordPress, anslutningsuppgifter och HTTPS-konfiguration." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request) {
  if (!is_local_request(request, true)) return forbidden_response();

  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return Response.json({ error: "Anropet måste innehålla JSON." }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Ogiltig JSON." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null ||
      !("new_title" in body) || typeof body.new_title !== "string" ||
      !body.new_title.trim() || body.new_title.length > 200 ||
      !("page_id" in body) ||
typeof body.page_id !== "number" ||
!Number.isSafeInteger(body.page_id) ||
body.page_id < 1 ||
      
      !("current_title" in body) || typeof body.current_title !== "string" ) {
    return Response.json({ error: "Ange en sidtitel med 1–200 tecken och den hämtade sidan." }, { status: 400 });
  }

  try {
    const current_page = await get_wordpress_page(body.page_id);
    if (current_page.page_id !== body.page_id || current_page.current_title !== body.current_title) {
      return Response.json({ error: "Sidan har ändrats. Hämta sidtiteln igen och granska ett nytt förslag." }, { status: 409 });
    }
    const page = await update_wordpress_title(body.page_id, body.new_title);
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Kunde inte bekräfta uppdateringen. Hämta sidtiteln igen innan du försöker på nytt." },
      { status: 502 },
    );
  }
}
