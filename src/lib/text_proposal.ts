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

export type TextCandidate = {
  candidate_id: number;
  text: string;
};

export type TextAIResponse =
  | { kind: "proposal"; candidate_id: number; proposed_text: string }
  | { kind: "clarification"; question: string };

export type TextSuggestionResult =
  | { kind: "proposal"; proposal: TextProposal }
  | { kind: "clarification"; question: string };

export function validate_text_ai_input(candidates: TextCandidate[], instruction: string) {
  if (!instruction.trim() || instruction.length > 1000) {
    throw new Error("Beskriv ändringen med 1–1000 tecken.");
  }
  if (candidates.length === 0) throw new Error("Sidan saknar textstycken att föreslå ändringar för.");
  if (candidates.length > 100 || new TextEncoder().encode(JSON.stringify(candidates)).byteLength > 32_768) {
    throw new Error("Sidan är för stor för ett AI-textförslag i prototypen. Inga stycken har skickats till AI.");
  }
  const ids = new Set<number>();
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.candidate_id) || candidate.candidate_id < 0 ||
        ids.has(candidate.candidate_id) || !candidate.text.trim()) {
      throw new Error("Ogiltiga textkandidater.");
    }
    ids.add(candidate.candidate_id);
  }
}

// ID är index i just denna innehållsversion. Tomma stycken behåller sin position.
export function get_text_candidates(content: TextContentSnapshot): TextCandidate[] {
  return content.paragraphs.flatMap((paragraph, index) =>
    paragraph.text.trim() ? [{ candidate_id: index, text: paragraph.text }] : [],
  );
}

// Råa modellsvar är okända data, även när modellen får ett strikt svarsschema.
// Målreferensen kommer alltid från serverns original, aldrig från modellens svar.
export function resolve_text_response(
  content: TextContentSnapshot,
  expected_content_hash: string,
  instruction: string,
  response: unknown,
): TextSuggestionResult {
  if (!/^[a-f0-9]{64}$/.test(content.content_hash) || content.content_hash !== expected_content_hash) {
    throw new Error("Sidinnehållet har ändrats. Hämta sidan igen innan du skapar ett nytt förslag.");
  }
  if (!instruction.trim() || instruction.length > 1000) {
    throw new Error("Beskriv ändringen med 1–1000 tecken.");
  }
  if (typeof response !== "object" || response === null || !("kind" in response)) {
    throw new Error("AI-svaret har ett ogiltigt format.");
  }

  if (response.kind === "clarification") {
    if (Object.keys(response).length !== 2 ||
        !("question" in response) || typeof response.question !== "string" ||
        !response.question.trim() || response.question.length > 500) {
      throw new Error("AI returnerade inte en giltig följdfråga.");
    }
    return { kind: "clarification", question: response.question.trim() };
  }

  if (response.kind !== "proposal" || Object.keys(response).length !== 3 ||
      !("candidate_id" in response) || typeof response.candidate_id !== "number" ||
      !Number.isSafeInteger(response.candidate_id) || response.candidate_id < 0 ||
      !("proposed_text" in response) || typeof response.proposed_text !== "string" ||
      !response.proposed_text.trim() || response.proposed_text.length > 5000) {
    throw new Error("AI returnerade inte ett giltigt textförslag.");
  }
  const target = content.paragraphs[response.candidate_id];
  if (!target || !target.text.trim()) {
    throw new Error("AI valde ett stycke som inte finns bland kandidaterna.");
  }

  return {
    kind: "proposal",
    proposal: {
      page_id: content.page_id,
      content_hash: content.content_hash,
      target: { ...target, block_path: [...target.block_path] },
      instruction: instruction.trim(),
      proposed_text: response.proposed_text.trim(),
    },
  };
}

// Klienten kontrollerar att serversvaret hör till samma sida och originalversion.
export function parse_text_suggestion_response(
  content: TextContentSnapshot,
  instruction: string,
  data: unknown,
): TextSuggestionResult {
  if (typeof data !== "object" || data === null ||
      !("page_id" in data) || data.page_id !== content.page_id ||
      !("content_hash" in data) || data.content_hash !== content.content_hash ||
      !("kind" in data)) {
    throw new Error("Svaret hör inte till den valda sidans innehållsversion.");
  }
  if (data.kind === "clarification" && "question" in data) {
    return resolve_text_response(content, content.content_hash, instruction, {
      kind: "clarification", question: data.question,
    });
  }
  if (data.kind !== "proposal" || !("proposal" in data) ||
      typeof data.proposal !== "object" || data.proposal === null) {
    throw new Error("Oväntat svar från textförslaget.");
  }
  const proposal = data.proposal;
  if (!("page_id" in proposal) || proposal.page_id !== content.page_id ||
      !("content_hash" in proposal) || proposal.content_hash !== content.content_hash ||
      !("instruction" in proposal) || proposal.instruction !== instruction.trim() ||
      !("proposed_text" in proposal) || !("target" in proposal) ||
      typeof proposal.target !== "object" || proposal.target === null) {
    throw new Error("Förslaget stämmer inte med sidan eller instruktionen.");
  }
  const target = proposal.target;
  if (!("block_path" in target) || !Array.isArray(target.block_path) ||
      !("source" in target) || !("html_paragraph_index" in target) || !("text" in target)) {
    throw new Error("Förslaget saknar en giltig styckereferens.");
  }
  const path = target.block_path;
  const candidate_id = content.paragraphs.findIndex(paragraph =>
    paragraph.source === target.source && paragraph.html_paragraph_index === target.html_paragraph_index &&
    paragraph.text === target.text && paragraph.block_path.length === path.length &&
    paragraph.block_path.every((part, index) => part === path[index]),
  );
  return resolve_text_response(content, content.content_hash, instruction, {
    kind: "proposal", candidate_id, proposed_text: proposal.proposed_text,
  });
}

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
