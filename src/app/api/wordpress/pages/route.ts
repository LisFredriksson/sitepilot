import { get_wordpress_pages } from "@/lib/wordpress";
import { is_local_request, forbidden_response } from "@/lib/local_api";

export async function GET(request: Request) {
  if (!is_local_request(request)) return forbidden_response();

  const list_page = Number(new URL(request.url).searchParams.get("page") ?? "1");
  if (!Number.isSafeInteger(list_page) || list_page < 1) {
    return Response.json({ error: "Ogiltigt sidnummer för listan." }, { status: 400 });
  }

  try {
    return Response.json(await get_wordpress_pages(list_page), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Kunde inte hämta sidlistan. Kontrollera WordPress och anslutningen." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
