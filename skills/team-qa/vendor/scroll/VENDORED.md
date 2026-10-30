# SCROLL inside Team QA

This folder is SCROLL 0.11.0 (MIT, Agent Pro): `bin/`, `lib/`, `templates/`, `LICENSE`, `package.json` and
`SPEC.md` from SCROLL commit a134d56e66d9e797bff49d6141eca6002bb6518d, the commit Team QA's CI pins. Nothing in it is
edited. Team QA confirms its file writes and appends its ledger rows through `lib/effects.js` and `lib/ledger.js`,
and `teamqa scroll <command>` runs `bin/scroll.js` (SKILL.md calls SCROLL check, build, eval and audit that way).

`TEAMQA_SCROLL_ROOT` points Team QA at another SCROLL copy. To move to a newer SCROLL, replace these files with the
same files from the new commit, update the commit above and in `.github/workflows/ci.yml`, and run the full suite.
SCROLL's own Vietnamese locale strings and Vietnamese matchers are listed under `non_english` in package-files.json.
