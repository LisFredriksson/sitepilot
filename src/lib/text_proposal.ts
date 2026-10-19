import type { ParagraphPreview } from "./gutenberg";

export type TextContentSnapshot = {
  page_id: number;
  content_hash: string;
  paragraphs: ParagraphPreview[];
};

export type TextProposal = {
  page_id: number;
  content_hash: string;
  target: ParagraphPreview;
  instruction: string;
  proposed_text: string;
};

// Mocken väljer alltid första icke-tomma stycket. Instruktionen tolkas inte ännu.
export function create_mock_text_proposal(
  content: TextContentSnapshot,
  instruction: string,
): TextProposal {
  if (!instruction.trim() || instruction.length > 1000) {
    throw new Error("Beskriv ändringen med 1–1000 tecken.");
  }
  const target = content.paragraphs.find(paragraph => paragraph.text.trim());
  if (!target) throw new Error("Sidan har inget textstycke att skapa ett testförslag för.");

  return {
    page_id: content.page_id,
    content_hash: content.content_hash,
    target: { ...target, block_path: [...target.block_path] },
    instruction: instruction.trim(),
    proposed_text: "Varmt välkommen till oss! Här berättar vi mer om hur vi kan hjälpa dig.",
  };
}
