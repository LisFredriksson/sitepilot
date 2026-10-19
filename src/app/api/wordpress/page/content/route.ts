import { get_wordpress_page_content } from "@/lib/wordpress";
import { parse_page_content, extract_paragraphs } from "@/lib/gutenberg";
import { is_local_request, forbidden_response } from "@/lib/local_api";

export async function GET(request: Request) {
  if (!is_local_request(request)) return forbidden_response();
  const page_id = Number(new URL(request.url).searchParams.get("page_id"));
  if (!Number.isSafeInteger(page_id) || page_id < 1) {
    return Response.json({ error: "Välj en giltig sida." }, { status: 400 });
  }

  let original: Awaited<ReturnType<typeof get_wordpress_page_content>>;
  try {
    original = await get_wordpress_page_content(page_id);
  } catch {
    return Response.json(
      { error: "Kunde inte läsa sidinnehållet. Kontrollera WordPress-anslutning och redigeringsbehörighet." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const page = parse_page_content(original.page_id, original.content_raw);
    return Response.json({
      page_id: page.page_id,
      content_hash: page.content_hash,
      paragraphs: extract_paragraphs(page.blocks),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Innehållet kunde inte tolkas inom prototypens gränser för storlek, blockantal och nästling." },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
}
