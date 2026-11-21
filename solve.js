// Optimised drop-in for csv-reader 1.0.0 — v2 (local only, NOT submitted).
// Same semantics as ../solve.js, but the hot paths are inlined:
// - no per-field function call and no per-field {value, ended, added}
//   object allocation for unquoted fields or simple quoted fields;
// - rare paths (unterminated quote, quote junk, doubled quotes with
//   line breaks) still go through a slow helper, exactly as before.
// Semantics (mirror ../solve.js / kit/baselines/csv-reader):
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

  function countBreaks(s) {
    const m = s.match(/\r\n|\r|\n/g);
    return m === null ? 0 : m.length;
  }

  // Slow helper, used ONLY for the rare paths: quote junk after a
  // closing quote, and the re-read after an unterminated quote.
  // Identical logic to the original readUnquoted(); `rl`/`rr` are the
  // current record's line/row for error records.
  function readUnquotedSlow(initial, rl, rr) {
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
      const parts = segment.split('\r');
      for (let k = 0; k < parts.length - 1; k++) errors.push({ code: 'stray_cr', line: rl, row: rr });
      const cleaned = parts.join('');
      value = initial === '' ? cleaned : initial + cleaned;
      added = cleaned.length;
    }
    if (kind === COMMA) { pos = end + 1; return { value, ended: COMMA, added }; }
    if (kind === LINE_BREAK) { pos = end + 1; line += 1; return { value, ended: LINE_BREAK, added }; }
    pos = end;
    return { value, ended: END, added };
  }

  for (;;) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = width > 0 ? new Array(width) : [];
    let fi = 0;
    let ended = END;
    let quoted = false;

    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let parts = null;
        let segStart = pos + 1;
        let cur = pos + 1;
        let lineAdd = 0;
        for (;;) {
          const q = text.indexOf('"', cur);
          if (q === -1) {
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            const f = readUnquotedSlow('"', recordLine, recordRow);
            fields[fi++] = f.value;
            ended = f.ended;
            break;
          }
          if (text.charCodeAt(q + 1) === 34) {
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
          let seg = text.slice(segStart, q);
          if (seg.indexOf('\r') !== -1 || seg.indexOf('\n') !== -1) {
            lineAdd += countBreaks(seg);
            seg = seg.replace(/\r\n|\r/g, '\n');
          }
          const value = parts === null ? seg : parts.join('') + seg;
          line += lineAdd;
          pos = q + 1;
          if (pos >= n) { fields[fi++] = value; ended = END; break; }
          const c = text.charCodeAt(pos);
          if (c === 44) { pos += 1; fields[fi++] = value; ended = COMMA; break; }
          if (c === 10) { pos += 1; line += 1; fields[fi++] = value; ended = LINE_BREAK; break; }
          if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2; line += 1; fields[fi++] = value; ended = LINE_BREAK; break;
          }
          const junk = readUnquotedSlow(value, recordLine, recordRow);
          if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          fields[fi++] = junk.value;
          ended = junk.ended;
          break;
        }
      } else {
        quoted = false;
        // Char-loop scan to the next delimiter. One pass over the field
        // (avg ~8 chars) replaces two indexOf scans, the second of which
        // scanned to the end of the line (~100 chars). Stray CRs are
        // tracked in the same pass; the rare segment with a stray CR
        // takes the slow split/join path below.
        let i = pos;
        let kind = END;
        let hasCR = false;
        let valueEnd = n;
        while (i < n) {
          const c = text.charCodeAt(i);
          if (c === 44) { kind = COMMA; valueEnd = i; break; }
          if (c === 10) { kind = LINE_BREAK; valueEnd = i; break; }
          if (c === 13) {
            if (text.charCodeAt(i + 1) === 10) { kind = LINE_BREAK; valueEnd = i; break; }
            hasCR = true;
            i += 1;
            continue;
          }
          i += 1;
        }
        if (kind === END) valueEnd = n;
        let value;
        if (!hasCR) {
          value = text.slice(pos, valueEnd);
        } else {
          const segment = text.slice(pos, valueEnd);
          const parts = segment.split('\r');
          for (let k = 0; k < parts.length - 1; k++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          value = parts.join('');
        }
        fields[fi++] = value;
        if (kind === COMMA) { pos = valueEnd + 1; ended = COMMA; }
        else if (kind === LINE_BREAK) {
          // CRLF ends 2 chars after valueEnd, LF 1 char after.
          pos = text.charCodeAt(valueEnd) === 13 ? valueEnd + 2 : valueEnd + 1;
          line += 1; ended = LINE_BREAK;
        } else { pos = n; ended = END; }
      }
    } while (ended === COMMA);

    if (fi === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) { width = fi; fields.length = fi; }
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fi < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fi });
      while (fi < width) fields[fi++] = '';
      fields.length = width;
    } else if (fi > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width, fi) });
      fields.length = width;
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
