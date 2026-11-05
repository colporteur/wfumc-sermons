// Background for feedback: Todd's voice guide and a sermon's background docs.

import { sql, owner } from "../db";
import type { ToolDef } from "../protocol";
import { num, uuid } from "./util";

async function voiceGuide() {
  const [g] = await sql()`SELECT id, guide_text, word_count_target, updated_at FROM pastoral_voice_guides
                          WHERE owner_user_id = ${owner()} ORDER BY updated_at DESC LIMIT 1`;
  if (!g) return { note: "No voice guide saved yet (the app's Voice Guide page)." };
  const ex = await sql()`SELECT e.sermon_id, e.note, s.title, s.scripture_reference FROM voice_exemplars e
                         JOIN sermons s ON s.id = e.sermon_id WHERE e.voice_guide_id = ${g.id} ORDER BY e.sort_order`;
  return {
    guide: g.guide_text,
    word_count_target: g.word_count_target ?? null,
    exemplar_sermons: ex.map((e) => ({ sermon_id: e.sermon_id, title: e.title, scripture: e.scripture_reference, why: e.note ?? undefined })),
    note: "Exemplars are sermons Todd picked as samples of his voice; read them with get_sermon when judging voice.",
  };
}

async function backgroundDoc(a: Record<string, unknown>) {
  const id = uuid(a, "doc_id")!;
  const max = num(a, "max_chars", 60_000, 1_000, 400_000)!;
  const [d] = await sql()`SELECT id, sermon_id, title, kind, page_count, notes, source_url, extracted_text FROM sermon_background_docs
                          WHERE id = ${id} AND owner_user_id = ${owner()}`;
  if (!d) throw new Error(`No background document with id ${id}`);
  const t: string = d.extracted_text ?? "";
  return {
    id: d.id,
    sermon_id: d.sermon_id,
    title: d.title,
    kind: d.kind,
    pages: d.page_count,
    source_url: d.source_url ?? undefined,
    notes: d.notes,
    total_chars: t.length,
    truncated: t.length > max || undefined,
    text: t.slice(0, max) || "(no extracted text — scanned image without OCR?)",
  };
}

export function contextTools(): ToolDef[] {
  return [
    {
      name: "get_voice_guide",
      title: "Voice guide",
      description: "Todd's written preaching-voice guide, his target length, and the sermons he chose as voice exemplars. Use it as the yardstick for manuscript feedback.",
      inputSchema: { type: "object", properties: {} },
      run: voiceGuide,
    },
    {
      name: "get_background_doc",
      title: "Background document",
      description: "Extracted text of a background document attached to a sermon (commentary pages, articles). Ids come from get_sermon.",
      inputSchema: { type: "object", required: ["doc_id"], properties: { doc_id: { type: "string" }, max_chars: { type: "integer", default: 60000 } } },
      run: backgroundDoc,
    },
  ];
}
