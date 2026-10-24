# jobhunt

A local pipeline for graduate job applications: a tracker, a cover-letter builder, and
an assisted browser session that fills in company career-site forms. I drive the
session, it fills fields, and I review and submit every application myself.

Built with Claude Code in the autumn of 2026 while I was applying for graduate roles. Most of
the code was written by the agent. The work I did was deciding what it should and should not do,
running it against real forms, and catching it when it said it had done something
it had not.

## What is in here

```
bin/jobhunt          tracker + .docx cover-letter builder. Python, stdlib only.
bin/autofill.mjs     Playwright session for career-site forms (Greenhouse, Workday,
                     UKG, Zoho, SuccessFactors, bespoke forms). You drive it page by page.
bin/creds            encrypted vault for career-site accounts (openssl AES-256, PBKDF2).
test/*.html          fake application forms that reproduce real failures. No employer is touched.
skill-levels.json    policy for skill-matrix questions.
profile.example.yaml the shape of the standing facts the tools fill forms from.
CLAUDE.md            the operating guide the coding agent works from.
```

Not in this repo: my profile, CV, tracker, applications, vault and browser sessions.

## Design decisions

- **The human drives, the tool fills.** The first version was "go to URL and fill". It
  failed on the first real graduate ATS. There was an account wall before the form, and
  the form itself was a 5-8 page wizard. Now it opens a session and waits for a command:
  `f` fill, `v` read back, `next`, `stuck`, `net`, `dom:<label>`. Captchas, terms
  checkboxes and the submit click are always mine.
- **No LinkedIn automation at all.** The ban risk is not worth it. The pipeline starts at a
  job description I paste. `autofill.mjs` refuses linkedin.com hostnames.
- **Passwords never move during a fill.** Password fields are skipped in code before any
  field matcher runs. Passwords move only on an explicit sign-in or register command.
- **Encrypted vault, not file permissions.** On WSL, `/mnt/c` ignores Unix modes, so
  `chmod 600` silently stays 777. Encryption is the only real protection there.

## What broke (and how I found out)

None of these were visible from reading the code. Every one was found by running against a
live posting and reading what actually happened:

- **The report said 7 fields filled. The form had 15.** An input-only DOM scan cannot see
  click-to-edit cells, dropdowns built from `<button>`, file inputs that appear only after
  a click, or fields inside an iframe. The rule now is a recon pass plus a dump of the
  page's visible text, and the field counts must agree before a run counts as complete.
  A successful-looking report is not evidence.
- **React comboboxes are not selects.** On Greenhouse/Ashby/Workday, typing into
  `input[role=combobox]` shows the text but never registers a value. The answer is silently
  lost on submit. The fix is to click, wait for `[role=option]`, then click the match.
- **"+44 +44 7700..."** A dial-code picker next to the number field. Choosing the country
  and then filling the international number doubles the code.
- **Greedy regexes steal fields.** `/graduat/` matched "Are you a recent graduate with a
  STEM degree?" (a yes/no question) and would have answered it with a date. Matchers are an
  ordered list, so the specific one must come before the general one.
- **Forms hydrate after load.** Scanning right after `domcontentloaded` missed a field
  entirely. It now waits for `networkidle` and does a scroll pass first.
- **Uploading a file invalidates sibling handles.** The ATS swaps the CV input for an
  "attached" widget, which detaches the cover-letter input. The fix is to plan every upload,
  then act by stable selector.

`test/practice-hostile.html` reproduces each of these on one page, so a change can be
checked without touching a real employer.

## Running it

```bash
npm install                       # Playwright 1.62.1
cp profile.example.yaml profile.yaml   # fill in your own facts
printf '%s' "$JD" | bin/jobhunt new -c "Company" -r "Role" -u URL -s company
bin/jobhunt list
node bin/autofill.mjs <slug>      # opens the session; type f to fill
```

Try it on the practice form first: point an application's URL at
`file://$PWD/test/practice-hostile.html`.
