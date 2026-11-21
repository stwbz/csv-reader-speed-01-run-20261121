# Fast CSV reader — make.fun entry

Faster drop-in for csv-reader 1.0.0, for the make.fun bounty
"Read broken CSV files faster, 21 November 2026".

`solve.js` is an ES module whose `run(input)` returns
`{columns, rows, errors}` exactly as csv-reader 1.0.0 does,
including its broken-CSV error handling (stray CR, unterminated
quotes, quote junk, short/long rows).

Design: single-pass, slice-based parsing. No per-character string
concatenation. Unquoted fields are found with native `indexOf`
and one slice; quoted fields are one slice when they contain no
doubled quote or line break.

Locally tested against the kit baseline: 99 edge cases, 5000
randomised fuzz cases, and 6/6 practice-set cases pass, at
about 5.5–6x the baseline speed on the practice set.

## Files

- `solve.js` — the entry
- `main.ts` — harness driver from the kit
- `package.json` — `{"type": "module"}`
