// services/resumeImport/extract.js — the text of an uploaded resume (text PDF or DOCX), as written.
//   extractText(buffer, fileName) -> { kind: 'text' | 'scan' | 'empty' | 'unsupported', text, pages }
// No header rewriting: the old parser replaced every line containing "experience" / "skills" / "summary"
// with the bare header word, which deleted bullets before anything read them.
'use strict';
const path = require('path');
const pdfParse = require('pdf-parse/lib/pdf-parse.js'); // v1 API: a function (the old code called the v2 class and always threw)
const mammoth = require('mammoth');

// letters + digits in the text: a scanned PDF has pages but (almost) none
const meaningful = (t) => (String(t || '').match(/[\p{L}\p{N}]/gu) || []).length;

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    // "E D U C A T I O N" (letter-spaced headings) -> "EDUCATION"
    .replace(/^(?:[A-Za-z&] ){3,}[A-Za-z&]$/gm, (m) => m.replace(/ /g, ''))
    .trim();
}

async function extractText(buffer, fileName = '') {
  const ext = path.extname(String(fileName)).toLowerCase();
  if (ext === '.pdf' || (!ext && buffer.slice(0, 5).toString() === '%PDF-')) {
    // pdf.js reads the whole ArrayBuffer behind a Node Buffer: a pooled (small) Buffer has other bytes around it
    // and the xref offsets come out wrong ("bad XRef entry"). A fresh copy has exactly the file.
    const bytes = new Uint8Array(buffer.length);
    bytes.set(buffer);
    let data = null;
    for (const version of ['v1.10.100', 'v2.0.550']) { // pdf-parse's default pdf.js, then the newer bundled one
      try { data = await pdfParse(bytes.slice(), { version }); break; } catch (e) { /* the next build */ }
    }
    if (!data) return { kind: 'empty', text: '', pages: 0, error: 'this PDF could not be opened' };
    const text = tidy(data.text);
    const pages = data.numpages || 0;
    if (meaningful(text) < 40) return { kind: pages > 0 ? 'scan' : 'empty', text, pages };
    return { kind: 'text', text, pages };
  }
  if (ext === '.docx') {
    try {
      const { value } = await mammoth.extractRawText({ buffer });
      const text = tidy(value);
      return { kind: meaningful(text) < 40 ? 'empty' : 'text', text, pages: 0 };
    } catch (e) {
      return { kind: 'empty', text: '', pages: 0, error: 'this Word file could not be opened' };
    }
  }
  return { kind: 'unsupported', text: '', pages: 0 };
}

module.exports = { extractText, tidy, meaningful };
