# jobhunt - the application pipeline

Local application pipeline for the job hunt.

## Layout

```
profile.yaml         standing facts + evidence bank + cover-letter tone. Edit by hand.
applications.json    the tracker. Written by bin/jobhunt only - do not hand-edit.
cv/                  canonical CV (.pdf + .docx)
apps/<slug>/         one application: jd.md, cover.md, Cover_*.docx, answers.json,
                     answers.md, prep-<stage>.md
                     session.json  what the last autofill run found, for Claude to read
                     shots/        a full-page screenshot per step, same audience
                     .session-ask  fields needing a decision; .session-cmd is the reply
qa-bank.json         questions answered before, matched by question text next time
bin/jobhunt          tracker + .docx builder. Python, stdlib only.
bin/autofill.mjs     assisted browser session for company career sites (you drive).
bin/creds            encrypted vault for ATS career-site accounts (openssl AES-256).
.creds.enc           the vault. Encrypted, so the useless /mnt/c permissions do not matter.
.browser/            persistent browser profiles - holds ATS login sessions. Not for sharing.
```

## The three skills

These are Claude Code skills kept in `~/.claude/skills/`, not in this repo.


- `/job-apply` - JD in → record, cover .docx, answer sheet, optional autofill.
- `/job-inbox` - Gmail sweep → match replies to applications → what each needs next.
- `/job-prep`  - interview / assessment day / online test → grounded prep brief.

## CLI

```bash
cd jobhunt
printf '%s' "$JD" | bin/jobhunt new -c "Company" -r "Role" -u URL -s company
bin/jobhunt cover <slug>                      # cover.md -> .docx
bin/jobhunt set <slug> status=applied next="chase 2026-10-14"
bin/jobhunt list [--status applied] [--all]
bin/jobhunt show <slug>
bin/jobhunt find "text from an inbound email"  # which application is this about
bin/jobhunt stale --days 14

node bin/autofill.mjs <slug> --auto              # fill + attach on open
node bin/autofill.mjs <slug> --auto --submit     # ...and enable the x command
node bin/autofill.mjs <slug> --time              # print where the seconds went
node bin/autofill.mjs <slug> --careful           # slow, generous waits, for a flaky ATS
```

Session keys: `f` fill, `v` read the page back, `a` answer one outstanding field,
`u` attach CV+cover, `l` sign in, `n` register, `r` report only, `c` enter an emailed
security code, `x` submit (needs `--submit`), `s` answer sheet, `q` quit.

Added 2026-09-30, after a Workday account wall cost an afternoon - all available both
interactively and as `.session-cmd` lines:

- `next` (or `p`) - press Next/Continue/Save and Continue, work out whether the page
  actually advanced, and fill whatever loads. Never presses Submit.
- `stuck` - why the page will not advance: its own error text, every required field still
  empty, everything marked `aria-invalid`. Runs automatically when `next` does not move.
- `text` - print the visible page text. The report only knows about controls, so an error
  banner or an "account already exists" line used to be invisible.
- `why:<label>` - why a button will not click: disabled, covered (and by what), moving,
  off-screen. `Timeout 6000ms exceeded` is three different bugs wearing one message.
- `type:<label>=<value>` - type a value key by key instead of `fill()`ing it, for a form
  whose framework ignores a synthetic value.
- `net` - recent POSTs, non-2xx responses with their bodies, failed requests and console
  errors. A form that refuses silently on screen is usually saying plenty over the wire -
  or, as with Workday, saying nothing at all, which is itself the answer.
- `dom:<label>` - the raw markup around a field or button, plus its `data-automation-id`s
  and any hidden inputs. Read the markup before theorising about the behaviour: on a
  Workday page the automation ids name things outright.

### Workday: the one click that stays Arion's

Workday wraps Create Account (and Submit) in an invisible captcha - a transparent
`<div data-automation-id="click_filter">` inside `noCaptchaWrapper`, laid over the real
button. An automated press is swallowed: no navigation, no error, no `aria-invalid`, and
**no request sent at all** (confirmed with `net` - the only POST on the page is the job
search). `clickHard()` detects the gate and says so immediately rather than timing out;
`register` fills everything and saves the password to the vault first, so the account works
the moment he clicks. Do not try to get past this - it is a bot check, and the rule above
is not negotiable.

Other flags: `--rounds N` (repair passes, default 2), `--force` (submit anyway),
`--noshots` (skip screenshots), `--profile <name>`, `--url URL`, `--bundled`.

