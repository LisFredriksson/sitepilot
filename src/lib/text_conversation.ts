import { resolve_text_response } from "./text_proposal.ts";
import type { TextContentSnapshot, TextSuggestionResult } from "./text_proposal.ts";

export type TextConversationTurn =
  | { kind: "user"; text: string }
  | { kind: "clarification"; question: string }
  | { kind: "proposal"; candidate_id: number; proposed_text: string };

export type TextConversation = {
  page_id: number;
  content_hash: string;
  turns: TextConversationTurn[];
};

export const MAX_CONVERSATION_TURNS = 20;
export const MAX_CONVERSATION_BYTES = 24_576;

export function new_text_conversation(content: TextContentSnapshot): TextConversation {
  return { page_id: content.page_id, content_hash: content.content_hash, turns: [] };
}

// Ett valt stycke hör till just denna innehållsversion. Nytt mål kräver ny redigering.
export function selected_candidate_id(conversation: TextConversation): number | null {
  const proposal = conversation.turns.find(turn => turn.kind === "proposal");
  return proposal?.kind === "proposal" ? proposal.candidate_id : null;
}

// Historik från klienten är obetrodd data: tillåt inga fria system-/developer-roller.
export function parse_text_conversation(content: TextContentSnapshot, data: unknown): TextConversation {
  if (data === undefined) return new_text_conversation(content);
  if (typeof data !== "object" || data === null ||
      !("page_id" in data) || data.page_id !== content.page_id ||
      !("content_hash" in data) || data.content_hash !== content.content_hash ||
      !("turns" in data) || !Array.isArray(data.turns) ||
      data.turns.length > MAX_CONVERSATION_TURNS - 2 || data.turns.length % 2 !== 0 ||
      new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_CONVERSATION_BYTES) {
    throw new Error("Samtalet är ogiltigt, för långt eller gäller en annan innehållsversion. Starta en ny redigering.");
  }
  const conversation = new_text_conversation(content);
  for (const [index, turn] of data.turns.entries()) {
    if (typeof turn !== "object" || turn === null || !("kind" in turn)) {
      throw new Error("Ogiltigt meddelande i samtalet.");
    }
    if (index % 2 === 0) {
      if (turn.kind !== "user" || Object.keys(turn).length !== 2 ||
          !("text" in turn) || typeof turn.text !== "string" || !turn.text.trim() || turn.text.length > 1000) {
        throw new Error("Ogiltigt användarmeddelande i samtalet.");
      }
      conversation.turns.push({ kind: "user", text: turn.text.trim() });
    } else {
      const previous = conversation.turns[index - 1];
      const result = resolve_text_response(content, content.content_hash, previous.kind === "user" ? previous.text : "", turn);
      if (result.kind === "clarification") {
        conversation.turns.push({ kind: "clarification", question: result.question });
      } else {
        const locked_id = selected_candidate_id(conversation);
        const id = (turn as { candidate_id: number }).candidate_id;
        if (locked_id !== null && locked_id !== id) throw new Error("Samtalet byter målstycke. Starta en ny redigering.");
        conversation.turns.push({ kind: "proposal", candidate_id: id, proposed_text: result.proposal.proposed_text });
      }
    }
  }
  return conversation;
}

export function append_text_exchange(
  content: TextContentSnapshot,
  conversation: TextConversation,
  instruction: string,
  result: TextSuggestionResult,
): TextConversation {
  const previous = parse_text_conversation(content, conversation);
  let reply: TextConversationTurn;
  if (result.kind === "clarification") {
    reply = { kind: "clarification", question: result.question };
  } else {
    const target = result.proposal.target;
    const candidate_id = content.paragraphs.findIndex(paragraph =>
      paragraph.source === target.source && paragraph.html_paragraph_index === target.html_paragraph_index &&
      paragraph.text === target.text && paragraph.block_path.length === target.block_path.length &&
      paragraph.block_path.every((part, index) => part === target.block_path[index]),
    );
    const locked_id = selected_candidate_id(previous);
    if (candidate_id < 0 || (locked_id !== null && locked_id !== candidate_id)) {
      throw new Error("AI-förslaget gäller ett annat stycke än den pågående redigeringen.");
    }
    reply = { kind: "proposal", candidate_id, proposed_text: result.proposal.proposed_text };
  }
  return { ...previous, turns: [...previous.turns, { kind: "user", text: instruction.trim() }, reply] };
}
