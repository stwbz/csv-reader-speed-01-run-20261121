// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
// Single pass, slice-based: no per-character string concatenation.
// Unquoted fields are found with native indexOf for ',', '\n', '\r';
// quoted fields are found with native indexOf for the closing '"',
// and are a single slice when they contain no doubled quote and no
// line break. Only the rare broken cases (stray CR, doubled quotes,
// line breaks inside quotes, quote junk, unterminated quotes) take a
// slower segment-join path.
//
// Semantics mirror the reference exactly (see kit/baselines/csv-reader):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with '"' runs to the next non-doubled '"'; '""' is
//   one '"', CRLF / lone CR inside is read as LF; text after the closing
//   quote up to the next comma/line break is appended as-is (quote_junk,
//   when the field ends); a quote that never closes is a literal and the
//   text after it is re-read as unquoted (unterminated_quote).
// - A '"' inside an unquoted field is a literal. Fields stay strings.
// - columns = first record if header, else null; rows are padded
//   (short_row, fields: count) or cut (long_row, extra: cut fields) to
//   the first record's width.
// - errors are {code, line, row} in order met; line is the 1-based line
//   the record starts on, row its index in rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Count line breaks in a quoted segment: CRLF counts once, lone CR
  // once, LF once.
  function countBreaks(s) {
    const m = s.match(/\r\n|\r|\n/g);
    return m === null ? 0 : m.length;
  }

  // Read an unquoted field starting at pos. `initial` is a string to
  // prepend (the quoted content for quote junk, or '"' for the
  // unterminated-quote re-read, else '').
  // Returns {value, ended, added} where added counts the characters
  // kept by this call (excluding `initial`).
  // Only two native indexOf calls are made, for ',' and '\n' (both stop
  // at the next delimiter, a short distance away). A '\r' can only be
  // a CRLF ending the field (handled by trimming it) or a stray CR
  // inside the field's own slice, which is checked on that short slice
  // alone — never by scanning ahead for the next '\r' in the file,
  // which is far away on LF-only files and was the slow path.
  function readUnquoted(initial) {
    const comma = text.indexOf(',', pos);
    const lf = text.indexOf('\n', pos);
    let end = n;
    let kind = END;
    if (comma !== -1 && comma < end) { end = comma; kind = COMMA; }
    if (lf !== -1 && lf < end) { end = lf; kind = LINE_BREAK; }
    let valueEnd = end;
    if (kind === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) valueEnd = end - 1;
    const segment = text.slice(pos, valueEnd);
    let value;
    let added;
    if (segment.indexOf('\r') === -1) {
      value = initial === '' ? segment : initial + segment;
      added = segment.length;
    } else {
      // Every '\r' left in the segment is stray (a CRLF was trimmed
      // above): drop it and record one stray_cr per CR.
      const parts = segment.split('\r');
      for (let k = 0; k < parts.length - 1; k++) error('stray_cr');
      const cleaned = parts.join('');
      value = initial === '' ? cleaned : initial + cleaned;
      added = cleaned.length;
    }
    if (kind === COMMA) {
      pos = end + 1;
      return { value, ended: COMMA, added };
    }
    if (kind === LINE_BREAK) {
      pos = end + 1;
      line += 1;
      return { value, ended: LINE_BREAK, added };
    }
    pos = end;
    return { value, ended: END, added };
  }

  // Read a quoted field; pos is at its opening quote.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let segStart = pos + 1;
    let cur = pos + 1;
    let lineAdd = 0;
    for (;;) {
      const q = text.indexOf('"', cur);
      if (q === -1) {
        // Never closes: literal quote, re-read the rest as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one literal quote.
        if (parts === null) parts = [];
        let seg = text.slice(segStart, q + 1);
        if (seg.indexOf('\r') !== -1 || seg.indexOf('\n') !== -1) {
          lineAdd += countBreaks(seg);
          seg = seg.replace(/\r\n|\r/g, '\n');
        }
        parts.push(seg);
        cur = q + 2;
        segStart = q + 2;
        continue;
      }
      // Closing quote at q.
      let seg = text.slice(segStart, q);
      if (seg.indexOf('\r') !== -1 || seg.indexOf('\n') !== -1) {
        lineAdd += countBreaks(seg);
        seg = seg.replace(/\r\n|\r/g, '\n');
      }
      const value = parts === null ? seg : parts.join('') + seg;
      line += lineAdd;
      pos = q + 1;
      if (pos >= n) return { value, ended: END, added: 0 };
      const c = text.charCodeAt(pos);
      if (c === 44) { pos += 1; return { value, ended: COMMA, added: 0 }; }
      if (c === 10) { pos += 1; line += 1; return { value, ended: LINE_BREAK, added: 0 }; }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2; line += 1; return { value, ended: LINE_BREAK, added: 0 };
      }
      // Junk after the closing quote, appended as it stands.
      const junk = readUnquoted(value);
      if (junk.added > 0) error('quote_junk');
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended = END;
    do {
      quoted = text.charCodeAt(pos) === 34;
      const field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
      ended = field.ended;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
