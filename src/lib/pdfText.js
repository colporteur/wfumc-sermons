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
 * Extract text from a PDF Blob/File.
 *
 * @param {Blob|File} blob
 * @returns {Promise<{text: string, pageCount: number}>}
 */
export async function extractPdfText(blob) {
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

  const pageTexts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Each "item" is a positioned text run. Join with space, then collapse.
    const pageText = content.items
      .map((it) => (typeof it.str === 'string' ? it.str : ''))
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    pageTexts.push(pageText);
  }

  const text = pageTexts.join('\n\n').trim();
  return { text, pageCount: doc.numPages };
}
