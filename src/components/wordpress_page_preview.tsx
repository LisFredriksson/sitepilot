"use client";

import { useState } from "react";
import WordPressParagraphs from "@/components/wordpress_paragraphs";

type WordPressPage = {
  page_id: number;
  current_title: string;
};

export default function WordPressPagePreview() {
  const [page, set_page] = useState<WordPressPage | null>(null);
  const [is_loading, set_is_loading] = useState(false);
  const [error_message, set_error_message] = useState<string | null>(null);
  const [new_title, set_new_title] = useState("");
  const [preview_title, set_preview_title] = useState<string | null>(null);
  const [is_saving, set_is_saving] = useState(false);
  const [success_message, set_success_message] = useState<string | null>(null);
  const [pages, set_pages] = useState<WordPressPage[]>([]);
  const [selected_page_id, set_selected_page_id] = useState("");
  const [is_loading_list, set_is_loading_list] = useState(false);
  const [list_page, set_list_page] = useState(0);
  const [total_pages, set_total_pages] = useState(0);
  const [instruction, set_instruction] = useState("");
  const [is_suggesting, set_is_suggesting] = useState(false);

  async function fetch_pages(next_page = 1) {
    set_is_loading_list(true);
    set_error_message(null);
    try {
      const response = await fetch(`/api/wordpress/pages?page=${next_page}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Kunde inte hämta sidlistan.");
      const data: unknown = await response.json();
      if (typeof data !== "object" || data === null ||
        !("pages" in data) || !Array.isArray(data.pages) ||
        !("list_page" in data) || data.list_page !== next_page ||
        !("total_pages" in data) || typeof data.total_pages !== "number" ||
        !Number.isSafeInteger(data.total_pages) || data.total_pages < 0) {
        throw new Error("Oväntat svar från sidlistan.");
      }
      const next_pages = data.pages.map((item: unknown) => {
        if (typeof item !== "object" || item === null ||
          !("page_id" in item) || typeof item.page_id !== "number" ||
          !("current_title" in item) || typeof item.current_title !== "string") {
          throw new Error("Ogiltig sida i listan.");
        }
        return { page_id: item.page_id, current_title: item.current_title };
      });
      set_pages(previous => next_page === 1 ? next_pages :
        [...previous, ...next_pages.filter(item => !previous.some(old => old.page_id === item.page_id))]);
      set_list_page(next_page);
      set_total_pages(data.total_pages);
    } catch (error) {
      set_error_message(error instanceof Error ? error.message : "Kunde inte hämta sidlistan.");
    } finally {
      set_is_loading_list(false);
    }
  }

  const can_preview = page !== null &&
    !is_suggesting &&
    new_title.trim().length > 0 &&
    new_title.length <= 200 &&
    new_title.trim() !== page.current_title;

  async function fetch_page() {
    set_is_loading(true);
    set_error_message(null);
    set_success_message(null);
    set_page(null);
    set_new_title("");
    set_preview_title(null);


    try {
      const page_url = selected_page_id ? `/api/wordpress/page?page_id=${selected_page_id}` : "/api/wordpress/page";
      const response = await fetch(page_url, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Kunde inte hämta sidan. Kontrollera att WordPress-testsajten är igång och att serverns anslutning fungerar.");
      }

      const data: unknown = await response.json();

      if (
        typeof data !== "object" || data === null ||
        !("page_id" in data) || typeof data.page_id !== "number" ||
        (selected_page_id !== "" && data.page_id !== Number(selected_page_id)) ||
        !("current_title" in data) || typeof data.current_title !== "string"
      ) {
        throw new Error("SitePilot returnerade ett oväntat svar.");
      }

      set_page({ page_id: data.page_id, current_title: data.current_title });
      set_new_title(data.current_title);
    } catch (error) {
      set_error_message(
        error instanceof Error ? error.message : "Kunde inte hämta sidan.",
      );
    } finally {
      set_is_loading(false);
    }
  }

  async function save_title() {
    if (!page || preview_title === null || is_saving || is_suggesting) return;
    set_is_saving(true);
    set_error_message(null);
    set_success_message(null);

    try {
      const response = await fetch("/api/wordpress/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          new_title: preview_title,
          page_id: page.page_id,
          current_title: page.current_title,
        }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message = typeof data === "object" && data !== null &&
          "error" in data && typeof data.error === "string" ? data.error :
          "Kunde inte bekräfta uppdateringen. Hämta sidtiteln igen.";
        throw new Error(message);
      }
      if (typeof data !== "object" || data === null ||
        !("page_id" in data) || data.page_id !== page.page_id ||
        !("current_title" in data) || typeof data.current_title !== "string") {
        throw new Error("Oväntat svar. Hämta sidtiteln igen för att kontrollera resultatet.");
      }
      set_page({ page_id: data.page_id, current_title: data.current_title });
      set_new_title(data.current_title);
      set_preview_title(null);
      set_success_message("Sidtiteln har uppdaterats i WordPress.");
    } catch (error) {
      // Svaret kan ha försvunnit efter att WordPress sparat. Originalet är nu osäkert.
      // Formuläret visas först när fetch_page() har hämtat en aktuell sida igen.
      set_page(null);
      set_preview_title(null);
      const message = error instanceof Error ? error.message : "Kunde inte bekräfta uppdateringen.";
      set_error_message(`${message} Hämta aktuell sidtitel innan ett nytt försök.`);
    } finally {
      set_is_saving(false);
    }
  }
  async function suggest_title() {
    if (
      !page ||
      !instruction.trim() ||
      is_suggesting ||
      is_saving ||
      is_loading ||
      is_loading_list
    ) return;

    set_is_suggesting(true);
    set_preview_title(null);
    set_error_message(null);
    set_success_message(null);

    try {
      const response = await fetch("/api/ai/title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page_id: page.page_id,
          current_title: page.current_title,
          instruction: instruction.trim(),
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const data: unknown = await response.json();

      if (!response.ok) {
        if (
          typeof data === "object" && data !== null &&
          "code" in data && data.code === "AI_CREDITS_EXHAUSTED"
        ) {
          set_error_message("AI-kontots krediter är slut. Fyll på krediter innan du försöker igen.");
          return;
        }
        throw new Error("Kunde inte skapa titelförslaget. Försök igen senare.");
      }

      if (
        typeof data !== "object" ||
        data === null ||
        !("page_id" in data) ||
        data.page_id !== page.page_id ||
        !("original_title" in data) ||
        data.original_title !== page.current_title ||
        !("proposed_title" in data) ||
        typeof data.proposed_title !== "string" ||
        !data.proposed_title.trim() ||
        data.proposed_title.length > 200 ||
        /[\r\n]/.test(data.proposed_title)
      ) {
        throw new Error("AI-förslaget hade ett oväntat format.");
      }

      set_new_title(data.proposed_title.trim());
    } catch (error) {
      set_error_message(
        error instanceof Error && error.name === "TimeoutError"
          ? "AI-anropet tog för lång tid. Försök igen senare."
          : "Kunde inte skapa titelförslaget. Försök igen senare.",
      );
    } finally {
      set_is_suggesting(false);
    }
  }
  return (
    <section className="mt-6 rounded-xl bg-white p-6 text-slate-900 shadow-sm">
      <h2 className="text-xl font-semibold">Din WordPress-sida</h2>
      <button
        type="button"
        disabled={is_loading_list || is_loading || is_saving || is_suggesting}
        onClick={() => fetch_pages()}
        className="mt-4 rounded border border-slate-300 px-4 py-2 disabled:opacity-60"
      >
        {is_loading_list ? "Hämtar sidlista…" : "Hämta sidlista"}
      </button>
      {list_page > 0 && (
        <div className="mt-4">
          <label htmlFor="selected_page" className="block font-medium">Välj sida</label>
          <select
            id="selected_page"
            value={selected_page_id}
            disabled={is_loading || is_saving || is_loading_list || is_suggesting}
            onChange={(event) => {
              set_selected_page_id(event.target.value);
              set_page(null);
              set_new_title("");
              set_preview_title(null);
              set_error_message(null);
              set_success_message(null);
            }}
            className="mt-2 w-full rounded border border-slate-300 px-3 py-2"
          >
            <option value="">Ursprunglig testsida</option>
            {pages.map(item => (
              <option key={item.page_id} value={item.page_id}>
                {item.current_title || "(Utan titel)"} (ID {item.page_id})
              </option>
            ))}
          </select>
          {pages.length === 0 && <p className="mt-2">Inga publicerade sidor hittades.</p>}
          {list_page < total_pages && (
            <button
              type="button"
              disabled={is_loading_list || is_loading || is_saving || is_suggesting}
              onClick={() => fetch_pages(list_page + 1)}
              className="mt-3 rounded border border-slate-300 px-3 py-2 disabled:opacity-60"
            >
              Hämta fler sidor
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={fetch_page}
        disabled={is_loading || is_saving || is_loading_list || is_suggesting}
        className="mt-4 rounded bg-slate-900 px-4 py-2 text-white disabled:cursor-wait disabled:opacity-60"
      >
        {is_loading ? "Hämtar…" : "Hämta sidtitel"}
      </button>
      <div className="mt-4" aria-live="polite" aria-busy={is_loading}>
        {page && (
          <p>Nuvarande sidtitel: <strong>{page.current_title || "(Utan titel)"}</strong></p>
        )}
      </div>
      {page && (
        <form
          className="mt-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (can_preview) set_preview_title(new_title.trim());
          }}
        >
          <label htmlFor="instruction" className="block font-medium">
            Hur vill du ändra sidtiteln?
          </label>
          <textarea
            id="instruction"
            value={instruction}
            onChange={(event) => set_instruction(event.target.value)}
            placeholder="Gör rubriken mer personlig och välkomnande"
            maxLength={1000}
            disabled={is_saving || is_suggesting}
            className="mt-2 mb-4 w-full rounded border border-slate-300 px-3 py-2"
          />
          <button
            type="button"
            onClick={suggest_title}
            disabled={
              !instruction.trim() ||
              is_saving ||
              is_suggesting ||
              is_loading ||
              is_loading_list
            }
            className="mb-4 rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
          >
            {is_suggesting ? "Skapar förslag…" : "Föreslå titel med AI"}
          </button>
          <label htmlFor="new_title" className="block font-medium">
            Föreslagen sidtitel
          </label>
          <input
            id="new_title"
            type="text"
            required
            maxLength={200}
            disabled={is_saving || is_suggesting}
            value={new_title}
            onChange={(event) => {
              set_new_title(event.target.value);
              set_preview_title(null);
              set_success_message(null);
              set_error_message(null);
            }}
            className="mt-2 w-full rounded border border-slate-300 px-3 py-2"
          />
          <button
            type="submit"
            disabled={!can_preview || is_saving || is_suggesting}
            className="mt-4 rounded bg-slate-900 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Förhandsvisa ändring
          </button>
          <div aria-live="polite" className="mt-4">
            {preview_title !== null && (
              <div className="rounded border border-slate-200 bg-slate-50 p-4">
                <h3 className="font-semibold">Förhandsvisning</h3>
                <dl className="mt-3 space-y-2">
                  <div>
                    <dt className="text-sm text-slate-600">Nuvarande titel</dt>
                    <dd className="break-words">{page.current_title || "(Utan titel)"}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-slate-600">Föreslagen titel</dt>
                    <dd className="break-words font-medium">{preview_title}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-sm text-slate-600">
                  Förslaget är inte sparat i WordPress.
                </p>
                <button
                  type="button"
                  onClick={save_title}
                  disabled={is_saving || is_suggesting}
                  className="mt-3 mr-3 rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-60"
                >
                  {is_saving ? "Sparar…" : "Godkänn och uppdatera WordPress"}
                </button>
                <button
                  type="button"
                  disabled={is_saving || is_suggesting}
                  onClick={() => {
                    set_new_title(page.current_title);
                    set_preview_title(null);
                  }}
                  className="mt-3 rounded border border-slate-300 px-3 py-2"
                >
                  Avbryt förslag
                </button>
              </div>
            )}
          </div>
        </form>
      )}
      {page && <WordPressParagraphs key={page.page_id} page_id={page.page_id} />}
      {error_message && (
        <p role="alert" className="mt-4 text-red-700">{error_message}</p>
      )}
      <p role="status" className="mt-4 text-green-800">{success_message}</p>
    </section>
  );
}