`--hold <minutes>` keeps the browser open with no terminal attached, and watches
`apps/<slug>/.session-cmd` for a line of command - so a session started for Arion can still
be driven:

```bash
echo 'code:mq52l590'      >> apps/<slug>/.session-cmd  # enter the emailed code
echo 'answer:q2:Because…' >> apps/<slug>/.session-cmd  # answer one field from .session-ask
echo 'key:grade=2:1'      >> apps/<slug>/.session-cmd  # set an answers.json key, then re-fill
echo 'fill'               >> apps/<slug>/.session-cmd  # re-fill the current page
echo 'attach'             >> apps/<slug>/.session-cmd  # re-attach CV + cover
echo 'verify'             >> apps/<slug>/.session-cmd  # read the page back, write session.json
echo 'signin'             >> apps/<slug>/.session-cmd  # sign in with the stored account
echo 'set:City=London'     >> apps/<slug>/.session-cmd  # change one field by name, any state
echo 'expand'             >> apps/<slug>/.session-cmd  # open every folded section
echo 'click:Sign up'      >> apps/<slug>/.session-cmd  # click a link/button by its label
echo 'shot'               >> apps/<slug>/.session-cmd  # screenshot + session.json, no changes
echo 'unlock:<passphrase>' >> apps/<slug>/.session-cmd  # give a held session the vault key
echo 'register'           >> apps/<slug>/.session-cmd  # register an account here
echo 'quit'               > apps/<slug>/.session-cmd
```

Statuses: `drafting applied acknowledged assessment interview offer rejected ghosted withdrawn`

## Rules that are not negotiable

- **Never automate linkedin.com.** No scraping job listings, no driving Easy Apply, no
  logging in with a browser tool. It breaks their ToS and risks the account. LinkedIn's part
  of this workflow stays manual; the automation starts at the JD text he pastes.
  `autofill.mjs` refuses linkedin.com hostnames and should keep doing so.
- **Submit is opt-in, never default.** Without `--submit` the `x` command refuses. A
  misfired application to a real employer cannot be taken back, so the flag is Arion's
  decision each time, not a setting.
- **No evading bot detection.** Not spoofing the browser fingerprint, not patching out
  automation flags, not captcha-solving services. Using real Google Chrome instead of the
  bundled testing build is fine - that is using an ordinary browser, not faking one. If a
  site escalates to a code or a captcha, that is answered honestly or by hand.
- **Captchas are never solved programmatically.** `x` detects reCAPTCHA/hCaptcha and stops.
  Defeating a bot check is both wrong and unreliable - Arion clicks it.
  An **emailed security code is different**: it proves control of his own inbox, which he has
  granted access to. Fetch it from Gmail and enter it with `c` / `code:`.
- **One session per browser profile.** Launching a second run against a profile already in
  use fails with "Opening in existing browser session". Use `--profile <name>` for a
  concurrent session; that profile will not share ATS logins with `default`.
- **Passwords only move on an explicit `l` or `n`.** The `f` (fill) pass skips password
  fields unconditionally. Passwords live only in `.creds.enc`, never in `answers.json`,
  never in `profile.yaml`, never in the kb, and never in chat.
- **The vault is for career sites only.** Never put a bank, primary email, or any account
  that matters into it.
- **Never email an employer without him reading it.** Draft into Gmail drafts; he sends.
- **Do not invent profile facts.** A `TODO` in `profile.yaml` stays a gap that gets reported,
  not a guessed salary, grade, or visa status.

## Maintenance

- Playwright is pinned to **1.62.1** because that is the version whose chromium build
  (rev 1234) is already in `~/.cache/ms-playwright`. Bumping it means running
  `npx playwright install chromium`.
- New CV → drop it in `cv/` and delete the old one, so there is one canonical CV.

## Testing it without touching a real employer

`test/practice-form.html` is a fake ATS form (24 fields, the usual graduate-application
shape) that submits nowhere. `apps/practice-ltd-graduate-software-engineer/` is a complete
worked example against it - JD, cover.md, the built .docx, and answers.json. It is marked
`withdrawn` so it stays out of `jobhunt list`; read it with `--all`. (Not in the public
repo: its answer sheet carries real profile data.)

`test/practice-hostile.html` is the second one, and the more important. Every widget on it
is a failure mode that actually happened on a real posting and was caught by Arion rather
than by the tool: a click-to-edit cell, a dropdown rendered as a `<button>`, a date input
fed prose, a dial-code selector next to the number field, a controlled input that discards
what was typed into it on blur, a required question with no reachable control at all, and
an sr-only hidden input behind a fake widget.

