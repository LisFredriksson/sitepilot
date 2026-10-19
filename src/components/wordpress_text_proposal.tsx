"use client";

import { useState } from "react";
import { create_mock_text_proposal } from "@/lib/text_proposal";
import type { TextContentSnapshot, TextProposal } from "@/lib/text_proposal";

export default function WordPressTextProposal({ content }: { content: TextContentSnapshot }) {
  const [instruction, set_instruction] = useState("");
  const [proposal, set_proposal] = useState<TextProposal | null>(null);
  const [error_message, set_error_message] = useState<string | null>(null);
  const has_target = content.paragraphs.some(paragraph => paragraph.text.trim());

  return (
    <section className="mt-6 rounded border border-slate-200 bg-slate-50 p-4" aria-labelledby="text_proposal_heading">
      <h4 id="text_proposal_heading" className="font-semibold">Testa ett textförslag</h4>
      <p className="mt-2 text-sm text-slate-600">
        Detta är en mock, utan AI-anrop. Den visar ett fast exempel för sidans första
        icke-tomma stycke, oavsett instruktion. Inget sparas i WordPress.
      </p>
      <form
        className="mt-4"
        onSubmit={event => {
          event.preventDefault();
          set_error_message(null);
          set_proposal(null);
          try {
            set_proposal(create_mock_text_proposal(content, instruction));
          } catch (error) {
            set_error_message(error instanceof Error ? error.message : "Kunde inte skapa testförslaget.");
          }
        }}
      >
        <label htmlFor="text_instruction" className="block font-medium">Hur vill du ändra brödtexten?</label>
        <textarea
          id="text_instruction"
          value={instruction}
          maxLength={1000}
          required
          disabled={!has_target}
          placeholder="Gör introduktionen mer personlig och välkomnande."
          onChange={event => {
            set_instruction(event.target.value);
            set_proposal(null);
            set_error_message(null);
          }}
          className="mt-2 w-full rounded border border-slate-300 bg-white px-3 py-2"
        />
        <button
          type="submit"
          disabled={!has_target || !instruction.trim()}
          className="mt-3 rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
        >
          Skapa testförslag för brödtext
        </button>
        {!has_target && <p className="mt-2 text-sm text-slate-600">Inget icke-tomt stycke finns att testa med.</p>}
      </form>
      {error_message && <p role="alert" className="mt-3 text-red-700">{error_message}</p>}
      <div aria-live="polite">
        {proposal && (
          <div className="mt-4 rounded border border-slate-200 bg-white p-4">
            <h5 className="font-semibold">Granska testförslaget</h5>
            <p className="mt-2 text-sm text-slate-600">
              Gäller det första icke-tomma stycket · {proposal.target.source === "paragraph_block" ? "Paragrafblock" : "HTML-stycke"}
            </p>
            <dl className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <dt className="font-medium">Nuvarande text</dt>
                <dd className="mt-2 whitespace-pre-wrap break-words">{proposal.target.text}</dd>
              </div>
              <div>
                <dt className="font-medium">Föreslagen text (mock)</dt>
                <dd className="mt-2 whitespace-pre-wrap break-words">{proposal.proposed_text}</dd>
              </div>
            </dl>
            <p className="mt-4 text-sm text-slate-600">Detta är enbart en förhandsvisning. Förslaget försvinner när du byter sida eller laddar om.</p>
            <button
              type="button"
              onClick={() => set_proposal(null)}
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
