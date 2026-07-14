// Revision-chat attachments — per-turn materials for the Workspace's
// chat-revise loop ("integrate this article into the manuscript").
//
// Unlike background documents (persistent, per-sermon, toggleable),
// chat attachments are EPHEMERAL: processed in the browser at attach
// time, sent with exactly one revision turn, stored nowhere. The
// revised manuscript is the artifact; once the material is woven in,
// the attachment has done its job. (For reference material you'll
// want across many turns, the Creative Studio's background documents
// are the right home.)
//
// Attachment shape handed to reviseSermonManuscript:
//   { name, kind: 'text',  text }                       — .txt/.md/text-PDF
//   { name, kind: 'image', images: [{media_type, data}] } — .jpg/.png/scanned PDF

import { extractPdfText } from './pdfText';
import { prepareImageForUpload, blobToBase64 } from './imageHelpers';
import { renderPdfPagesToJpegs } from './backgroundDocs';

const TEXT_CAP = 24000; // chars per text attachment in the prompt
const SCANNED_CHARS_PER_PAGE = 200; // same heuristic as backgroundDocs
const MAX_PDF_VISION_PAGES = 4;
export const MAX_IMAGES_PER_TURN = 8;

/**
 * Process one attached file into a prompt-ready attachment object.
 * Throws with a user-facing message on unsupported/undecodable input.
 */
export async function processAttachmentFile(file) {
  const name = file.name || 'attachment';
  const lower = name.toLowerCase();
  const isPdf = file.type === 'application/pdf' || lower.endsWith('.pdf');
  const isImage =
    /^image\/(jpeg|jpg|png)$/.test(file.type) || /\.(jpe?g|png)$/.test(lower);
  const isText =
    file.type === 'text/plain' ||
    file.type === 'text/markdown' ||
    /\.(txt|md)$/.test(lower);

  if (isText) {
    const text = (await file.text()).trim();
    if (!text) throw new Error(`"${name}" is empty.`);
    return { name, kind: 'text', text: cap(text) };
  }

  if (isImage) {
    const prepared = await prepareImageForUpload(file);
    return {
      name,
      kind: 'image',
      images: [
        {
          media_type: prepared.mediaType,
          data: await blobToBase64(prepared.blob),
        },
      ],
    };
  }

  if (isPdf) {
    // Text layer first; image-only scans fall back to page renders.
    try {
      const res = await extractPdfText(file);
      const text = (res.text || '').trim();
      if (text.length >= SCANNED_CHARS_PER_PAGE * Math.max(1, res.pageCount)) {
        return { name, kind: 'text', text: cap(text) };
      }
    } catch {
      /* fall through to vision */
    }
    const jpegs = await renderPdfPagesToJpegs(file, MAX_PDF_VISION_PAGES);
    const images = [];
    for (const jpeg of jpegs) {
      images.push({ media_type: 'image/jpeg', data: await blobToBase64(jpeg) });
    }
    if (!images.length) throw new Error(`Couldn't read "${name}" as text or images.`);
    return { name, kind: 'image', images };
  }

  throw new Error(
    `"${name}" isn't a supported attachment type (.pdf, .jpg, .png, .txt, .md).`
  );
}

function cap(text) {
  return text.length > TEXT_CAP
    ? text.slice(0, TEXT_CAP) + '\n[… truncated for prompt length …]'
    : text;
}

/**
 * Split processed attachments into the prompt pieces the revision call
 * needs: a text block and Anthropic image blocks (capped per turn).
 */
export function buildAttachmentPromptParts(attachments) {
  const list = attachments || [];
  const textParts = [];
  const imageBlocks = [];
  for (const a of list) {
    if (a.kind === 'text') {
      textParts.push(`### Attached: ${a.name}\n\n${a.text}`);
    } else if (a.kind === 'image') {
      const room = MAX_IMAGES_PER_TURN - imageBlocks.length;
      const used = (a.images || []).slice(0, Math.max(0, room));
      for (const img of used) {
        imageBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.media_type,
            data: img.data,
          },
        });
      }
      textParts.push(
        `### Attached: ${a.name} (${used.length} image${
          used.length === 1 ? '' : 's'
        } included with this message)`
      );
    }
  }
  return {
    textBlock: textParts.length
      ? '== ATTACHED MATERIALS FOR THIS INSTRUCTION ==\n\n' +
        textParts.join('\n\n---\n\n')
      : '',
    imageBlocks,
  };
}