Dry run:

```bash
cd jobhunt
S=practice-ltd-graduate-software-engineer
# the login wall, then the form - the two-page shape a real ATS has
printf 'f\nq\n' | node bin/autofill.mjs $S --url "file://$PWD/test/practice-login.html"
printf 'f\nq\n' | node bin/autofill.mjs $S --url "file://$PWD/test/practice-form.html"
printf 'f\nq\n' | node bin/autofill.mjs $S --url "file://$PWD/test/practice-hostile.html"
```

Expected:

- **login** - fills **email only**, reports 1 password field untouched.
- **practice-form** - `STATUS 21 confirmed | 0 not taken | 0 required-empty | 3 unanswered
  | 0 new | 0 hidden | 1 yours`, in about 5 seconds. The 3 unanswered are
  `grade`/`cover_letter`/`pronouns`.
- **practice-hostile** - `7 confirmed | 1 not taken | 2 required-empty | 0 unanswered |
  1 new | 2 hidden | 1 folded | 0 yours | 1 bot-trap skipped`. Every one of those non-green
  numbers is the point: a green run here means a check broke. Specifically it must report
  "Why do you want to work here?" as **not taken** (the input discards what is typed into it
  on blur), the work-permit question and the sr-only qualification as **hidden**, "Preferred
  office" as **new** rather than as filled with its own placeholder text, and both the
  free-text screening question and the employment-row Location as **required-empty**. It must
  report the folded Work Experience section as **folded**, and must REFUSE that Location
  ("belongs to a job entry - not the candidate's own") rather than filling it with his home
  city. It must report exactly **1 bot trap skipped** and leave that input empty. The date
  field passes only because `start_date_iso` is in this app's `answers.json`; remove it and it
  must come back as not-taken with the reason attached.

  The two numbers that changed on 2026-09-30 (`5 -> 7 confirmed`, `1 -> 2 required-empty`,
  `2 -> 1 new`) were **already wrong in this file before that session**, not a regression: the
  page pre-fills Job Title and Company with `value=` attributes and the documented figures
  predate that. Verified by running the same page against a build with the day's fill-path
  changes reverted - identical output. If these numbers drift again, check that way before
  assuming the filler broke.

- **practice-hostile, the Next button** - `printf 'next\nq\n' | node bin/autofill.mjs $S
  --url "file://$PWD/test/practice-hostile.html"` must print `pressed "Next" (activated from
  the keyboard - something was covering it ...)` and then fill the second step's LinkedIn
  field. The button is deliberately covered by a transparent overlay: an ordinary click
  times out, and a green result here means the keyboard fallback in `clickHard` has broken.

When changing `MATCHERS`, re-run all three and check nothing lands in the wrong field. The
recurring bug is a broad regex earlier in the list stealing a later field - "Degree
classification" taking the degree name, "Street address" taking the city. Since the answer
bank now matches on question text ahead of the regexes, also check `qa-bank.json` has not
learned something wrong; practice pages are excluded from it on purpose (`file://` hosts are
never written to the bank unless `JOBHUNT_BANK` points somewhere else).

## Credentials

```bash
export JOBHUNT_KEY='<master passphrase>'   # optional; otherwise prompted on /dev/tty
bin/creds set careers.example.com   # existing account
bin/creds set <host> --gen                       # generate a strong one
bin/creds list                                   # hosts + emails, no passwords
bin/creds export                                 # everything, to paste into a password manager
```

AES-256-CBC, PBKDF2 at 200k iterations. **The master passphrase cannot be recovered** - it
belongs in Arion's real password manager. `/mnt/c` is a Windows drive that ignores Unix file
permissions, so encryption is the only protection the vault has; that is why it is encrypted
rather than a 600 plaintext file.

## How the tool knows what it missed

The filler used to be the only witness to its own work: `report()` said what it had done,
and a field its selectors never matched was not reported as missing, it simply was not
reported. That is how the Retable form went in looking successful with 7 of 15 questions
filled. Three things changed so that "missing" is computed rather than absent.

**One inspection, three independent lists.** `inspect()` makes a single `evaluate` call per
frame and returns the *controls* it can address, the *question groups* (fieldset + legend)
and their current answers, and every visible *question label* with whether a control sits
behind it. The label list is built without reference to the control list, so a question with
no reachable widget - a click-to-edit cell, a button that is really a dropdown, an sr-only
input behind a fake one - shows up as a **ghost** instead of as silence.

