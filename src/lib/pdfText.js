// Best-effort PDF → plain text extraction, lazy-loaded.
//
// Uses pdfjs-dist. Imported dynamically so the heavy dep stays out of
// the initial bundle and only loads when the pastor actually uploads
// a PDF on the /resources/extract page.
//
// Returns the concatenated text content of every page, with page
// breaks indicated by a blank line. Image-only PDFs and broken files
// throw; the caller should surface the message.

let _pdfjsPromise = null;
async function getPdfjs() {
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = (async () => {
    const pdfjsLib = await import('pdfjs-dist');
    // pdfjs-dist needs a worker. The Vite build resolves the worker via
    // its dedicated subpath; we point GlobalWorkerOptions at it so
    // pdfjs uses our bundled worker rather than trying to load one from
    // a CDN at runtime.
    const workerSrc = (
      await import('pdfjs-dist/build/pdf.worker.mjs?url')
    ).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
    return pdfjsLib;
  })();
  return _pdfjsPromise;
}

/**
 * Extract text from a PDF Blob/File. Optionally limit to a specific
 * subset of pages (1-indexed) — useful when the pastor only wants the
 * relevant section of a long commentary, not the whole book.
 *
 * @param {Blob|File} blob
 * @param {Object} [opts]
 * @param {Set<number>} [opts.pages] - 1-indexed pages to include. When
 *   omitted, every page is extracted. Page numbers outside [1, pageCount]
 *   are silently skipped. The returned `text` only contains the included
 *   pages, joined with blank lines in document order.
 * @returns {Promise<{
 *   text: string,
 *   pageCount: number,
 *   pagesExtracted: number[],
 * }>}
 */
export async function extractPdfText(blob, { pages } = {}) {
  let pdfjs;
  try {
    pdfjs = await getPdfjs();
  } catch (e) {
    throw new Error(
      "Couldn't load the PDF parser. The app updated since this page loaded — please refresh and try again."
    );
  }
  const arrayBuffer = await blob.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const total = doc.numPages;
  const filter = pages instanceof Set ? pages : null;

  // pageTexts: per-page entries with the page number alongside the
  // extracted text. Lets the UI render a "PDF page 4: …" preview so
  // the pastor can catch the common front-matter shift (PDF page 4
  // ≠ printed page 4 when there's a cover, preface, TOC, etc.).
  const pageTexts = [];
  const pagesExtracted = [];
  for (let p = 1; p <= total; p++) {
    if (filter && !filter.has(p)) continue;
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Each "item" is a positioned text run. Join with space, then collapse.
    const pageText = content.items
      .map((it) => (typeof it.str === 'string' ? it.str : ''))
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    pageTexts.push({ page: p, text: pageText });
    pagesExtracted.push(p);
  }

  const text = pageTexts.map((pt) => pt.text).join('\n\n').trim();
  return { text, pageCount: total, pagesExtracted, pageTexts };
}
