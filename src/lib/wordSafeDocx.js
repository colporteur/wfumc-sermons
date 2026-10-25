// Post-process .docx files from the `docx` npm library (v8) so desktop
// Microsoft Word will open them.
//
// Background (Oct 2026): Word for Windows started refusing these exports
// with "Word experienced an error trying to open the file", even though
// LibreOffice, Google Docs and Word's own schema accept them. We tested
// variants of a failing liturgy directly in Todd's Word and the file
// opened as soon as the library's boilerplate footnotes part was removed
// (its separator footnotes carry a <w:footnoteRef/>, which Word chokes on).
// None of the WFUMC exports use footnotes, so we drop that part.
//
// While we're in there we also apply the other fixes the working test
// file had, to match it exactly:
//   - <w:rFonts> moved to the front of each <w:rPr> (Word's schema order)
//   - word/fontTable.xml actually referenced from document.xml.rels
//   - "Normal" + "Default Paragraph Font" styles defined (the library's
//     styles reference them without defining them)
//
// Usage:  const blob = await makeWordSafe(await Packer.toBlob(doc));
//
// This file is shared verbatim between WFUMC SS and WFUMC Sermons App.

import JSZip from 'jszip';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function moveRFontsFirst(xml) {
  return xml.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (whole, body) => {
    const fonts = body.match(/<w:rFonts\b[^>]*\/>/);
    if (!fonts) return whole;
    let rest = body.replace(/<w:rFonts\b[^>]*\/>/g, '');
    const style = rest.match(/^<w:rStyle\b[^>]*\/>/);
    rest = style
      ? style[0] + fonts[0] + rest.slice(style[0].length)
      : fonts[0] + rest;
    return '<w:rPr>' + rest + '</w:rPr>';
  });
}

export async function makeWordSafe(blob) {
  try {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const read = (p) => (zip.file(p) ? zip.file(p).async('string') : null);

    const docXml = await read('word/document.xml');
    if (!docXml) return blob;

    // 1. Drop the unused footnotes part (only if no real footnotes).
    const usesFootnotes = /<w:footnoteReference\b/.test(docXml);
    let rels = await read('word/_rels/document.xml.rels');
    let types = await read('[Content_Types].xml');
    if (!usesFootnotes && zip.file('word/footnotes.xml')) {
      zip.remove('word/footnotes.xml');
      zip.remove('word/_rels/footnotes.xml.rels');
      if (rels) {
        rels = rels.replace(
          /<Relationship\b[^>]*Target="footnotes\.xml"[^>]*\/>/g,
          ''
        );
      }
      if (types) {
        types = types.replace(
          /<Override\b[^>]*PartName="\/word\/footnotes\.xml"[^>]*\/>/g,
          ''
        );
      }
    }

    // 2. Make sure fontTable.xml is referenced.
    if (rels && zip.file('word/fontTable.xml') && !/Target="fontTable\.xml"/.test(rels)) {
      const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => +m[1]);
      const next = (ids.length ? Math.max(...ids) : 0) + 1;
      rels = rels.replace(
        '</Relationships>',
        `<Relationship Id="rId${next}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/></Relationships>`
      );
    }
    if (rels) zip.file('word/_rels/document.xml.rels', rels);
    if (types) zip.file('[Content_Types].xml', types);

    // 3. rFonts first in every run-properties block.
    for (const p of Object.keys(zip.files)) {
      if (/^word\/(document|header\d*|footer\d*|comments|styles|numbering)\.xml$/.test(p)) {
        const xml = await read(p);
        if (xml) zip.file(p, moveRFontsFirst(xml));
      }
    }

    // 4. Define the Normal / Default Paragraph Font styles if missing.
    let styles = await read('word/styles.xml');
    if (styles && !/w:styleId="Normal"/.test(styles)) {
      const add =
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
        '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>';
      styles = styles.includes('</w:docDefaults>')
        ? styles.replace('</w:docDefaults>', '</w:docDefaults>' + add)
        : styles.replace(/(<w:styles\b[^>]*>)/, '$1' + add);
      zip.file('word/styles.xml', styles);
    }

    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    return new Blob([bytes], { type: DOCX_MIME });
  } catch (e) {
    // Never block a download over the cleanup step.
    console.warn('makeWordSafe failed; returning original docx', e);
    return blob;
  }
}