**Folded sections are named, not skipped.** UKG Pro Recruiting (and Workday, and
SuccessFactors) put Work Experience, Education, Skills and Links behind accordion headers
whose fields do not exist in the DOM until the header is clicked. They are not controls, not
labels, and not even ghosts - so an application can go in with the entire employment history
blank while the report says nothing is outstanding. Arion caught that on a live form; the
tool did not. `sections()` now finds the toggles and `expandAll()` opens them, and anything
still shut is reported with status `collapsed`, which counts as a blocker.

Two things that version got wrong and are worth not repeating: it called `innerText` on every
span on the page, which forces a layout per element and simply never returned; and it had no
cap on how many toggles it would click, so on a job-description page it worked through every
element whose class contained "edit". It now uses `textContent`, caps the candidate list, caps
the clicks, and stops if a "toggle" turns out to navigate.

**The read-back compares to intent, not to emptiness.** `scan()` records what it put in;
`assess()` re-reads the page with nothing focused and asks whether the page agrees. Both
halves matter: "+44 +44 7700..." is non-empty, and so is a box that silently dropped
"Available immediately" because it only accepts `YYYY-MM-DD`. Per-field status is `ok`,
`mismatch`, `empty_required`, `no_answer`, `unrecognised`, `ghost` or `human_only`.

**The result is written down, not narrated.** Every fill and every recon writes
`apps/<slug>/session.json` plus a full-page screenshot in `apps/<slug>/shots/`. Anything
unresolved also goes to `.session-ask`, which Claude answers by writing one line to
`.session-cmd` - `answer:<id>:<text>` for a single field, `key:<name>=<value>` for something
that will recur. That is the same channel the emailed-security-code flow already used,
pointed the other way. **Read `session.json`; do not ask Arion what the report said.**

Ask ids are derived from the question text, not its position in the list. They used to be
`q1..qn` by position, so answering one renumbered the rest - and an answer written against the
list you last read landed in whatever field had moved into that slot. On a UKG Pro form
that put "Surrey" into a disability-accommodations box. Ids now survive the list changing.

`answer:` only reaches fields that are currently blockers, so a field filled with the WRONG
value had no route at all. `set:<label prefix>=<value>` changes one field whatever its status,
and prefers the blank one when a label repeats across a section (three Work Experience rows
all have a "Company / Organization").

**A resume parser overwrites what you already filled.** UKG's "Upload Resume" populated three
jobs, two degrees and a skills matrix from the PDF - and blanked Country, Address, City and
Postcode, which the read-back had already confirmed. So for an upload that PARSES, fill after
attaching, not before; for a plain document upload the old order still holds, because
attaching swaps the input and detaches sibling handles. `--auto` attaches between the fill and
the read-back, which covers the second case; a parser upload needs a second `fill` after it.

**"Location" inside a Work Experience row is the employer's, not the candidate's.** The
`location` matcher wrote his home city against all three employers - wrong data on a live
application, which is worse than a blank. `scan()` now refuses `location`/`city`/`country`/
`address` when the control's name marks it as part of an experience or education entry.

`x` (submit) refuses while any field is `mismatch`, `empty_required` or `collapsed`. `--force` overrides
it, for the forms that are wrong about what they require.

## How a real ATS application goes

Most graduate employers (Workday, SAP SuccessFactors, Taleo, Oracle) put an account wall in
front of a 5-8 page wizard. So `autofill.mjs` is a **session**, not a one-shot:

`--auto` fills and attaches immediately on open, which is the normal case for a
single-page ATS (Greenhouse, Lever, Ashby). The interactive commands are for account walls
and multi-page wizards.

1. It opens the posting in a persistent browser profile and then waits.
2. On the sign-in wall: `l` signs in with the stored account, or `n` registers a new one -
   generating a password, saving it to the vault *before* submitting, and filling the rest
   of the registration form. Arion does the terms checkbox, any captcha, and the button.
3. Registration usually triggers a verification email. Ask Claude to find it in Gmail.
4. On each wizard page: `f` fills it, `u` attaches CV and cover letter, he checks it and
   clicks Next.
5. Consent checkboxes, captchas and the final submit stay his.

Because the profile persists, the second application to the same ATS starts already signed
in. Use `--profile <name>` for a separate profile, `--fresh` semantics do not exist - delete
the profile directory if a session goes bad.
