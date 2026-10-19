"use client";

import { useEffect, useState } from "react";
import type { ParagraphPreview } from "@/lib/gutenberg";
import WordPressTextProposal from "@/components/wordpress_text_proposal";

type ContentPreview = {
  page_id: number;
  content_hash: string;
  paragraphs: ParagraphPreview[];
};

export default function WordPressParagraphs({ page_id }: { page_id: number }) {
  const [content, set_content] = useState<ContentPreview | null>(null);
  const [error_message, set_error_message] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function load_content() {
      try {
        const response = await fetch(`/api/wordpress/page/content?page_id=${page_id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Kunde inte läsa paragrafblocken. Hämta sidtiteln igen för att försöka på nytt.");
        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null ||
            !("page_id" in data) || data.page_id !== page_id ||
            !("content_hash" in data) || typeof data.content_hash !== "string" ||
            !/^[a-f0-9]{64}$/.test(data.content_hash) ||
            !("paragraphs" in data) || !Array.isArray(data.paragraphs)) {
          throw new Error("Oväntat svar för sidinnehållet.");
        }
        const paragraphs = data.paragraphs.map((item: unknown): ParagraphPreview => {
          if (typeof item !== "object" || item === null ||
              !("text" in item) || typeof item.text !== "string" ||
              !("block_path" in item) || !Array.isArray(item.block_path) ||
              item.block_path.length === 0 ||
              !item.block_path.every((index: unknown) => typeof index === "number" && Number.isSafeInteger(index) && index >= 0)) {
            throw new Error("Ogiltigt paragrafblock i svaret.");
          }
          if (!("source" in item) || !("html_paragraph_index" in item)) {
            throw new Error("Styckets källa saknas.");
          }
          if (item.source === "paragraph_block" && item.html_paragraph_index === null) {
            return { text: item.text, block_path: item.block_path, source: "paragraph_block", html_paragraph_index: null };
          }
          if (item.source === "block_html" && typeof item.html_paragraph_index === "number" &&
              Number.isSafeInteger(item.html_paragraph_index) && item.html_paragraph_index >= 0) {
            return { text: item.text, block_path: item.block_path, source: "block_html", html_paragraph_index: item.html_paragraph_index };
          }
          throw new Error("Ogiltig källa för textstycket.");
        });
        if (active) set_content({ page_id, content_hash: data.content_hash, paragraphs });
      } catch (error) {
        if (active) set_error_message(error instanceof Error ? error.message : "Kunde inte läsa innehållet.");
      }
    }
    void load_content();

    // Sidbyte avbryter anropet och hindrar även redan inkomna svar från att visas.
    return () => {
      active = false;
      controller.abort();
    };
  }, [page_id]);

  return (
    <section className="mt-8 border-t border-slate-200 pt-6" aria-labelledby="paragraphs_heading">
      <h3 id="paragraphs_heading" className="text-lg font-semibold">Sidans textstycken</h3>
      <p className="mt-2 text-sm text-slate-600">Här visas paragrafblock och textstycken i blockens HTML. Texten är skrivskyddad.</p>
      <div aria-live="polite" className="mt-4">
        {!content && !error_message && <p>Läser textstycken…</p>}
        {error_message && <p role="alert" className="text-red-700">{error_message}</p>}
        {content?.paragraphs.length === 0 && (
          <p>Inga textstycken hittades i sidans sparade innehåll. Text från temamallar och refererade mönster visas inte här.</p>
        )}
        {content && content.paragraphs.length > 0 && (
          <ol className="space-y-3">
            {content.paragraphs.map((paragraph, index) => (
              <li key={`${content.content_hash}:${paragraph.block_path.join(".")}:${paragraph.source}:${paragraph.html_paragraph_index}`} className="rounded border border-slate-200 p-4">
                <span className="text-sm text-slate-500">Stycke {index + 1} · {paragraph.source === "paragraph_block" ? "Paragrafblock" : "HTML-stycke"}</span>
                <p className="mt-1 whitespace-pre-wrap break-words">{paragraph.text || "(Tomt stycke)"}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
      {content && content.page_id === page_id && (
        <WordPressTextProposal key={`${content.page_id}:${content.content_hash}`} content={content} />
      )}
    </section>
  );
}
