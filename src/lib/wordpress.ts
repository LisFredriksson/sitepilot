import "server-only";

export async function get_wordpress_page(page_id = Number(process.env.WORDPRESS_PAGE_ID)) {
  return request_wordpress_page(page_id);
}

export async function get_wordpress_page_content(page_id: number) {
  if (!Number.isSafeInteger(page_id) || page_id < 1) {
    throw new Error("Ogiltigt sid-ID.");
  }
  const response = await request_wordpress(`pages/${page_id}`, {
    context: "edit", _fields: "id,content.raw",
  });

  // Begränsa även svaret före JSON-tolkningen. JSON kan vara större än råtexten.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("WordPress returnerade inget innehåll.");
  const chunks: Uint8Array[] = [];
  let total_bytes = 0;
  let data: unknown;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total_bytes += value.byteLength;
      if (total_bytes > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("WordPress-svaret är för stort.");
      }
      chunks.push(value);
    }
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }

  if (typeof data !== "object" || data === null ||
      !("id" in data) || data.id !== page_id ||
      !("content" in data) || typeof data.content !== "object" || data.content === null ||
      !("raw" in data.content) || typeof data.content.raw !== "string") {
    throw new Error("WordPress returnerade inte förväntat originalinnehåll.");
  }
  return { page_id: data.id, content_raw: data.content.raw };
}

export async function update_wordpress_title(
  page_id: number,
  new_title: string,
) {
  if (!new_title.trim() || new_title.length > 200) {
    throw new Error("Titeln måste innehålla 1–200 tecken.");
  }

  return request_wordpress_page(page_id, new_title.trim());
}

async function request_wordpress(endpoint: string, parameters: Record<string, string>, new_title?: string) {
  const base_url = process.env.WORDPRESS_BASE_URL;
  const username = process.env.WORDPRESS_USERNAME;
  const application_password = process.env.WORDPRESS_APPLICATION_PASSWORD;

  if (!base_url || !username || !application_password) {
    throw new Error("Fyll i WordPress-anslutningen i .env.local.");
  }

  const page_url = new URL(
    `${base_url.replace(/\/$/, "")}/wp-json/wp/v2/${endpoint}`,
  );

  if (page_url.protocol !== "https:") {
    throw new Error("WORDPRESS_BASE_URL måste använda HTTPS.");
  }

  for (const [key, value] of Object.entries(parameters)) {
    page_url.searchParams.set(key, value);
  }

  // Basic Auth använder Base64, inte kryptering. HTTPS skyddar transporten.
  const credentials = Buffer.from(
    `${username}:${application_password}`,
  ).toString("base64");

  const response = await fetch(page_url, {
    method: new_title === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: new_title === undefined ? undefined : JSON.stringify({ title: new_title }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`WordPress svarade med HTTP ${response.status}.`);
  }
  return response;
}

async function request_wordpress_page(page_id: number, new_title?: string) {
  if (!Number.isSafeInteger(page_id) || page_id < 1) {
    throw new Error("Sid-ID måste vara ett positivt heltal.");
  }
  const response = await request_wordpress(
    `pages/${page_id}`, { context: "edit", _fields: "id,title" }, new_title,
  );

  // TypeScript kontrollerar vår kod; detta kontrollerar API-svaret vid körning.
  const page: unknown = await response.json();

  if (
    typeof page !== "object" || page === null ||
    !("id" in page) || page.id !== page_id ||
    !("title" in page) || typeof page.title !== "object" ||
    page.title === null || !("raw" in page.title) ||
    typeof page.title.raw !== "string"
  ) {
    throw new Error("WordPress returnerade inte den förväntade sidtiteln.");
  }

  return { page_id: page.id, current_title: page.title.raw };
}

export async function get_wordpress_pages(list_page: number) {
  if (!Number.isSafeInteger(list_page) || list_page < 1) {
    throw new Error("Listans sidnummer måste vara ett positivt heltal.");
  }
  const response = await request_wordpress("pages", {
    context: "edit", _fields: "id,title", status: "publish", per_page: "20",
    page: String(list_page), orderby: "id", order: "asc",
  });
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("WordPress returnerade inte en sidlista.");
  const pages = data.map((item: unknown) => {
    if (typeof item !== "object" || item === null ||
        !("id" in item) || typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id < 1 ||
        !("title" in item) || typeof item.title !== "object" || item.title === null ||
        !("raw" in item.title) || typeof item.title.raw !== "string") {
      throw new Error("WordPress returnerade en ogiltig sida i listan.");
    }
    return { page_id: item.id, current_title: item.title.raw };
  });
  const total_pages_header = response.headers.get("x-wp-totalpages");
  const total_pages = Number(total_pages_header);
  if (total_pages_header === null || !Number.isSafeInteger(total_pages) || total_pages < 0) {
    throw new Error("WordPress returnerade inte giltig paginering.");
  }
  return { pages, list_page, total_pages };
}
