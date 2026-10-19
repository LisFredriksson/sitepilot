import "server-only";

// Headers är ett extra skydd; bindningen till 127.0.0.1 begränsar nätverksåtkomsten.
export function is_local_request(request: Request, require_origin = false) {
  if (process.env.NODE_ENV !== "development") return false;

  const host = request.headers.get("host");
  if (!host) return false;

  try {
    const request_url = new URL(request.url);
    const app_url = new URL(`${request_url.protocol}//${host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(app_url.hostname)) return false;

    const origin = request.headers.get("origin");
    if ((require_origin || origin !== null) && origin !== app_url.origin) return false;

    // GET i webbläsaren saknar ofta Origin. Avvisa ändå anrop från andra sajter.
    const fetch_site = request.headers.get("sec-fetch-site");
    return fetch_site === null || fetch_site === "same-origin" || fetch_site === "none";
  } catch {
    return false;
  }
}

export function forbidden_response() {
  return Response.json(
    { error: "Åtkomst tillåts endast från den lokala appen under utveckling." },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

