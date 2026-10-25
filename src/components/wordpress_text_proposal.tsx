"use client";

import { useEffect, useRef, useState } from "react";
import { parse_text_suggestion_response } from "@/lib/text_proposal";
import type { TextContentSnapshot, TextSuggestionResult } from "@/lib/text_proposal";
import { new_text_conversation, append_text_exchange, MAX_CONVERSATION_TURNS } from "@/lib/text_conversation";

export default function WordPressTextProposal({ content, on_reload, on_saved }: {
  content: TextContentSnapshot;
  on_reload: () => void;
  on_saved: () => void;
}) {
  const [instruction, set_instruction] = useState("");
  const [conversation, set_conversation] = useState(new_text_conversation(content));
  const [result, set_result] = useState<TextSuggestionResult | null>(null);
  const [error_message, set_error_message] = useState<string | null>(null);
  const [is_suggesting, set_is_suggesting] = useState(false);
  const [requires_reload, set_requires_reload] = useState(false);
  const [is_saving, set_is_saving] = useState(false);
  const request_ref = useRef<AbortController | null>(null);
  const has_target = content.paragraphs.some(paragraph => paragraph.text.trim());
  const proposal = result?.kind === "proposal" ? result.proposal : null;
  const last_turn = conversation.turns.at(-1);
  const conversation_full = conversation.turns.length >= MAX_CONVERSATION_TURNS;
  const target_index = proposal ? content.paragraphs.findIndex(paragraph =>
    paragraph.source === proposal.target.source &&
    paragraph.html_paragraph_index === proposal.target.html_paragraph_index &&
    paragraph.block_path.join(".") === proposal.target.block_path.join("."),
  ) : -1;

  // Förälderns key innehåller sid-ID och hash. Sidbyte/omläsning monterar om oss.
  useEffect(() => () => {
    request_ref.current?.abort();
    request_ref.current = null;
  }, []);

  async function suggest_text() {
    if (request_ref.current || requires_reload || conversation_full || !has_target || !instruction.trim()) return;
    const controller = new AbortController();
    request_ref.current = controller;
    set_is_suggesting(true);
    set_result(null);
    set_error_message(null);

    try {
      const response = await fetch("/api/ai/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page_id: content.page_id,
          content_hash: content.content_hash,
          instruction: instruction.trim(),
          conversation,
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]),
      });
      const data: unknown = await response.json();
      if (request_ref.current !== controller) return;
      if (!response.ok) {
        if (response.status === 409) set_requires_reload(true);
        const message = typeof data === "object" && data !== null &&
          "error" in data && typeof data.error === "string" && data.error.length <= 500
          ? data.error : "Kunde inte skapa textförslaget. Försök igen senare.";
        throw new Error(message);
      }
      const next_result = parse_text_suggestion_response(content, instruction, data);
      set_conversation(append_text_exchange(content, conversation, instruction, next_result));
      set_result(next_result);
      set_instruction("");
    } catch (error) {
      if (request_ref.current !== controller || controller.signal.aborted) return;
      set_error_message(error instanceof Error && error.name === "TimeoutError"
        ? "AI-anropet tog för lång tid. Du kan försöka igen. Ingen brödtext har sparats."
        : error instanceof Error ? error.message : "Kunde inte skapa textförslaget.");
    } finally {
      if (request_ref.current === controller) {
        request_ref.current = null;
        set_is_suggesting(false);
      }
    }
  }

  function start_new_edit() {
    if (is_saving || requires_reload) return;
    request_ref.current?.abort();
    request_ref.current = null;
    set_is_suggesting(false);
    set_conversation(new_text_conversation(content));
    set_result(null);
    set_instruction("");
    set_error_message(null);
  }

  async function save_proposal() {
    if (!proposal || proposal.target.source !== "paragraph_block" || request_ref.current || requires_reload) return;
    const controller = new AbortController();
    request_ref.current = controller;
    set_is_saving(true);
    set_error_message(null);
    try {
      const response = await fetch("/api/wordpress/page/paragraph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page_id: proposal.page_id, content_hash: proposal.content_hash,
          target: proposal.target, proposed_text: proposal.proposed_text, approved: true,
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
      });
      const data: unknown = await response.json();
      if (request_ref.current !== controller) return;
      if (!response.ok) {
        // Även ett avvisat förslag ska granskas på nytt innan nästa sparförsök.
        throw new Error(typeof data === "object" && data !== null &&
          "error" in data && typeof data.error === "string" && data.error.length <= 500
          ? data.error : "Kunde inte bekräfta sparandet. Hämta sidan igen innan ett nytt försök.");
      }
      if (typeof data !== "object" || data === null ||
          !("saved" in data) || data.saved !== true ||
          !("page_id" in data) || data.page_id !== proposal.page_id ||
          !("content_hash" in data) || typeof data.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(data.content_hash)) {
        throw new Error("Kunde inte bekräfta sparandet. Hämta sidan igen innan ett nytt försök.");
      }
      set_requires_reload(true);
      set_result(null);
      on_saved();
    } catch (error) {
      if (request_ref.current !== controller || controller.signal.aborted) return;
      set_requires_reload(true);
      set_error_message(error instanceof Error && error.name !== "TimeoutError" && error.name !== "TypeError" && error.name !== "SyntaxError"
        ? error.message : "Kunde inte bekräfta sparandet. WordPress kan ha sparat ändringen. Hämta sidan igen innan ett nytt försök.");
    } finally {
      if (request_ref.current === controller) {
        request_ref.current = null;
        set_is_saving(false);
      }
    }
  }

  return (
    <section className="mt-6 rounded border border-slate-200 bg-slate-50 p-4" aria-labelledby="text_proposal_heading">
      <h4 id="text_proposal_heading" className="font-semibold">Föreslå en ändring i brödtexten</h4>
      <p className="mt-2 text-sm text-slate-600">
        Beskriv ändringen med egna ord. lilo föreslår text för ett stycke eller
        ställer en följdfråga. WordPress uppdateras först när du godkänner och sparar.
      </p>
      {conversation.turns.length > 0 && (
        <ol aria-label="Pågående redigering" className="mt-4 space-y-3">
          {conversation.turns.map((turn, index) => (
            <li key={index} className="rounded border border-slate-200 bg-white p-3">
              <p className="text-sm font-semibold">{turn.kind === "user" ? "Du" : "lilo"}</p>
              {turn.kind === "proposal" && <p className="mt-1 text-sm text-slate-600">Förslag för stycke {turn.candidate_id + 1} · ännu inte sparat</p>}
              <p className="mt-1 whitespace-pre-wrap break-words">{turn.kind === "user" ? turn.text : turn.kind === "clarification" ? turn.question : turn.proposed_text}</p>
            </li>
          ))}
        </ol>
      )}
      <form
        className="mt-4"
        onSubmit={event => {
          event.preventDefault();
          void suggest_text();
        }}
      >
        <label htmlFor="text_instruction" className="block font-medium">
          {last_turn?.kind === "clarification" ? "Ditt svar till lilo" : conversation.turns.length ? "Vill du justera förslaget?" : "Hur vill du ändra brödtexten?"}
        </label>
        <textarea
          id="text_instruction"
          value={instruction}
          maxLength={1000}
          required
          disabled={!has_target || is_suggesting || is_saving || requires_reload || conversation_full}
          placeholder={conversation.turns.length ? "Svara på frågan eller beskriv en justering…" : "Gör introduktionen mer personlig och välkomnande."}
          onChange={event => {
            set_instruction(event.target.value);
            set_result(null);
            set_error_message(null);
          }}
          className="mt-2 w-full rounded border border-slate-300 bg-white px-3 py-2"
        />
        <button
          type="submit"
          disabled={!has_target || !instruction.trim() || is_suggesting || is_saving || requires_reload || conversation_full}
          className="mt-3 rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
        >
          {is_suggesting ? "lilo funderar…" : conversation.turns.length ? "Skicka till lilo" : "Föreslå brödtext med AI"}
        </button>
        {!has_target && <p className="mt-2 text-sm text-slate-600">Inget icke-tomt stycke finns att testa med.</p>}
      </form>
      {conversation_full && <p className="mt-2 text-sm text-slate-600">Samtalet har nått gränsen på tio svar. Godkänn ett färdigt förslag eller starta en ny redigering.</p>}
      {(conversation.turns.length > 0 || is_suggesting) && (
        <button type="button" disabled={is_saving || requires_reload} onClick={start_new_edit}
          className="mt-3 rounded border border-slate-300 px-3 py-2">Avbryt och starta ny redigering</button>
      )}
      {error_message && <p role="alert" className="mt-3 text-red-700">{error_message}</p>}
      {requires_reload && <button type="button" onClick={on_reload} disabled={is_saving} className="mt-3 rounded border border-slate-300 px-3 py-2">Hämta aktuellt innehåll</button>}
      <div aria-live="polite" aria-busy={is_suggesting || is_saving}>
        {is_saving && <p className="mt-3 text-sm text-slate-600">Sparar det godkända stycket i WordPress…</p>}
        {is_suggesting && <p className="mt-3 text-sm text-slate-600">Läser aktuellt innehåll och tar fram ett svar…</p>}
        {proposal && (
          <div className="mt-4 rounded border border-slate-200 bg-white p-4">
            <h5 className="font-semibold">Granska förslaget</h5>
            <p className="mt-2 text-sm text-slate-600">
              Gäller stycke {target_index + 1} · {proposal.target.source === "paragraph_block" ? "Paragrafblock" : "HTML-stycke"}
            </p>
            <dl className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <dt className="font-medium">Nuvarande text</dt>
                <dd className="mt-2 whitespace-pre-wrap break-words">{proposal.target.text}</dd>
              </div>
              <div>
                <dt className="font-medium">Föreslagen text</dt>
                <dd className="mt-2 whitespace-pre-wrap break-words">{proposal.proposed_text}</dd>
              </div>
            </dl>
            <p className="mt-4 text-sm text-slate-600">Kontrollera båda texterna före godkännande. Endast vanliga paragrafblock utan länkar eller formatering stöds för sparande.</p>
            {proposal.target.source === "paragraph_block" ? (
              <button type="button" disabled={is_saving || is_suggesting || requires_reload}
                onClick={() => { void save_proposal(); }}
                className="mt-3 mr-3 rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-60">
                {is_saving ? "Sparar…" : "Godkänn och spara"}
              </button>
            ) : <p className="mt-2 text-sm text-slate-600">Det här är ett HTML-stycke. Det kan förhandsvisas men inte sparas ännu.</p>}
            <button
              type="button"
              disabled={is_saving || requires_reload}
              onClick={start_new_edit}
              className="mt-3 rounded border border-slate-300 px-3 py-2"
            >
              Avfärda förslag
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
