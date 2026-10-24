#!/usr/bin/env node
/**
 * autofill.mjs - an assisted browser session for company application forms.
 *
 * Not a robot that applies for you. A browser you drive, that fills the boring
 * fields on command. It handles login walls and multi-page wizards by doing
 * nothing until you tell it to.
 *
 *   f / Enter  fill the page that is currently on screen
 *   r          report what is on this page, fill nothing
 *   s          show the answer sheet (for fields it cannot reach)
 *   u          attach the CV and cover letter
 *   x          click submit (only with --submit)
 *   q          finish and close
 *
 * Hard rules, enforced in code:
 *   - never navigates to linkedin.com
 *   - only ever types a password during an explicit l (sign in) or n (register);
 *     the f (fill) pass skips password fields unconditionally
 *   - never clicks submit or next unless you pass --submit
 *   - never solves a captcha
 *
 * Usage: node autofill.mjs <slug> [--url URL] [--profile <name>] [--fresh]
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const slug = argv.find(a => !a.startsWith('--') && !isFlagValue(a));
function isFlagValue(a) {
  const i = argv.indexOf(a);
  return i > 0 && ['--url', '--profile'].includes(argv[i - 1]);
}
const flag = n => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
const has = n => argv.includes(`--${n}`);

if (!slug) { console.error('usage: autofill.mjs <slug> [--url URL] [--profile name]'); process.exit(1); }

const db = JSON.parse(readFileSync(join(ROOT, 'applications.json'), 'utf8'));
const rec = db[slug];
if (!rec) { console.error(`unknown slug ${slug} - try: bin/jobhunt list --all`); process.exit(1); }

const answersPath = join(rec.dir, 'answers.json');
if (!existsSync(answersPath)) {
  console.error(`no ${answersPath}\nRun /job-apply first - it writes the answer sheet.`);
  process.exit(1);
}
const answers = JSON.parse(readFileSync(answersPath, 'utf8'));
const url = flag('url') || rec.url;
if (!url) { console.error('no URL on the record; pass --url'); process.exit(1); }

const LINKEDIN = /(^|\.)linkedin\.com$/i;
if (LINKEDIN.test(new URL(url).hostname)) {
  console.error('Refusing to drive linkedin.com - it breaks their ToS and risks the account.\n' +
                'Do Easy Apply by hand; answers.md is there to copy from.');
  process.exit(2);
}

/* ------------------------------------------------------------------ profile */
// One persistent browser profile, so an ATS account you log into once stays
// logged in for every later application to that same ATS.
const profileName = flag('profile') || 'default';
const userDataDir = join(ROOT, '.browser', profileName);
mkdirSync(userDataDir, { recursive: true });

/* ----------------------------------------------------------------- matchers */
const MATCHERS = [
  // Specific question-legends first: the broad `location` and `department`
  // regexes below otherwise swallow "Location Availability" and "which role
  // classification", leaving those groups unanswered.
  ['onsite_availability', /location availability|work onsite|work on-site|onsite on a regular|based at our|able and willing to work/i],
  ['role_track',   /role classification|graduate engineer *\/ *summer internship/i],
  // combined name fields must beat the first/last matchers below
  ['full_name',    /name *[&+\/] *surname|name and surname|full name|^name$/i],
  // Ashby labels the one combined name box "NAME" and names the input
  // `_systemfield_name`, which no first/last/full regex below reaches - it came
  // back unrecognised on a Greenhouse form (2026-10-05).
  ['full_name',    /_systemfield_name/i],
  ['first_name',   /\b(first|given|fore)[\s_-]*name|^fname/i],
  ['last_name',    /\b(last|family|sur)[\s_-]*name|^lname/i],
  ['full_name',    /\b(full|preferred|display)[\s_-]*name\b|^name$/i],
  ['email',        /e-?mail/i],
  ['phone',        /phone|mobile|telephone|contact number/i],
  ['postcode',     /post[\s_-]?code|zip/i],
  // These name a country while being about visas, so they must beat the plain
  // `country` matcher below or they get answered "United Kingdom".
  ['work_auth_indefinite', /indefinite (duration|period)|indefinitely.*sponsor|permanent right to work/i],
  ['sponsorship',  /require sponsorship|need sponsorship|sponsorship to work|require.*visa sponsor/i],
  ['right_to_work',/legally authori[sz]ed to work|valid work permit|right to work|eligible to work/i],
  ['country',      /\bcountry\b/i],
  ['address',      /street|address\s*(line\s*)?1\b|house (name|number)|^address\b/i],
  ['location',     /\b(city|town|location|where.*based)\b|current address|home address/i],
  // guard: a bare "Location" that belongs to an employment or education row is
  // the employer's location. Never the candidate's. Handled in scan(), not here.

  ['linkedin',     /linked\s?in/i],
  ['github',       /git\s?hub/i],
  ['portfolio',    /portfolio|personal (web)?site|website|blog/i],
  ['recent_graduate', /(are|as) you a recent grad|recent graduate with/i],
  ['grad_date',    /year of graduation|graduation (date|year)|date of graduation|expected graduat|completion date|course end date/i],
  ['start_school', /start date.*(school|universit|educat)|educat.*start/i],
  ['university_course', /university course|course (name|title|studied)|course of study|degree (course|subject|title)|what (course|subject) (are|did) you/i],
  ['degree_type',  /degree type|type of degree|level of degree/i],
  ['university',   /university|institution|school|college/i],
  ['grade',        /grade|classification|gpa|\bresult/i],
  ['degree',       /degree|qualification|course|programme|major|subject/i],
  // "...for an INDEFINITE duration without sponsorship" is a different question
  // from "do you have the right to work now", and must be matched first. On a
  // time-limited visa the honest answer to this one is No.
  ['work_auth_indefinite', /indefinite (duration|period)|indefinitely.*sponsor|permanent right to work/i],
  ['right_to_work',/right to work|work authoris|work authoriz|eligible to work|legally (able|entitled)|authorised to work/i],
  ['sponsorship',  /sponsor/i],
  ['defence_sector_comfortable', /defen[cs]e sector|defen[cs]e[- ]related|related to defen/i],
  ['onsite_interview_date', /onsite interview availability|available on this date|interview day/i],
  ['video_interview_availability', /video interview availability|stage video interview|dates?\/times? for which you are available/i],
  ['gender',       /^gender\b|\bgender\b/i],
  ['notice',       /notice period/i],
  ['start_date',   /start date|available from|earliest start|availability/i],
  ['salary',       /salary|compensation|remuneration|expected pay|package/i],
  ['how_heard',    /how did you (hear|find)|source|referral source|where did you/i],
  ['relocate',     /relocat|willing to move/i],
  ['commute',      /commut|happy to travel to|able to travel to.*office|on-?site.*days/i],
  ['pronouns',     /pronoun/i],
  ['birth_date',   /birth ?date|date of birth|\bdob\b/i],
  ['education_status', /educational status|education level|highest (level of )?education|level of study/i],
  ['product_user', /are you (a|an) .{0,24}user|do you (already )?use (our|the) (product|platform|app)/i],
  ['department',   /department|which (team|role|position)|position applied/i],
  ['experience',   /^experience|your experience|work experience|tell us about your experience/i],
  ['why_company',  /why.{0,40}\b(work|join|appl)|why (this|our) (company|role)|why will you excel|motivat/i],
  // "What do you think X is, what does it do and why is it important?" - a
  // what-we-do question, distinct from why-you-want-to-work-here
  ['about_company', /what do you (think|know)|what does (it|the company|our product|this company) do|in your (own )?words.*(company|product)|why is it important/i],
  ['cover_letter', /cover letter|supporting statement|personal statement|additional information/i],
];

/* ---------------------------------------------------------------- speed knobs */
// One user, one machine, so these are tuned for wall-clock rather than for the
// most defensive timing imaginable. --careful restores the generous waits the
// first version used, for an ATS that turns out to need them.
const CAREFUL = has('careful');
const T = CAREFUL
  ? { boot: 9000, settle: 900, afterOpen: 1200, scrollStep: 140, scrollers: 6, tick: 100, pick: 500, group: 450 }
  : { boot: 7000, settle: 250, afterOpen: 500,  scrollStep: 55,  scrollers: 3, tick: 30,  pick: 300, group: 260 };

const TIMING = has('time') || !!process.env.JOBHUNT_TIME;
const marks = [];
async function timed(name, fn) {
  const t0 = Date.now();
  try { return await fn(); }
  finally {
    const ms = Date.now() - t0;
    marks.push([name, ms]);
    if (TIMING) console.log(`   [${String(ms).padStart(5)}ms] ${name}`);
  }
}
function timingReport() {
  if (!TIMING || !marks.length) return;
  const total = marks.reduce((a, [, ms]) => a + ms, 0);
  console.log(`\nTIMING (${(total / 1000).toFixed(1)}s accounted)`);
  for (const [n, ms] of marks.sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${String(ms).padStart(6)}ms  ${n}`);
  }
}

// The old boot wait was a flat 4s sized for the slowest hydration ever seen.
// Waiting for controls to actually exist keeps that safety on a slow ATS and
// gives the time back on a fast one.
async function formReady(maxMs = T.boot) {
  const t0 = Date.now();
  let last = -1;
  for (;;) {
    let n = 0;
    for (const f of frames()) {
      n += await f.locator('input:not([type=hidden]), textarea, select, [role=combobox]')
                  .count().catch(() => 0);
    }
    // stable count two polls running = hydration has settled
    if (n >= 2 && n === last) { await page.waitForTimeout(T.settle); return true; }
    last = n;
    if (Date.now() - t0 > maxMs) { await page.waitForTimeout(T.settle); return n > 0; }
    await page.waitForTimeout(220);
  }
}

/* -------------------------------------------------------------------- setup */
console.log(`profile: ${userDataDir}`);
// Prefer real Google Chrome over Playwright's bundled "Chrome for Testing":
// a normal UI, and a browser fingerprint that looks like an ordinary visitor
// rather than an automation build. Falls back silently if Chrome is absent.
function chromeChannel() {
  if (has('bundled')) return undefined;
  const wanted = flag('channel');
  if (wanted) return wanted;
  for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium']) {
    const r = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return bin.startsWith('chromium') ? 'chromium' : 'chrome';
  }
  return undefined;
}
const channel = chromeChannel();
console.log(channel ? `browser: ${channel}` : 'browser: bundled Chrome for Testing');
// A headless context cannot be made visible later, so instead the window opens
// off-screen and is moved on-screen once the form is filled. Default for --auto;
// --show opts out.
const quiet = !has('show') && (has('auto') || has('quiet'));
// A profile already in use fails deep inside Playwright and prints a 40-line stack
// dump ending in "Opening in existing browser session" - which reads like a crash and
// buries the one fact that matters: another session of this tool is still holding the
// browser. It happens every time a --hold session is left running.
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    channel,
    args: quiet
      ? ['--window-position=-4000,-4000', '--window-size=1400,1000']
      : ['--start-maximized'],
  });
} catch (e) {
  if (/existing browser session|ProcessSingleton|SingletonLock/i.test(e.message)) {
    console.log(`\nAnother session is already using the browser profile ${userDataDir}.`);
    console.log(`A --hold session left running holds it until its timer runs out.\n`);
    console.log(`  pgrep -af autofill.mjs            # find it`);
    console.log(`  echo quit >> <slug>/.session-cmd  # ask it to close politely`);
    console.log(`  pkill -f autofill.mjs             # or end it`);
    console.log(`\nOr start this one on its own profile:  --profile <name>`);
    console.log(`(a separate profile does not share ATS logins with the default one)`);
    process.exit(1);
  }
  throw e;
}
const page = ctx.pages()[0] || await ctx.newPage();

// A form that refuses to advance and says nothing on screen is usually saying
// plenty over the wire. Workday's Create Account is the case that prompted this:
// no banner, no aria-invalid, nothing in the DOM - so watch what the page sends
// and what comes back instead of only what it renders.
const netLog = [];
const conLog = [];
const NET_KEEP = 120;
const push = (arr, v) => { arr.push(v); if (arr.length > NET_KEEP) arr.shift(); };
page.on('console', m => {
  if (!/error|warning/i.test(m.type())) return;
  push(conLog, `[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', e => push(conLog, `[pageerror] ${String(e.message).slice(0, 300)}`));
page.on('requestfailed', r => push(netLog, {
  when: new Date().toISOString().slice(11, 19),
  status: 'FAILED', method: r.method(), url: r.url().slice(0, 160),
  body: (r.failure() && r.failure().errorText) || '',
}));
page.on('response', async r => {
  const st = r.status();
  const req = r.request();
  // Every non-2xx, plus every POST/PUT whatever it returned - the interesting
  // case is a 200 whose JSON body carries the refusal.
  const interesting = st >= 300 || req.method() !== 'GET';
  if (!interesting) return;
  let body = '';
  try {
    const ct = (r.headers()['content-type'] || '');
    if (/json|text/i.test(ct)) body = (await r.text()).slice(0, 600);
  } catch {}
  push(netLog, { when: new Date().toISOString().slice(11, 19), status: st,
                 method: req.method(), url: r.url().slice(0, 160), body });
});

// Belt and braces: block any navigation to linkedin.com for the whole session.
await ctx.route('**/*', route => {
  try {
    if (LINKEDIN.test(new URL(route.request().url()).hostname)) return route.abort();
  } catch { /* ignore */ }
  return route.continue();
});

async function showWindow() {
  if (!quiet) return;
  try {
    const cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds',
      { windowId, bounds: { left: 0, top: 0, width: 1400, height: 1000, windowState: 'normal' } });
    await cdp.detach().catch(() => {});
  } catch (e) {
    console.log(`(could not move the window on-screen: ${e.message.split('\n')[0]})`);
  }
  await page.bringToFront().catch(() => {});
}

if (quiet) console.log('filling off-screen - the window appears when it is ready\n');
console.log(`opening ${url}\n`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Greenhouse/Ashby/Workday hydrate the form after load; without this the first
// scan can miss fields that are not in the DOM yet.
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
await timed('hydrate', () => formReady());
await timed('banners', () => dismissBanners().catch(() => {}));
await timed('open form', () => openApplicationForm().catch(() => {}));
await page.waitForTimeout(T.afterOpen);

/* ------------------------------------------------------------------ helpers */

// Debug probe: print one dropdown's committed text at a named checkpoint.
async function dbgTrig(tag) {
  if (!process.env.JOBHUNT_DEBUG) return;
  try {
    const t = await page.evaluate(() => {
      const fs = [...document.querySelectorAll('fieldset')]
        .find(f => /^University:/.test((f.querySelector('legend') || {}).innerText || ''));
      if (!fs) return '(no fieldset)';
      const b = fs.querySelector('[data-common--dropdown-target=button]');
      const h = fs.querySelector('input[data-common--dropdown-target=hiddenInput]');
      return JSON.stringify({ trigger: (b ? b.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 40), hidden: h ? h.value : null });
    });
    console.log(`   [dbg ${tag}] ${t}`);
  } catch {}
}


// Read the form back after filling, and compare it to what was PUT IN.
//
// Two lessons are baked in here. From Teamtailor: a widget can report a
// successful fill while the visible control still says "Select an option",
// because the value went into a hidden input the UI ignores - only a read-back
// tells the truth. From everything since: a read-back that only asks "is this
// non-empty" still passes on every silent-corruption bug there is, because
// "+44 +44 7700..." is non-empty and so is a date box that quietly dropped
// "Available immediately". So the question is whether the page agrees with the
// intent, field by field.
function printReadback(a) {
  const rows = a.fields.filter(f => f.status !== 'human_only' && f.status !== 'trap');
  if (!rows.length) return a;
  {
    const c = a.counts;
    console.log(`\nREAD-BACK - ${c.ok} confirmed of ${c.questions_on_page} questions on this page`);
    const MARK = { ok: 'ok   ', mismatch: 'WRONG', empty_required: 'EMPTY', no_answer: 'ASKS ',
                   unrecognised: 'NEW  ', ghost: 'HIDDEN' };
    for (const f of rows.sort((x, y) => (x.status === 'ok') - (y.status === 'ok'))) {
      const m = MARK[f.status] || f.status;
      const val = f.status === 'mismatch'
        ? (f.intended == null ? f.note.slice(0, 70)
           : `wanted "${String(f.intended).slice(0, 30)}" / page shows "${String(f.readback ?? '').slice(0, 30)}"`)
        : (f.readback ? '= ' + String(f.readback).slice(0, 44) : '');
      console.log(`   ${m} ${f.required ? '*' : ' '}${f.label.slice(0, 52)}${val ? '  ' + val : ''}`);
    }
  }
  return a;
}

// Anything the read-back could not confirm, reported as a decision rather than as
// an absence: what is wrong, what is missing, what is being asked that the scanner
// cannot even see. The counts are the headline because the failure that cost a real
// application was a report of "7 filled" on a form that had 15 questions.
function blockerReport(a) {
  const c = a.counts;
  console.log(`\nSTATUS  ${c.ok} confirmed | ${c.mismatch} not taken | ${c.empty_required} required-empty`
    + ` | ${c.no_answer} unanswered | ${c.unrecognised} new | ${c.ghost} hidden`
    + ` | ${c.collapsed} folded | ${c.human_only} yours`
    + (c.trap ? ` | ${c.trap} bot-trap skipped` : ''));
  if (!a.blockers.length) { console.log('   nothing outstanding that the tool can see.'); return; }
  console.log(`\nNEEDS A DECISION (${a.blockers.length}) - in ${STATE.replace(ROOT + '/', '')}`);
  for (const f of a.blockers) {
    console.log(`   [${f.status}] ${f.required ? '* ' : ''}${f.label.slice(0, 74)}`);
    console.log(`      ${f.note}`);
  }
}

// Cookie / GDPR banners sit in an overlay that swallows the first click on any
// field under it, so the fill pass silently does nothing. Dismiss it before
// touching the form. Accepts only the cookie prompt - never a terms attestation,
// which tickConsent handles explicitly during a fill.
async function dismissBanners() {
  for (let round = 0; round < 2; round++) {
    let clicked = false;
    for (const f of frames()) {
      const hit = await f.evaluate(() => {
        const LABELS = /^(accept( all)?( cookies)?|allow all|i accept|agree|got it|ok|understood|continue|close)$/i;
        // Workday's cookie bar carries no cookie/consent class or id anywhere in its
        // ancestry - it is styled entirely by hashed emotion classes (css-45fqo2). The
        // class test alone therefore never fired on it, the bar stayed up, and it sat
        // over the Create Account button so every click timed out with no explanation.
        // So: recognise the banner by what it SAYS as well as by what it is called.
        const BANNER_TEXT = /uses? cookies|cookie policy|we use cookies|your privacy|consent to (the use of )?cookies/i;
        for (const b of document.querySelectorAll('button, a[role=button], [role=button]')) {
          const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 30 || !LABELS.test(t)) continue;
          // only inside something that actually looks like a consent banner - never
          // a terms attestation, which tickConsent handles as its own explicit step
          const byClass = b.closest('[class*=cookie],[id*=cookie],[class*=consent],[id*=consent],[class*=gdpr],[aria-label*=ookie]');
          let byText = null;
          for (let n = b.parentElement, hops = 0; n && hops < 6; n = n.parentElement, hops++) {
            const txt = (n.innerText || '').replace(/\s+/g, ' ').trim();
            if (txt.length < 400 && BANNER_TEXT.test(txt)) { byText = n; break; }
          }
          if (!byClass && !byText) continue;
          b.setAttribute('data-jh-banner', '1');
          return t;
        }
        return null;
      }).catch(() => null);
      if (!hit) continue;
      await f.locator('[data-jh-banner]').first().click({ timeout: 2500 }).catch(() => {});
      await f.evaluate(() => document.querySelectorAll('[data-jh-banner]')
                                     .forEach(n => n.removeAttribute('data-jh-banner'))).catch(() => {});
      console.log(`   dismissed banner: "${hit}"`);
      clicked = true;
      await page.waitForTimeout(600);
    }
    if (!clicked) break;
  }
}

// Teamtailor and several other ATS keep the application form collapsed behind an
// "Apply for this job" button on the same page, so a scan before the click finds
// nothing to fill.
async function openApplicationForm() {
  for (const f of frames()) {
    // Match on the VISIBLE TEXT of any element, not on `a, button`. UKG Pro
    // Recruiting renders its apply control as <ukg-button>, a custom element, and
    // a selector list of real tag names walks straight past it - which looks
    // identical to "this posting has no form".
    const hit = await f.evaluate(() => {
      const WANT = /^(apply for this job|apply now|apply online|apply)$/i;
      // already on the form?
      if (document.querySelector('input[name*="candidate" i], input[name*="first_name" i], input[type=file]')) return 'already';
      let best = null;
      for (const n of document.querySelectorAll('*')) {
        const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
        if (!WANT.test(t)) continue;
        const r = n.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        // innermost wins: the wrappers around the button all carry its text
        if (!best || n.contains(best) === false) best = n;
        if (best && best.contains(n)) best = n;
      }
      if (!best) return null;
      best.setAttribute('data-jh-apply', '1');
      return (best.innerText || '').replace(/\s+/g, ' ').trim();
    }).catch(() => null);
    if (!hit) continue;
    if (hit === 'already') return;
    const before = page.url();
    await f.locator('[data-jh-apply]').first().click({ timeout: 6000 }).catch(() => {});
    await f.evaluate(() => document.querySelectorAll('[data-jh-apply]')
                                   .forEach(n => n.removeAttribute('data-jh-apply'))).catch(() => {});
    console.log(`   clicked "${hit}"`);
    // The click may navigate, or may expand the form in place - wait for whichever
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await formReady(6000);
    if (page.url() !== before) console.log(`   -> ${page.url().slice(0, 100)}`);
    return;
  }
}

// --- choice groups -----------------------------------------------------------
// Teamtailor (and most modern ATS skins) render every question as a <fieldset>
// whose <legend> carries the question and whose options are radios, checkboxes,
// or a custom dropdown. The per-control loop below cannot answer these: an
// individual radio's label is just "Yes", so the question it belongs to is only
// knowable from the legend. Handle the group as a unit, then tell the control
// loop to leave its inputs alone.
//
// `answers.json` value semantics:
//   "Yes" / "2:1" / "Other"   click the option whose label matches
//   "ALL"                     tick every option (multi-select availability grids)
//   comma-separated list      tick each named option
async function fillChoiceGroups(f, R, fill, answered, only = null) {
  const handledNames = new Set();
  let groups;
  try { groups = await f.locator('fieldset').all(); } catch { return handledNames; }

  for (const fs of groups) {
    let legend = '';
    try {
      legend = (await fs.locator('legend').first().innerText({ timeout: 1500 })) || '';
    } catch { continue; }
    legend = legend.replace(/\s+/g, ' ').replace(/\*|Required/g, '').trim();
    if (!legend) continue;
    if (only && !only.has(norm(legend))) continue;   // repair pass: this question only

    // Same ladder as the per-control pass. A screening question is usually a
    // radio group, so the bank has to reach these or it never learns the ones
    // that actually need judgement.
    const gbm = bankMatch(legend);
    const known = MATCHERS.find(([, re]) => re.test(legend));
    let key = null, val = null;
    if (gbm && gbm.score >= BANK_NEAR) { key = known ? known[0] : 'q:' + norm(legend).split(' ').slice(0, 3).join('-'); val = gbm.entry.a; }
    else if (known && answers[known[0]] != null) { key = known[0]; val = answers[known[0]]; }
    else if (gbm) { key = known ? known[0] : 'q:' + norm(legend).split(' ').slice(0, 3).join('-'); val = gbm.entry.a; }
    else if (known) { R.noAnswer.push(`"${known[0]}" wanted by: ${legend.slice(0, 70)}`); R.noAnswerKeys.add(norm(legend)); continue; }
    else { R.unknownLabels.add(norm(legend)); continue; }
    val = String(val);
    const gwon = chose => {
      R.intent.push({ key, label: legend, text: legend, value: chose || val, group: true });
      answered.add(key);
    };

    const boxes = await fs.locator('input[type=radio], input[type=checkbox]').all().catch(() => []);
    const names = [];
    for (const b of boxes) { const n = await b.getAttribute('name').catch(() => null); if (n) names.push(n); }
    for (const h of await fs.locator('input[data-common--dropdown-target=hiddenInput]').all().catch(() => [])) {
      const n = await h.getAttribute('name').catch(() => null); if (n) names.push(n);
    }

    if (!fill) { R.filled.push(`${key} -> ${legend.slice(0, 60)}  [choice group]`); names.forEach(n => handledNames.add(n)); continue; }

    // A custom dropdown renders its options only after the trigger is clicked,
    // so route it through pickOption rather than clicking labels.
    // Teamtailor's own dropdown: trigger button + searchInput + menuItem buttons.
    const ttTrigger = fs.locator('[data-common--dropdown-target=button]').first();
    if (await ttTrigger.count().catch(() => 0)) {
      const wantAll = val.toUpperCase() === 'ALL';
      let picks = wantAll
        ? (await fs.locator('[data-common--dropdown-target=menuItem]')
             .evaluateAll(ns => ns.map(n => (n.textContent || '').replace(/\s+/g, ' ').trim()))
             .catch(() => [])).filter(Boolean)
        : val.split(/\s*,\s*/);
      if (!fill) { R.filled.push(`${key} -> ${legend.slice(0, 50)}  [teamtailor dropdown]`); names.forEach(n => handledNames.add(n)); continue; }

      const done = [];
      for (const want of picks) {
        const cur = ((await ttTrigger.textContent().catch(() => '')) || '').replace(/\s+/g, ' ');
        if (norm(cur).includes(norm(want))) { done.push(want); continue; }   // already set
        await ttTrigger.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        const open = await fs.locator('[data-common--dropdown-target=menuItem]:visible').count().catch(() => 0);
        if (!open) { await ttTrigger.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(T.group); }
        const search = fs.locator('[data-common--dropdown-target=searchInput]').first();
        if (await search.count().catch(() => 0)) {
          await search.fill('').catch(() => {});
          await search.type(want.slice(0, 18), { delay: 40 }).catch(() => {});
          await page.waitForTimeout(500);
        }
        const items = await fs.locator('[data-common--dropdown-target=menuItem]:visible').all().catch(() => []);
        let hitOne = null;
        for (const it of items) {
          const t = ((await it.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          if (norm(t) === norm(want) || norm(t).startsWith(norm(want)) || norm(want).startsWith(norm(t))) {
            // Do NOT swallow this: a detached-handle or intercepted click here is
            // the whole diagnosis, and silently catching it reports a false success.
            try {
              await it.click({ timeout: 3000 });
            } catch (e) {
              R.skipped.push(`${key}: click on "${t}" failed - ${e.message.split('\n')[0].slice(0, 110)}`);
              break;
            }
            hitOne = t; break;
          }
        }
        // Confirm against the trigger rather than trusting the click: a synthetic
        // click on a Stimulus widget can land without the controller acting on it.
        if (hitOne) {
          await page.waitForTimeout(350);
          const after = ((await ttTrigger.textContent().catch(() => '')) || '').replace(/\s+/g, ' ');
          if (norm(after).includes(norm(hitOne))) { done.push(hitOne); continue; }
        }
        // Keyboard fallback: type in the search box and select with the arrow keys,
        // which drives the controller through its own key handlers.
        const stillOpen = await fs.locator('[data-common--dropdown-target=menuItem]:visible').count().catch(() => 0);
        if (!stillOpen) { await ttTrigger.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400); }
        const sb = fs.locator('[data-common--dropdown-target=searchInput]').first();
        if (await sb.count().catch(() => 0)) {
          await sb.click({ timeout: 2000 }).catch(() => {});
          await sb.fill('').catch(() => {});
          await sb.type(want.slice(0, 18), { delay: 55 }).catch(() => {});
          await page.waitForTimeout(650);
        }
        await page.keyboard.press('ArrowDown').catch(() => {});
        await page.waitForTimeout(200);
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(500);
        const after2 = ((await ttTrigger.textContent().catch(() => '')) || '').replace(/\s+/g, ' ');
        if (norm(after2).includes(norm(want))) done.push(want);
      }
      if (await fs.locator('[data-common--dropdown-target=menuItem]:visible').count().catch(() => 0)) {
        await ttTrigger.click({ timeout: 2500 }).catch(() => {});
      }
      if (done.length) {
        R.filled.push(`${key} -> ${legend.slice(0, 45)}  [chose ${done.length > 3 ? done.length + ' options' : '"' + done.join('", "') + '"'}]`);
        gwon(done.join(', ')); names.forEach(n => handledNames.add(n));
      } else {
        R.skipped.push(`${key}: no option matching "${val}" in ${legend.slice(0, 45)} - choose it yourself`);
      }
      continue;
    }

    const isDropdown = await fs.locator('[data-forms--inputs--choice-show-as-dropdown-value="true"]').count().catch(() => 0);
    if (isDropdown) {
      const trigger = fs.locator('button, [role=combobox], [aria-haspopup]').first();
      await trigger.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      // "ALL" means every option in this group. The labels are in the DOM even
      // while the dropdown is shut, so read them first and then pick each one
      // through pickOption - the one open-and-click path known to work here.
      let wanted = val.toUpperCase() === 'ALL' ? null : val.split(/\s*,\s*/);
      if (wanted === null) {
        // innerText is '' for a hidden element, and these labels stay hidden until
        // the dropdown opens - so read textContent, which is populated either way.
        const labs = await fs.locator('label').evaluateAll(
          ns => ns.map(n => n.textContent || '')).catch(() => []);
        const seen = new Set();
        wanted = labs.map(t => (t || '').replace(/\s+/g, ' ').trim())
                     .filter(t => t && t.length < 80 && !/^select (an|one)/i.test(t))
                     .filter(t => !seen.has(t) && seen.add(t));
        if (!wanted.length) wanted = null;
      }
      let done = [];
      if (wanted) {
        for (const w of wanted) {
          const got = await pickOption(f, trigger, w).catch(() => null);
          if (got) done.push(got);
          await page.waitForTimeout(400);
        }
      } else {
        // tick-everything case: open once and click every option in the list
        await trigger.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(600);
        const opts = await f.locator(OPTION_SELECTOR).all().catch(() => []);
        for (const o of opts) {
          const t = ((await o.innerText().catch(() => '')) || '').trim();
          if (!t) continue;
          await o.click({ timeout: 2500 }).catch(() => {});
          done.push(t);
          await page.waitForTimeout(180);
        }
        await page.keyboard.press('Escape').catch(() => {});
      }
      if (done.length) {
        R.filled.push(`${key} -> ${legend.slice(0, 50)}  [chose ${done.length > 3 ? done.length + ' options' : '"' + done.join('", "') + '"'}]`);
        gwon(done.join(', ')); names.forEach(n => handledNames.add(n));
      } else {
        R.skipped.push(`${key}: no option matching "${val}" in ${legend.slice(0, 50)} - choose it yourself`);
      }
      continue;
    }

    // plain radios / checkboxes: click the label whose text matches
    const wanted = val.toUpperCase() === 'ALL' ? null : val.split(/\s*,\s*/).map(norm);
    let hit = [];
    for (const b of boxes) {
      let t = '';
      try {
        const id = await b.getAttribute('id');
        if (id) t = await f.locator(`label[for="${CSS_ESC(id)}"]`).first().innerText({ timeout: 1200 }).catch(() => '');
        if (!t) t = await b.evaluate(n => (n.closest('label')?.innerText || '')).catch(() => '');
      } catch {}
      t = (t || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const match = wanted === null || wanted.some(w => norm(t) === w || norm(t).startsWith(w) || w.startsWith(norm(t)));
      if (!match) continue;
      const already = await b.isChecked().catch(() => false);
      if (!already) {
        await b.click({ timeout: 2500, force: true }).catch(async () => {
          const id = await b.getAttribute('id').catch(() => null);
          if (id) await f.locator(`label[for="${CSS_ESC(id)}"]`).first().click({ timeout: 2500 }).catch(() => {});
        });
        await page.waitForTimeout(160);
      }
      hit.push(t);
      if (wanted !== null && wanted.length === 1) break;   // single-answer group
    }
    if (hit.length) {
      R.filled.push(`${key} -> ${legend.slice(0, 50)}  [chose ${hit.length > 3 ? hit.length + ' options' : '"' + hit.join('", "') + '"'}]`);
      gwon(hit.join(', ')); names.forEach(n => handledNames.add(n));
    } else {
      R.skipped.push(`${key}: no option matching "${val}" in ${legend.slice(0, 50)} - choose it yourself`);
    }
  }
  return handledNames;
}

// Consent / terms / privacy ticks. Legally an attestation, so this only ever runs
// during an explicit fill, and submit remains a separate opt-in flag.
async function tickConsent(f, R, fill) {
  const boxes = await f.locator('input[type=checkbox]').all().catch(() => []);
  for (const b of boxes) {
    let t = '';
    try {
      const id = await b.getAttribute('id');
      const nm = (await b.getAttribute('name').catch(() => '')) || '';
      if (id) t = await f.locator(`label[for="${CSS_ESC(id)}"]`).first().innerText({ timeout: 1200 }).catch(() => '');
      if (!t) t = await b.evaluate(n => (n.closest('label')?.innerText || '')).catch(() => '');
      t = ((t || '') + ' ' + nm).replace(/\s+/g, ' ').trim();
    } catch { continue; }
    if (!/privacy policy|terms|i agree|i consent|consent_given|store my personal/i.test(t)) continue;
    if (await b.isChecked().catch(() => false)) continue;
    if (!fill) { R.filled.push(`consent -> ${t.slice(0, 60)}`); continue; }
    await b.click({ timeout: 2500, force: true }).catch(async () => {
      const id = await b.getAttribute('id').catch(() => null);
      if (id) await f.locator(`label[for="${CSS_ESC(id)}"]`).first().click({ timeout: 2500 }).catch(() => {});
    });
    R.filled.push(`consent ticked -> ${t.slice(0, 55)}`);
  }
}

// Application wizards often live in an iframe (Workday, some SuccessFactors skins).
function frames() {
  return [page, ...page.frames().filter(f => f !== page.mainFrame())];
}

async function describe(el) {
  return await el.evaluate(node => {
    const bits = [node.getAttribute('name'), node.getAttribute('id'),
                  node.getAttribute('placeholder'), node.getAttribute('aria-label')];
    let lab = null;
    if (node.id) {
      const l = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (l) lab = l.innerText;
    }
    if (!lab && node.closest('label')) lab = node.closest('label').innerText;
    if (!lab) {
      const w = node.closest('div,fieldset,li,td,tr');
      const l = w && w.querySelector('label,legend');
      if (l) lab = l.innerText;
    }
    if (!lab && node.getAttribute('aria-labelledby')) {
      const l = document.getElementById(node.getAttribute('aria-labelledby'));
      if (l) lab = l.innerText;
    }
    if (!lab) {
      // label as a preceding sibling of the input, or of its wrapper - common in
      // older ATS markup that never wired up for= or aria-labelledby
      for (let n = node; n && !lab; n = n.parentElement) {
        for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
          const t = (p.innerText || p.textContent || '').trim();
          if (p.tagName === 'LABEL' && t) { lab = t; break; }
          if (t && t.length < 120 && !p.querySelector('input,select,textarea')) { lab = t; break; }
          if (p.querySelector && p.querySelector('input,select,textarea')) break;
        }
        if (n.tagName === 'FORM' || n.tagName === 'BODY') break;
      }
    }
    bits.push(lab);
    return {
      text: bits.filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 220),
      tag: node.tagName.toLowerCase(),
      type: (node.getAttribute('type') || '').toLowerCase(),
      value: node.tagName === 'DIV' ? (node.innerText || '').trim()
        : node.tagName === 'BUTTON'
        ? (/^(select|choose|please select|-+)$/i.test((node.innerText || '').trim()) ? '' : (node.innerText || '').trim())
        : (node.value || ''),
      role: node.getAttribute('role') || '',
      hasPopup: !!node.getAttribute('aria-haspopup') || node.getAttribute('aria-autocomplete') === 'list',
      required: node.required || node.getAttribute('aria-required') === 'true',
    };
  });
}

async function looksLikeLogin() {
  for (const f of frames()) {
    const pw = await f.locator('input[type=password]').count().catch(() => 0);
    if (pw > 0) return true;
  }
  return false;
}

const label = info => info.text.split('|').pop().trim();

// Click-to-edit fields (Retable's phone/email/url cells) render as a static
// container; clicking swaps in a real input, which is what actually gets filled.
async function fillClickToEdit(f, el, val) {
  await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await el.click({ timeout: 5000 }).catch(async () => {
    await el.click({ timeout: 3000, force: true }).catch(() => {});
  });
  await page.waitForTimeout(500);
  let inp = el.locator('input, textarea').first();
  if (!await inp.count().catch(() => 0)) {
    const row = el.locator('xpath=ancestor::div[contains(@class,"retable-form-question")][1]');
    inp = row.locator('input, textarea').first();
  }
  if (!await inp.count().catch(() => 0)) inp = f.locator(':focus');
  try {
    await inp.fill(val, { timeout: 4000 });
    await page.keyboard.press('Tab').catch(() => {});   // commit the cell
    await page.waitForTimeout(250);
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ uploads */
const CV_DIR = join(ROOT, 'cv');
function cvFile() {
  const f = readdirSync(CV_DIR).filter(x => x.toLowerCase().endsWith('.pdf'));
  return f.length ? join(CV_DIR, f[0]) : null;
}
function coverFile() {
  const f = readdirSync(rec.dir).filter(x => /^Cover_.*\.docx$/i.test(x));
  return f.length ? join(rec.dir, f[0]) : null;
}

// Attach CV and cover letter to whichever file inputs want them. File inputs are
// often visually hidden behind a styled button, so setInputFiles is used rather
// than clicking - it does not require the element to be visible.
async function attach() {
  const cv = cvFile(), cover = coverFile();
  if (!cv) { console.log(`no PDF in ${CV_DIR}`); return; }
  const out = [];

  // Some forms only create the file input after an "Add new attachment" button
  // is pressed, so there is nothing to set files on until it is clicked.
  for (const f of frames()) {
    if (await f.locator('input[type=file]').count().catch(() => 0)) continue;
    const t = await f.evaluate(() => {
      for (const b of document.querySelectorAll('button, a, div[role=button]')) {
        const txt = (b.innerText || '').replace(/\s+/g, ' ').trim();
        if (!/add (new )?attachment|upload|attach (a )?file|add file/i.test(txt)) continue;
        b.setAttribute('data-jh-addfile', '1');
        return txt;
      }
      return null;
    }).catch(() => null);
    if (!t) continue;
    await f.locator('[data-jh-addfile]').first().click({ timeout: 4000 }).catch(() => {});
    await f.evaluate(() => document.querySelectorAll('[data-jh-addfile]')
                                   .forEach(n => n.removeAttribute('data-jh-addfile'))).catch(() => {});
    await page.waitForTimeout(1000);
    out.push(`clicked "${t}" to reveal the upload`);
  }

  for (const f of frames()) {
    // Plan every upload BEFORE performing any of them: attaching a file makes
    // the ATS swap the input for an "attached" widget, which shifts indexes and
    // detaches sibling handles. So describe first, then act by stable selector.
    const n = await f.locator('input[type=file]').count().catch(() => 0);
    const plan = [];
    for (let i = 0; i < n; i++) {
      const el = f.locator('input[type=file]').nth(i);
      let d;
      try { d = await describe(el); } catch { continue; }
      const t = d.text.toLowerCase();
      const isCover = /cover|supporting|letter|additional|other document/.test(t);
      const isCv = /resume|cv|curriculum/.test(t);
      let file = isCover ? cover : (isCv ? cv : null);
      // A single unlabelled upload ("Click to upload or drag and drop") is the CV.
      if (!file && n === 1) file = cv;
      const id = await el.getAttribute('id').catch(() => null);
      plan.push({ i, id, file, isCover, what: label(d) || t.slice(0, 40) });
    }

    for (const step of plan) {
      if (!step.file) {
        out.push(step.isCover ? `no cover letter built for ${rec.slug} - run: bin/jobhunt cover ${rec.slug}`
                              : `skipped (unclear what it wants): ${step.what}`);
        continue;
      }
      const el = step.id ? f.locator(`#${CSS_ESC(step.id)}`).first()
                         : f.locator('input[type=file]').nth(step.i);
      try {
        await el.setInputFiles(step.file, { timeout: 10000 });
        out.push(`${step.what} [${step.isCover ? 'cover' : 'CV'}] <- ${step.file.split('/').pop()}`);
        await page.waitForTimeout(1500);
      } catch (e) {
        out.push(`FAILED ${step.what}: ${e.message.split('\n')[0]}`);
      }
    }
  }
  console.log(out.length ? '\n' + out.map(x => '   ' + x).join('\n')
                         : '\nno file inputs on this page');
}

// CSS.escape is not available in node, and ATS ids are plain enough for this.
const CSS_ESC = id => id.replace(/([^\w-])/g, '\\$1');

// React comboboxes (Greenhouse, Ashby, Workday) look like text inputs but only
// register a value when an option in the popup listbox is clicked. Typing into
// them silently loses the answer, so open the list and pick.
const norm = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

// One list, used by both the single-pick and tick-everything paths - they drifted
// apart once and only one of them matched Teamtailor's markup.
const OPTION_SELECTOR =
  '[role=option]:visible, .dropdown-menu.show li:visible, ' +
  '.dropdown-menu.show .dropdown-item:visible, .dropdown-menu.show label:visible, ' +
  // Teamtailor renders options as plain <label>s inside the dropdown container
  '[data-controller~="common--dropdown"] label:visible, ' +
  '[role=listbox] label:visible, ul[class*=option] label:visible, ' +
  // Teamtailor: options are <button data-common--dropdown-target="menuItem">
  '[data-common--dropdown-target=menuItem]:visible';

async function pickOption(f, el, val) {
  // A trigger below the fold never receives the click, and the option list never
  // renders - the failure looks identical to "no matching option".
  await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await el.click({ timeout: 4000 });
  await page.waitForTimeout(500);
  const OPT_SEL = OPTION_SELECTOR;
  let opts = await f.locator(OPT_SEL).all();
  let probed = false;
  if (!opts.length) {
    await el.type(val.slice(0, 3), { delay: 60 }).catch(() => {});
    probed = true;
    await page.waitForTimeout(600);
    opts = await f.locator(OPT_SEL).all();
  }
  // Leaving the probe behind puts a 3-character fragment of the answer into a
  // field nobody will look at again. Clear it before giving up.
  const bail = async () => {
    if (probed) await el.fill('').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    return null;
  };
  if (!opts.length) return await bail();

  const texts = [];
  for (const o of opts) texts.push(((await o.innerText().catch(() => '')) || '').trim());
  const v = norm(val);
  const cands = texts.map(norm);

  let i = cands.findIndex(t => t && t === v);
  if (i === -1) i = cands.findIndex(t => t && (v.startsWith(t) || t.startsWith(v)));
  // "Yes - I hold a Graduate visa" against a plain Yes/No list
  if (i === -1 && /^(yes|no)\b/.test(v)) {
    const want = v.startsWith('yes') ? 'yes' : 'no';
    i = cands.findIndex(t => t === want);
  }
  if (i === -1) return await bail();

  await opts[i].click({ timeout: 4000 });
  await page.waitForTimeout(350);
  await page.keyboard.press('Escape').catch(() => {});   // close a multi-select menu
  await page.waitForTimeout(150);
  return texts[i];
}

/* ------------------------------------------------------------------- inspect */
// ONE round trip per frame, and the single source of truth for everything that
// follows: the fill pass, the read-back, the missing-field report.
//
// Why it exists: the old scan discovered fields with a Playwright locator list
// and then made four or five more round trips per field (isVisible, describe,
// getAttribute...). On a 24-field form that is ~150 calls, and worse, the filler
// was the ONLY witness to the form - a field its selectors did not match was not
// reported as missing, it was not reported at all. That is how the Retable form
// reported 7 filled out of a real 15.
//
// So this returns three things, gathered independently of each other:
//   controls  every interactive control, stamped with data-jh for later addressing
//   groups    every fieldset/legend question and what it currently reads back as
//   labels    every visible question label, and whether a control sits behind it
// A label with no control behind it is a GHOST: something is being asked and the
// automation cannot see the widget (click-to-edit cell, button-as-dropdown, an
// upload that appears after a click). A ghost is a positive signal; silence is not.
const INV_SEL = [
  'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset])',
  'textarea',
  'select',
  '[role=combobox]',
  'button.dropdown-toggle',
  'button.multiselect-button',
  'button[aria-haspopup=listbox]',
  'div[class*="link-container"][tabindex]',
  'div[class*="-cell"][tabindex][role]',
  // Rich-text cover-letter boxes (Greenhouse, Workday, Lever) are a contenteditable
  // div, not a textarea. Invisible to an input-only scan, so the longest and most
  // important answer on the form was the one field never filled.
  '[contenteditable="true"]',
  '[role=textbox][contenteditable]',
].join(', ');

async function inspect(f) {
  return await f.evaluate((SEL) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const seen = new WeakSet();
    window.__jh = 0;

    const visible = n => {
      const r = n.getBoundingClientRect();
      if (!r.width && !r.height) return false;
      const s = getComputedStyle(n);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.01;
    };

    // Same label-resolution ladder the old per-element describe() used, moved
    // in-page so it costs nothing per field.
    const labelFor = node => {
      let lab = null;
      if (node.id) {
        const l = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
        if (l) lab = l.innerText || l.textContent;
      }
      if (!lab && node.closest('label')) lab = node.closest('label').innerText;
      if (!lab) {
        const w = node.closest('div,fieldset,li,td,tr');
        const l = w && w.querySelector('label,legend');
        if (l) lab = l.innerText || l.textContent;
      }
      if (!lab && node.getAttribute('aria-labelledby')) {
        const l = document.getElementById(node.getAttribute('aria-labelledby'));
        if (l) lab = l.innerText || l.textContent;
      }
      if (!lab) {
        for (let n = node; n && !lab; n = n.parentElement) {
          for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
            const t = clean(p.innerText || p.textContent);
            if (p.tagName === 'LABEL' && t) { lab = t; break; }
            if (t && t.length < 120 && !p.querySelector('input,select,textarea')) { lab = t; break; }
            if (p.querySelector && p.querySelector('input,select,textarea')) break;
          }
          if (n.tagName === 'FORM' || n.tagName === 'BODY') break;
        }
      }
      return clean(lab);
    };

    // What the control currently HOLDS - the thing a read-back compares against.
    // Per widget, because a button dropdown's answer is its innerText and a
    // Teamtailor dropdown's answer is in an input the UI never shows.
    const PLACEHOLDER = /^\s*(-+|[.\u2026]*|(please\s+)?(select|choose|pick)\b[^a-z0-9]*(an?\s+)?(option|one|value)?[^a-z0-9]*)\s*$/i;
    const valueOf = node => {
      const tag = node.tagName;
      if (node.isContentEditable) return clean(node.innerText);
      if (tag === 'SELECT') {
        const o = node.selectedOptions && node.selectedOptions[0];
        const t = clean(o ? o.innerText || o.textContent : '');
        return PLACEHOLDER.test(t) ? '' : t;
      }
      if (tag === 'BUTTON' || node.getAttribute('role') === 'combobox' && tag !== 'INPUT') {
        // innerText, not textContent: Teamtailor keeps CSS-hidden placeholder
        // spans next to the chosen label, and textContent concatenates both -
        // which reads as "Select an option" even when a value IS committed, and
        // scored correctly-filled fields as empty for three debugging rounds.
        const t = clean(node.innerText).replace(/select (an option|one or more options)/ig, '').trim();
        return PLACEHOLDER.test(t) ? '' : t;
      }
      if (tag === 'DIV') {
        const t = clean(node.innerText);
        // "Click to enter", "Select an option", "Add a value", an em-dash: the cell
        // is EMPTY and saying otherwise is how a blank field scores as filled.
        return /^(click|tap|select|choose|add|enter|pick|none|[-–—.\s]*)\b/i.test(t) && t.length < 40 ? '' : t;
      }
      if (node.type === 'checkbox' || node.type === 'radio') return node.checked ? 'checked' : '';
      return node.value || '';
    };

    // Mark the repeating-entry containers once, from the labels that identify them.
    // Everything inside one belongs to that job or that qualification, not to the
    // candidate - which is how "Location" stops collecting his home address.
    const ENTRY = /^(job title|school name|company \/ organization|employer name|institution name)/i;
    for (const l of document.querySelectorAll('label, legend')) {
      if (!ENTRY.test(clean(l.textContent))) continue;
      let n = l.parentElement;
      for (let hops = 0; n && hops < 3; n = n.parentElement, hops++) {
        if (n.tagName === 'FORM' || n.tagName === 'BODY') break;
        n.setAttribute('data-jh-entry', '1');
      }
    }

    const controls = [];
    for (const node of document.querySelectorAll(SEL)) {
      // Teamtailor's own plumbing: the sr-only hidden input holds the committed
      // option id and the search box drives the widget. Typing into either
      // reports success and changes nothing the employer will see.
      const t = node.getAttribute('data-common--dropdown-target');
      if (t === 'hiddenInput' || t === 'searchInput') continue;
      if (seen.has(node)) continue;
      seen.add(node);
      const jh = String(++window.__jh);
      node.setAttribute('data-jh', jh);
      const name = node.getAttribute('name') || '';
      const id = node.getAttribute('id') || '';
      const lab = labelFor(node);
      const bits = [name, id, node.getAttribute('placeholder'), node.getAttribute('aria-label'), lab];
      const row = node.closest('div,fieldset,li,td,tr,label');
      let opts = null;
      if (node.tagName === 'SELECT') {
        opts = [...node.options].map(o => clean(o.innerText || o.textContent))
          .filter(t => t && !PLACEHOLDER.test(t)).slice(0, 60);
      }
      const inEntry = !!node.closest('[data-jh-entry]');
      // Bot traps. Workday ships one on every account and sign-in form, labelled
      // "Enter website. This input is for robots only, do not enter if you're
      // human." - and the `portfolio` matcher happily filled it, which is the one
      // thing on the page guaranteed to get the submission binned. A trap is
      // never filled and never counted as an unanswered question.
      const TRAP_TEXT = /robots? only|do not enter if you'?re human|leave (this )?(field |box )?(blank|empty)|honey ?pot|if you are human,? (ignore|skip)/i;
      const TRAP_NAME = /honey|hp_|_hp$|bot[-_]?field|no ?fill|url_?trap/i;
      const trap = TRAP_TEXT.test(lab) || TRAP_TEXT.test(clean(node.placeholder))
                   || TRAP_NAME.test(name || '') || TRAP_NAME.test(node.id || '');
      controls.push({
        jh, options: opts, inEntry, trap,
        text: bits.filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 220),
        label: lab,
        tag: node.tagName.toLowerCase(),
        type: (node.getAttribute('type') || '').toLowerCase(),
        role: node.getAttribute('role') || '',
        name,
        value: valueOf(node),
        maxlength: node.getAttribute('maxlength') || '',
        hasPopup: !!node.getAttribute('aria-haspopup') || node.getAttribute('aria-autocomplete') === 'list',
        required: node.required || node.getAttribute('aria-required') === 'true'
                  || /\*|required/i.test(clean(row && row.innerText).slice(0, 90)),
        visible: visible(node),
        inGroup: !!node.closest('fieldset'),
      });
    }

    // Question groups. A radio's own label is just "Yes", so the question it
    // belongs to is only knowable from the legend - and the group's answer is
    // only knowable by asking which option ended up checked.
    const groups = [];
    const OPTIONISH = /^(yes|no|n\/?a|other|male|female|prefer not|select|choose)\b/i;
    for (const fs of document.querySelectorAll('fieldset')) {
      const legend = clean(fs.querySelector('legend') && fs.querySelector('legend').innerText)
                       .replace(/\*|Required/g, '').trim();
      if (!legend) continue;
      let readback = '', kind = 'text';
      const trig = fs.querySelector('[data-common--dropdown-target=button]');
      if (trig) {
        kind = 'tt-dropdown';
        const hid = fs.querySelector('input[data-common--dropdown-target=hiddenInput]');
        const shown = clean(trig.innerText).replace(/select (an option|one or more options)/ig, '').trim();
        readback = shown || (hid && hid.value ? `set (id ${hid.value})` : '');
      } else if (fs.querySelector('input[type=radio],input[type=checkbox]')) {
        kind = 'choice';
        readback = [...fs.querySelectorAll('input[type=radio],input[type=checkbox]')]
          .filter(i => i.checked)
          .map(i => clean((document.querySelector(`label[for="${CSS.escape(i.id)}"]`) || {}).innerText)
                    || clean(i.closest('label') && i.closest('label').innerText))
          .filter(Boolean).join(', ');
      } else {
        const box = fs.querySelector('input:not([type=hidden]), textarea, select');
        if (box) readback = valueOf(box);
      }
      groups.push({
        legend: legend.slice(0, 120), readback: readback.slice(0, 120), kind,
        required: /\*|required/i.test(clean(fs.innerText).slice(0, 120)),
        visible: visible(fs),
      });
    }

    // --- radio/checkbox groups with no <fieldset> ---------------------------
    const QUESTIONISH = /\?\s*$|\*/;
    const inNamedGroup = new Set();
    {
      const all = [...document.querySelectorAll('*')];
      const pos = new Map(all.map((n, i) => [n, i]));
      const questionOf = (box) => {
        for (let k = (pos.get(box) ?? 0) - 1, stop = 0; k >= 0 && stop < 300; k--, stop++) {
          const n = all[k];
          if (n.contains(box)) continue;
          const t = clean(n.innerText);
          if (!t || t.length > 400) continue;
          // a container that owns a control is a different field, not this label
          if (n.querySelector('input, select, textarea')) continue;
          if (OPTIONISH.test(t) && t.length < 24) continue;
          if (QUESTIONISH.test(t)) return t;
        }
        return '';
      };
      const byQ = new Map();
      for (const i of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
        if (i.closest('fieldset')) continue;
        const q = questionOf(i);
        if (!q) continue;
        if (!byQ.has(q)) byQ.set(q, []);
        byQ.get(q).push(i);
      }
      // fallback: same name, no question found - better a group labelled by its
      // nearest text than a question nobody can answer
      for (const i of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
        if (i.closest('fieldset')) continue;
        if ([...byQ.values()].some(b => b.includes(i))) continue;
        const nm = i.getAttribute('name');
        if (!nm) continue;
        const key = '\u0000name:' + nm;
        if (!byQ.has(key)) byQ.set(key, []);
        byQ.get(key).push(i);
      }
      for (const [qk, boxes] of byQ) {
        // Radios come in pairs; a single checkbox is a modifier attached to some
        // other control, not a choice list of its own.
        if (boxes.length < 2 && boxes[0].type !== 'radio') continue;
        const first = boxes[0];
        const nm = first.getAttribute('name') || '';
        let q = qk;
        if (qk.startsWith('\u0000name:')) {
          q = questionOf(first) || clean((first.closest('div,li,td,fieldset,section') || {}).innerText).slice(0, 160);
          if (!q) continue;
        }
        boxes.forEach(b => inNamedGroup.add(b));
        const labelOf = i => clean((document.querySelector(`label[for="${CSS.escape(i.id || '')}"]`) || {}).innerText)
                             || clean(i.closest('label') && i.closest('label').innerText);
        groups.push({
          legend: q.replace(/\*/g, '').trim().slice(0, 160),
          readback: boxes.filter(b => b.checked).map(labelOf).filter(Boolean).join(', ').slice(0, 120),
          kind: 'radio-group',
          name: nm,
          options: boxes.map(b => ({ jh: b.getAttribute('data-jh'), label: labelOf(b) })).filter(o => o.jh && o.label),
          required: /\*/.test(q),
          visible: visible(first),
        });
      }
      // stop the control loop reporting each radio on its own
      for (const c of controls) {
        if (c.type !== 'radio' && c.type !== 'checkbox') continue;
        const el = document.querySelector(`[data-jh="${c.jh}"]`);
        if (el && inNamedGroup.has(el)) c.inGroup = true;
      }
    }

    // Ghost hunt: walk the labels, not the inputs. Anything being ASKED that has
    // no control behind it is a widget the automation cannot see.
    const labels = [];
    for (const l of document.querySelectorAll('label, legend, [class*="question-title"], [class*="field-label"]')) {
      if (!visible(l)) continue;
      const text = clean(l.innerText);
      if (!text || text.length > 200) continue;
      if (OPTIONISH.test(text) && text.length < 24) continue;   // an option, not a question
      if (/^\*?\s*required field/i.test(text)) continue;        // the form's note about itself
      // Reachable means "this inventory stamped it". Anything else - the sr-only
      // input Teamtailor hides behind a fake widget, or some control belonging to
      // a different question three wrappers up - is not this label's control.
      const mine = n => {
        if (!n) return null;
        const c = n.querySelector('[data-jh], input[type=file], [role=radiogroup], [contenteditable=true]');
        return c || null;
      };
      let ctl = null;
      const forId = l.getAttribute && l.getAttribute('for');
      if (forId) {
        const t = document.getElementById(forId);
        if (t && (t.hasAttribute('data-jh') || t.type === 'file')) ctl = t;
      }
      if (!ctl) ctl = mine(l);
      // Widen outwards, but stop the moment the ancestor covers another question -
      // otherwise the search reaches <form> and every label looks answered.
      for (let n = l.parentElement, hops = 0; n && !ctl && hops < 4; n = n.parentElement, hops++) {
        if (n.tagName === 'FORM' || n.tagName === 'BODY') break;
        if (n.querySelectorAll('label, legend').length > 1) break;
        ctl = mine(n);
      }
      labels.push({
        text: text.replace(/\s*\*\s*$/, '').slice(0, 140),
        required: /\*\s*$|required/i.test(text),
        jh: ctl && ctl.getAttribute ? ctl.getAttribute('data-jh') : null,
        matched: !!ctl,
      });
    }

    return { controls, groups, labels, url: location.href };
  }, INV_SEL).catch(() => ({ controls: [], groups: [], labels: [], url: '' }));
}

// Every frame in one go. Frame index is carried so a control can be addressed
// back to the frame that owns it.
async function inspectAll({ withSections = true } = {}) {
  const out = [];
  const fr = frames();
  for (let i = 0; i < fr.length; i++) {
    const r = await inspect(fr[i]);
    const secs = withSections ? await sections(fr[i]) : [];
    out.push({ f: fr[i], i, sections: secs, ...r });
  }
  return out;
}

/* ---------------------------------------------------------------- answer bank */
// Regex matchers cannot converge on bespoke forms, and a broad one silently
// steals a later field - /graduat/ took "Are you a recent graduate with a STEM
// degree" and would have answered a yes/no question "June 2026". Matching on the
// QUESTION TEXT of something already answered does not have that failure mode,
// and it accumulates: every question answered once is answered automatically the
// next time an ATS asks it in roughly the same words.
// JOBHUNT_BANK lets the practice forms exercise the bank without teaching the real
// one that "Example Ltd" is an employer.
const BANK_PATH = process.env.JOBHUNT_BANK || join(ROOT, 'qa-bank.json');
const STOP = new Set(('a an the is are do does did you your yours our we us i to of in on for with '
  + 'and or if any please this that it be been will would can could have has had at as by from '
  + 'what which when where how why who about their there they them not no yes').split(' '));

function bankLoad() {
  try { const b = JSON.parse(readFileSync(BANK_PATH, 'utf8')); return Array.isArray(b.entries) ? b.entries : []; }
  catch { return []; }
}
const bank = bankLoad();

const toks = s => new Set(norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)));
function sim(a, b) {
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / new Set([...A, ...B]).size;
}

// NEAR beats the regex matchers (it is the same question, previously judged).
// FUZZY only runs after they miss, and is flagged in the report for review.
const BANK_NEAR = 0.8, BANK_FUZZY = 0.5;
function bankMatch(question) {
  let best = null, score = 0;
  for (const e of bank) {
    const s = sim(question, e.q);
    if (s > score) { score = s; best = e; }
  }
  return best && score >= BANK_FUZZY ? { entry: best, score } : null;
}

function bankPut(question, answer, why = 'answered in session') {
  question = String(question).replace(/\s+/g, ' ').trim();
  answer = String(answer);
  if (!question || !answer) return;
  // A practice page is not an employer. Without this the bank fills up with
  // answers to questions only test/ ever asks.
  if (/^file:/.test(page.url()) && !process.env.JOBHUNT_BANK) {
    console.log('   (practice page - not saved to the answer bank)');
    return;
  }
  const i = bank.findIndex(e => sim(e.q, question) >= 0.95);
  const rowEntry = { q: question, a: answer, ats: hostOf(), company: rec.company,
                     slug: rec.slug, why, ts: new Date().toISOString().slice(0, 10) };
  if (i >= 0) bank[i] = rowEntry; else bank.push(rowEntry);
  try {
    writeFileSync(BANK_PATH, JSON.stringify({ entries: bank }, null, 2) + '\n');
    console.log(`   remembered for next time: "${question.slice(0, 60)}"`);
  } catch (e) { console.log(`   (could not write ${BANK_PATH}: ${e.message})`); }
}

/* ---------------------------------------------------------------- read-back */
// Does what the page now SHOWS agree with what was put in? "Non-empty" is not the
// same question and misses the whole silent class: the dial-code selector that
// turns +44 7700... into "+44 +44 7700...", the date input that discards
// "Available immediately" without an error, the React combobox that shows typed
// text it never committed.
function agrees(intended, got, type = '') {
  if (got == null || got === '') return false;
  const a = norm(String(intended)), b = norm(String(got));
  if (!a) return true;
  if (a === b) return true;
  if (/tel|phone/.test(type)) {
    const da = a.replace(/\D/g, ''), db = b.replace(/\D/g, '');
    if (db.length < 6) return false;
    // "+44 +44 7700" - the number is in there twice, which is NOT agreement
    if (db.length > da.length + 3) return false;
    return da.endsWith(db.slice(-9)) || db.endsWith(da.slice(-9));
  }
  if (type === 'date') {
    const da = a.replace(/\D/g, ''), db = b.replace(/\D/g, '');
    return !!da && !!db && (da === db || da.includes(db) || db.includes(da));
  }
  // long prose (cover letter, why-us): the box may trim or the form may cap it
  if (a.length > 60) return b.length > 40 && (b.startsWith(a.slice(0, 40)) || a.startsWith(b.slice(0, 40)));
  return b.includes(a) || a.includes(b);
}

const STATUS_NOTE = {
  ok: 'filled and confirmed on the page',
  mismatch: 'value was entered but the page does not show it - the form did not take it',
  empty_required: 'required and still empty',
  no_answer: 'the form asks this and answers.json has no value',
  unrecognised: 'no matcher and no bank entry - needs a judgement',
  ghost: 'a question with no control the scanner can reach',
  collapsed: 'a section still folded shut - its fields do not exist until it is opened',
  human_only: 'yours by design (consent, captcha, upload, password)',
  trap: 'a bot trap - correctly left empty, not a missing answer',
};

// Reconcile intent against the page. Everything reported as missing is computed
// from the page's own inventory, never from the filler's log - so a field the
// matchers never saw still shows up, instead of not showing up at all.
async function assess(R) {
  for (const f of frames()) {
    await f.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); }).catch(() => {});
  }
  const views = await inspectAll();
  const intents = R ? R.intent : [];
  // Address an intent by the stamp it was filled through first, and only fall back
  // to its label. Two controls under one label otherwise both claim it, and the
  // one that is not the answer gets reported as the answer being wrong.
  const byJh = new Map(), byLabel = new Map(), used = new Set();
  for (const it of intents) {
    if (it.jh) byJh.set(`${it.frame}:${it.jh}`, it);
    const k = norm(it.label || it.text || '');
    if (!byLabel.has(k)) byLabel.set(k, []);
    byLabel.get(k).push(it);
  }
  const claimIntent = (frameIdx, jh, labelText) => {
    const direct = byJh.get(`${frameIdx}:${jh}`);
    if (direct && !used.has(direct)) { used.add(direct); return direct; }
    for (const it of (byLabel.get(norm(labelText)) || [])) {
      if (it.jh && byJh.has(`${frameIdx}:${it.jh}`) && it.jh !== jh) continue;  // belongs to its own control
      if (!used.has(it)) { used.add(it); return it; }
    }
    return null;
  };

  const fields = [];
  const push = (o) => fields.push({ ...o, note: STATUS_NOTE[o.status] });
  const claimed = new Set();

  for (const v of views) {
    for (const g of v.groups) {
      if (!g.visible) continue;
      const it = claimIntent(v.i, null, g.legend);
      if (it) claimed.add(it);
      const status = it
        ? (agrees(it.value, g.readback) ? 'ok' : 'mismatch')
        : (g.readback ? 'ok' : (g.required ? 'empty_required' : 'empty'));
      if (status === 'empty') continue;
      push({ label: g.legend, kind: g.kind, key: it ? it.key : null, required: g.required,
             intended: it ? String(it.value).slice(0, 90) : null, readback: g.readback, status });
    }

    for (const c of v.controls) {
      if (!c.visible && c.type !== 'file') continue;
      if (c.inGroup) continue;                      // reported as its group
      if (c.trap) { push({ label: c.label || 'bot trap', kind: 'trap', status: 'trap' }); continue; }
      if (c.type === 'password') { push({ label: c.label || 'password', kind: 'password', status: 'human_only' }); continue; }
      if (c.type === 'file') { push({ label: c.label || label({ text: c.text }), kind: 'file', required: c.required, status: 'human_only' }); continue; }
      const it = claimIntent(v.i, c.jh, c.label || c.text);
      if (it) claimed.add(it);
      if (c.type === 'checkbox' || c.type === 'radio') {
        if (c.value) push({ label: c.label || c.text.slice(0, 80), kind: c.type, required: c.required, readback: 'ticked', status: 'ok' });
        else if (c.required) push({ label: c.label || c.text.slice(0, 80), kind: c.type, required: true, status: 'empty_required' });
        continue;
      }
      const failed = R && R.failed ? R.failed.get(norm(c.label || c.text)) : null;
      let status;
      if (it) status = agrees(it.value, c.value, c.type) ? 'ok' : 'mismatch';
      else if (failed) status = 'mismatch';   // attempted, refused - not "already fine"
      else if (c.value) status = 'ok';
      else if (R && R.noAnswerKeys.has(norm(c.label || c.text))) status = 'no_answer';
      else if (c.required) status = 'empty_required';
      else status = 'unrecognised';
      if (status === 'unrecognised' && !c.required && !(R && R.unknownLabels.has(norm(c.label || c.text)))) {
        // an optional field nobody asked about and nothing matched: still worth
        // listing, because "optional" is the form's opinion, not Arion's
      }
      const row = { label: (c.label || c.text).slice(0, 120), kind: c.role || c.tag + (c.type ? ':' + c.type : ''),
             key: it ? it.key : null, required: c.required, jh: c.jh, frame: v.i,
             maxlength: c.maxlength || undefined,
             options: c.options && c.options.length ? c.options.slice(0, 40) : undefined,
             intended: it ? String(it.value).slice(0, 90) : null, readback: c.value.slice(0, 90), status };
      push(row);
      // the filler's own reason beats the generic note - it usually says the fix
      if (failed && status === 'mismatch') fields[fields.length - 1].note = failed;
    }

    for (const sec of (v.sections || [])) {
      if (sec.open) continue;
      if (fields.some(x => norm(x.label) === norm(sec.name))) continue;
      push({ label: sec.name, kind: 'collapsed-section', required: false, status: 'collapsed' });
    }
    for (const l of v.labels) {
      if (l.matched) continue;
      if (fields.some(x => norm(x.label) === norm(l.text))) continue;
      push({ label: l.text, kind: 'unknown-widget', required: l.required, status: 'ghost' });
    }
  }

  // An intent whose field vanished from the page between fill and read-back
  for (const it of (R ? R.intent : [])) {
    if (claimed.has(it)) continue;
    push({ label: it.label || it.text, key: it.key, intended: String(it.value).slice(0, 90),
           readback: null, status: 'mismatch', kind: 'vanished' });
  }

  const count = s => fields.filter(f => f.status === s).length;
  const counts = {
    questions_on_page: new Set(fields.map(f => norm(f.label))).size,
    ok: count('ok'), mismatch: count('mismatch'), empty_required: count('empty_required'),
    no_answer: count('no_answer'), unrecognised: count('unrecognised'),
    ghost: count('ghost'), human_only: count('human_only'), collapsed: count('collapsed'),
    trap: count('trap'),
  };
  const blockers = fields.filter(f => f.status === 'mismatch'
    || f.status === 'collapsed'
    || (f.status === 'empty_required')
    || (f.status === 'ghost' && f.required)
    || (f.status === 'no_answer' && f.required));
  return { fields, counts, blockers, url: page.url() };
}

/* ------------------------------------------------------- state for Claude */
// The report used to be prose on a terminal, which meant Claude was downstream of
// Arion relaying it. This writes the same truth as JSON plus a screenshot, so a
// unique field can be handled without anyone transcribing anything - and the
// screenshot catches what no DOM scan can (a segmented control, a greyed-out
// field waiting on another answer, a layout that makes the question obvious).
const STATE = join(rec.dir, 'session.json');
const SHOTS = join(rec.dir, 'shots');
const ASK = join(rec.dir, '.session-ask');
let stepNo = 0;

async function shoot(tag) {
  if (has('noshots')) return null;
  mkdirSync(SHOTS, { recursive: true });
  const name = `${String(++stepNo).padStart(2, '0')}-${tag}.png`;
  try {
    await page.screenshot({ path: join(SHOTS, name), fullPage: true, timeout: 15000 });
    return `shots/${name}`;
  } catch {
    try { await page.screenshot({ path: join(SHOTS, name), timeout: 8000 }); return `shots/${name}`; }
    catch { return null; }
  }
}

async function writeState(stage, a, extra = {}) {
  const shot = await shoot(stage);
  const state = {
    slug: rec.slug, company: rec.company, role: rec.role,
    stage, at: new Date().toISOString(), url: a.url, host: hostOf(a.url),
    step: stepNo, screenshot: shot,
    counts: a.counts,
    needs_arion: a.fields.filter(f => f.status === 'human_only').map(f => f.label),
    needs_claude: a.blockers.map(f => ({ label: f.label, status: f.status, kind: f.kind,
                                         required: !!f.required, intended: f.intended ?? null,
                                         readback: f.readback ?? null, note: f.note })),
    fields: a.fields,
    ...extra,
  };
  try { writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n'); } catch {}
  return state;
}

// Tool -> Claude. The reverse channel (.session-cmd) already exists and is proven
// by the emailed-security-code flow; this is the same trick pointed the other way,
// so a field needing judgement becomes a queue entry rather than a dead end.
let pendingAsks = [];
async function writeAsks(a) {
  const askId = (label) => {
    let h = 0;
    for (const ch of norm(label)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return 'q' + h.toString(36).slice(0, 4);
  };
  const seenLabel = new Map();
  pendingAsks = a.blockers
    .filter(f => f.status !== 'human_only')
    .map((f) => {
      const base = askId(f.label);
      const n = (seenLabel.get(base) || 0) + 1;
      seenLabel.set(base, n);
      return {
      id: n > 1 ? `${base}-${n}` : base, label: f.label, status: f.status, kind: f.kind,
      required: !!f.required, maxlength: f.maxlength || null,
      intended: f.intended ?? null, readback: f.readback ?? null,
      jh: f.jh ?? null, frame: f.frame ?? 0, note: f.note,
      };
    });
  if (!pendingAsks.length) { try { if (existsSync(ASK)) unlinkSync(ASK); } catch {} return []; }
  try {
    writeFileSync(ASK, JSON.stringify({
      slug: rec.slug, url: a.url, at: new Date().toISOString(),
      how: 'reply by writing one line to .session-cmd: answer:<id>:<text>  or  key:<answers.json key>=<value>',
      asks: pendingAsks,
    }, null, 2) + '\n');
  } catch {}
  return pendingAsks;
}

// Fill one specific field that Claude just answered, then remember the answer.
async function answerAsk(id, text) {
  const q = pendingAsks.find(x => x.id === id) || pendingAsks.find(x => norm(x.label).startsWith(norm(id)));
  if (!q) { console.log(`no pending ask "${id}" - current: ${pendingAsks.map(x => x.id).join(', ') || 'none'}`); return false; }
  const fr = frames()[q.frame] || page;
  let el = q.jh ? fr.locator(`[data-jh="${q.jh}"]`).first() : null;
  if (!el || !(await el.count().catch(() => 0))) {
    // the handle went stale on a re-render; find it by its label instead
    const views = await inspectAll();
    for (const v of views) {
      const c = v.controls.find(c => norm(c.label || c.text) === norm(q.label) && c.visible);
      if (c) { el = v.f.locator(`[data-jh="${c.jh}"]`).first(); break; }
    }
  }
  if (!el || !(await el.count().catch(() => 0))) {
    // A radio group has no single control to address, so match the option instead.
    for (const v of await inspectAll()) {
      const g = v.groups.find(g => g.options && g.options.length && norm(g.legend) === norm(q.label));
      if (!g) continue;
      const want = norm(text);
      const pick = g.options.find(o => norm(o.label) === want)
                || g.options.find(o => norm(o.label).startsWith(want) || want.startsWith(norm(o.label)));
      if (!pick) { console.log(`"${text}" is not one of [${g.options.map(o => o.label).join(', ')}]`); return false; }
      await v.f.locator(`[data-jh="${pick.jh}"]`).first().click({ timeout: 3000, force: true }).catch(() => {});
      await page.waitForTimeout(150);
      console.log(`answered "${g.legend.slice(0, 55)}" <- ${pick.label}`);
      bankPut(g.legend, pick.label, 'answered by Claude during a session');
      return true;
    }
    console.log(`could not find "${q.label}" on this page any more`);
    return false;
  }
  const ok = await fillOne(fr, el, text, q.label);
  console.log(ok ? `filled "${q.label}" <- ${String(text).slice(0, 60)}` : `could not fill "${q.label}"`);
  if (ok) bankPut(q.label, text, 'answered by Claude during a session');
  return ok;
}

// One field, every fallback, used by both the main pass and answerAsk.
async function fillOne(f, el, val, labelText = '') {
  val = String(val);
  let tag = '', type = '', role = '';
  try {
    const d = await el.evaluate(n => [n.tagName.toLowerCase(), (n.getAttribute('type') || '').toLowerCase(),
                                     n.getAttribute('role') || '', !!n.getAttribute('aria-haspopup')]);
    [tag, type, role] = d;
  } catch { return false; }
  try {
    if (tag === 'select') {
      let ok = true;
      await el.selectOption({ label: val }, { timeout: 4000 })
        .catch(() => el.selectOption(val, { timeout: 3000 }))
        .catch(() => { ok = false; });
      return ok;
    }
    const editable = await el.evaluate(n => n.isContentEditable).catch(() => false);
    if (editable) {
      // .fill() works on a contenteditable but leaves the framework's model empty on
      // the editors that mirror into a hidden input. Click, select all, type.
      await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await el.click({ timeout: 3000 }).catch(() => {});
      await el.press('ControlOrMeta+a').catch(() => {});
      await el.press('Delete').catch(() => {});
      await el.type(val, { delay: 4 }).catch(() => {});
      return true;
    }
    if (tag === 'div') return await fillClickToEdit(f, el, val);
    if (tag === 'button' || role === 'combobox') return !!(await pickOption(f, el, val).catch(() => null));
    if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
    await el.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
    await el.click({ timeout: 3500 }).catch(() => el.click({ timeout: 2500, force: true }).catch(() => {}));
    try { await el.fill(val, { timeout: 4000 }); }
    catch {
      await el.evaluate((n, v) => {
        const proto = n instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(n, v);
        n.dispatchEvent(new Event('input', { bubbles: true }));
        n.dispatchEvent(new Event('change', { bubbles: true }));
      }, val);
    }
    return true;
  } catch (e) {
    if (labelText) console.log(`   (${labelText}: ${e.message.split('\n')[0].slice(0, 80)})`);
    return false;
  }
}

// Answer the radio groups that have no <fieldset>, using the question inferred
// from the text above them. Same matching ladder as everything else.
async function fillNamedGroups(f, inv, R, fill, answered, only) {
  const handled = new Set();
  for (const g of inv.groups) {
    if (g.kind !== 'radio-group' || !g.visible || !g.options || !g.options.length) continue;
    if (only && !only.has(norm(g.legend))) continue;
    handled.add(g.name);
    if (g.readback) { R.skipped.push(`already answered: ${g.legend.slice(0, 60)} = ${g.readback}`); continue; }

    const bm = bankMatch(g.legend);
    const known = MATCHERS.find(([, re]) => re.test(g.legend));
    let key = null, val = null;
    if (bm && bm.score >= BANK_NEAR) { key = known ? known[0] : null; val = bm.entry.a; }
    else if (known && answers[known[0]] != null) { key = known[0]; val = answers[known[0]]; }
    else if (bm) { key = known ? known[0] : null; val = bm.entry.a; }
    else if (known) { R.noAnswer.push(`"${known[0]}" wanted by: ${g.legend.slice(0, 70)}`); R.noAnswerKeys.add(norm(g.legend)); continue; }
    else { R.unknownLabels.add(norm(g.legend)); continue; }
    if (!key) key = 'q:' + norm(g.legend).split(' ').slice(0, 3).join('-');
    val = String(val);

    if (!fill) { R.filled.push(`${key} -> ${g.legend.slice(0, 55)}  [radio group]`); continue; }

    // Match the option, then fall back to the yes/no reading of a prose answer -
    // "Not currently - I hold a Graduate visa" against a bare Yes/No list is a
    // judgement, not a string match, so it is deliberately NOT guessed here.
    const want = norm(val);
    let pick = g.options.find(o => norm(o.label) === want)
            || g.options.find(o => norm(o.label).startsWith(want) || want.startsWith(norm(o.label)));
    if (!pick && /^(yes|no)\b/.test(want)) {
      const y = want.startsWith('yes') ? 'yes' : 'no';
      pick = g.options.find(o => norm(o.label) === y);
    }
    if (!pick) {
      R.skipped.push(`${key}: "${val.slice(0, 50)}" is not one of [${g.options.map(o => o.label).join(', ')}] for "${g.legend.slice(0, 50)}" - needs a decision`);
      R.failed.set(norm(g.legend), `the form offers only [${g.options.map(o => o.label).join(', ')}]; the stored answer is prose: "${val.slice(0, 70)}"`);
      continue;
    }
    const el = f.locator(`[data-jh="${pick.jh}"]`).first();
    await el.click({ timeout: 3000, force: true }).catch(() => {});
    await page.waitForTimeout(120);
    R.filled.push(`${key} -> ${g.legend.slice(0, 50)}  [chose "${pick.label}"]`);
    R.intent.push({ key, label: g.legend, text: g.legend, value: pick.label, group: true });
    answered.add(key);
  }
  return handled;
}

// Find the expandable section headers and say which are still shut.
async function sections(f) {
  return await f.evaluate(() => {
    const clean = t => (t || '').replace(/\s+/g, ' ').trim();
    // textContent, not innerText: innerText forces a layout for every element it
    // touches, and the first version of this walked every span and svg on the
    // page doing exactly that. On a long form it simply never returned.
    const CAND = '[aria-expanded], button, [role=button], '
      + '[class*="plus"], [class*="pencil"], [class*="add-"], [class*="-add"], [class*="edit"]';
    const out = [];
    const seenNames = new Set();
    const nodes = [...document.querySelectorAll(CAND)].slice(0, 400);
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const aria = n.getAttribute('aria-expanded');
      const t = clean(n.textContent).slice(0, 12);
      const al = (n.getAttribute('aria-label') || n.getAttribute('title') || '').toLowerCase();
      const cls = (n.className || '').toString().toLowerCase();
      const looksToggle = aria === 'false'
        || t === '+' || t === '\u2795'
        || /^(add|edit)\b/.test(al)
        || /fa-plus|fa-pencil|icon-plus|icon-edit|plus-icon|pencil-icon/.test(cls);
      if (!looksToggle) continue;
      const row = n.closest('div,section,li,h1,h2,h3,h4,header') || n.parentElement;
      if (!row) continue;
      const name = clean(row.textContent).slice(0, 60);
      if (!name || name.length < 2 || seenNames.has(name)) continue;
      seenNames.add(name);
      const body = row.parentElement || row;
      const open = aria === 'true'
        || !!body.querySelector('input:not([type=hidden]):not([type=submit]), textarea, select');
      n.setAttribute('data-jh-exp', String(out.length));
      out.push({ i: out.length, name, open, aria });
    }
    return out;
  }).catch(() => []);
}

// Open every shut section, then let the caller re-scan. Bounded, because a toggle
// that reveals another toggle would otherwise loop.
async function expandAll({ quiet = false, max = 12 } = {}) {
  let opened = [];
  // Hard cap. Without one this walked a job-description page clicking every
  // element whose class happened to contain "edit" or "add", 700ms apiece, and
  // never came back. A form has a handful of foldable sections, not dozens.
  let clicks = 0;
  for (let round = 0; round < 2 && clicks < max; round++) {
    let did = false;
    for (const f of frames()) {
      const secs = await sections(f);
      for (const sec of secs) {
        if (sec.open || clicks >= max) continue;
        const el = f.locator(`[data-jh-exp="${sec.i}"]`).first();
        if (!(await el.count().catch(() => 0))) continue;
        const before = page.url();
        await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await el.click({ timeout: 3000 }).catch(() => el.click({ timeout: 2000, force: true }).catch(() => {}));
        clicks++;
        await page.waitForTimeout(450);
        // a toggle that navigated was not a toggle - stop before it opens anything else
        if (page.url() !== before) {
          console.log(`   "${sec.name.slice(0, 40)}" navigated instead of expanding - stopping`);
          return [...new Set(opened)];
        }
        opened.push(sec.name);
        did = true;
      }
      await f.evaluate(() => document.querySelectorAll('[data-jh-exp]')
                                     .forEach(n => n.removeAttribute('data-jh-exp'))).catch(() => {});
    }
    if (!did) break;
  }
  opened = [...new Set(opened)];
  if (opened.length && !quiet) console.log(`   expanded ${opened.length} section(s): ${opened.map(x => x.split(' ')[0]).join(', ')}`);
  return opened;
}

// --- skill matrices ----------------------------------------------------------
// A resume parser fills a skills grid and defaults every level to the lowest one.
// "Github: Novice" against a CV full of GitHub Actions pipelines reads worse than
// saying nothing, and it is what an interviewer sees first. Policy lives in
// jobhunt/skill-levels.json so it is one file to argue with, not code.
// One evaluate for the whole grid - there can be fifty of these.
async function setSkillLevels() {
  let pol;
  try { pol = JSON.parse(readFileSync(join(ROOT, 'skill-levels.json'), 'utf8')); }
  catch { console.log('no skill-levels.json - skipping'); return; }
  let total = { set: 0, dropped: [], seen: 0 };
  for (const f of frames()) {
    const r = await f.evaluate((pol) => {
      const norm = t => (t || '').toLowerCase().replace(/[^a-z0-9+#./ ]/g, '').replace(/\s+/g, ' ').trim();
      const adv = new Set(pol.advanced.map(norm));
      const drop = new Set((pol.drop || []).map(norm));
      const out = { set: 0, dropped: [], seen: 0 };
      const LEVELS = new Set(['novice', 'beginner', 'some knowledge', 'working knowledge',
        'intermediate', 'proficient', 'advanced', 'expert', 'basic', 'fluent', 'native',
        // placeholders a level dropdown shows before anything is chosen - these are
        // not skill names and must not be mistaken for the card's title
        'not specified', 'none', 'na', 'n/a', 'select', 'choose', 'select one',
        'please select', 'skill level', '']);
      const isLevel = s => {
        const l = s.id ? document.querySelector(`label[for="${CSS.escape(s.id)}"]`) : null;
        if (/skill level/i.test((l && l.textContent) || s.getAttribute('name') || '')) return true;
        const hits = [...s.options].filter(o => LEVELS.has(norm(o.textContent))).length;
        return hits >= 2;
      };
      for (const sel of [...document.querySelectorAll('select')].filter(isLevel)) {
        out.seen++;
        const card = sel.closest('div,li,td') || sel.parentElement;
        // the skill's name is the card's first line of text that is not the label
        // the card's own text, with the level vocabulary and chrome stripped out
        let box = card;
        for (let hops = 0; box && hops < 3; box = box.parentElement, hops++) {
          const t = (box.innerText || '').trim();
          if (t && t.split('\n').some(x => !LEVELS.has(norm(x)) && !/^skill level/i.test(x.trim()))) break;
        }
        const cardText = ' ' + norm((box || card).innerText || '') + ' ';
        const name = ((box || card).innerText || '').split('\n').map(x => x.trim())
          .find(x => x && !LEVELS.has(norm(x)) && !/^skill level$/i.test(x)
                     && !/^(add|remove|delete|x|\u00d7)$/i.test(x)) || '';
        const has = term => cardText.includes(' ' + term + ' ')
                         || cardText.includes(' ' + term + ',')
                         || norm(name) === term;
        const key = norm(name);
        if ([...drop].some(has)) {
          // remove it rather than rate it: it is not in his CV at all
          const x = [...card.querySelectorAll('button, a, span, i')]
            .find(b => /^(x|\u00d7|remove|delete)$/i.test((b.textContent || '').trim())
                       || /remove|delete/i.test(b.getAttribute('aria-label') || ''));
          if (x) { x.click(); out.dropped.push(name); continue; }
        }
        const want = ([...adv].some(has)) ? pol.prefer_for_advanced : pol.prefer_for_default;
        const opts = [...sel.options].map(o => (o.textContent || '').trim());
        let pick = null;
        for (const w of want) { const i = opts.findIndex(o => norm(o) === norm(w)); if (i > -1) { pick = i; break; } }
        if (pick == null) continue;
        if (sel.selectedIndex === pick) continue;
        sel.selectedIndex = pick;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        out.set++;
        (out.picked = out.picked || []).push(`${name || '?'}=${opts[pick]}`);
      }
      return out;
    }, pol).catch(() => ({ set: 0, dropped: [], seen: 0 }));
    total.set += r.set; total.seen += r.seen; total.dropped.push(...r.dropped);
    (total.picked = total.picked || []).push(...(r.picked || []));
  }
  try { writeFileSync(join(rec.dir, '.session-skills'), (total.picked || []).join('\n') + '\n'); } catch {}
  console.log(`skill levels: ${total.set} of ${total.seen} raised`
    + (total.dropped.length ? `; removed ${total.dropped.length} the CV does not support (${total.dropped.join(', ')})` : ''));
}

// Drop a whole repeating entry - a job or a qualification - by something it says.
// Arion's rule: when a foundation year has no degree-level field the form will
// accept, leave the entry out entirely and list only the university.
async function removeEntry(text) {
  const want = norm(text);
  for (const f of frames()) {
    const hit = await f.evaluate((want) => {
      const norm = t => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      for (const inp of document.querySelectorAll('input')) {
        if (!norm(inp.value).includes(want)) continue;
        let card = inp.closest('div,li,fieldset');
        for (let hops = 0; card && hops < 5; card = card.parentElement, hops++) {
          const btn = [...card.querySelectorAll('button, a, [role=button]')].find(b =>
            /remove|delete|trash|bin/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.className || ''))
            || /^(\u00d7|x|remove|delete)$/i.test((b.textContent || '').trim()));
          if (btn) { btn.setAttribute('data-jh-rm', '1'); return inp.value.slice(0, 50); }
        }
      }
      return null;
    }, want).catch(() => null);
    if (!hit) continue;
    await f.locator('[data-jh-rm]').first().click({ timeout: 4000 }).catch(() => {});
    await f.evaluate(() => document.querySelectorAll('[data-jh-rm]').forEach(n => n.removeAttribute('data-jh-rm'))).catch(() => {});
    await page.waitForTimeout(700);
    console.log(`removed the entry for "${hit}"`);
    return true;
  }
  console.log(`no removable entry matching "${text}"`);
  return false;
}

/* --------------------------------------------------------------------- scan */
async function scan({ fill, only = null, noScroll = false }) {
  const R = { filled: [], skipped: [], noAnswer: [], unknown: [], files: [], passwords: 0, fillMode: fill,
              // What was PUT IN, so the read-back has something to compare against.
              // Without this the only available check is "is it non-empty", which
              // passes on every silent-corruption bug there is.
              intent: [], noAnswerKeys: new Set(), unknownLabels: new Set(), failed: new Map(), fromBank: [] };
  // Phone widgets (Greenhouse, Ashby) pair a dial-code selector with the number
  // field. If the selector takes +44, the number must go in WITHOUT it, or the
  // employer gets "+44 +44 7700...". Detected here, corrected after the pass.
  let dialCode = null, phoneField = null;
  // A field can be backed by two controls (Retable pairs a date input with a
  // picker button). Once a key is answered, a second widget for it is noise.
  const answered = new Set();
  // Walk every frame, not just the top page: an embedded form (Retable, Typeform,
  // Workday) scrolls inside its own iframe, and fields below that fold are never
  // rendered until it is scrolled. Scroll the frame's own scroll container too.
  // The scroll pass exists because a lazy form only renders what has been near
  // the viewport. It is also the single most expensive thing here, so: only
  // frames that actually have a scroll overflow, fewer of them, a shorter dwell,
  // and skipped entirely on a repair pass where everything is already rendered.
  if (!noScroll) {
    for (const f of frames()) {
      await f.evaluate(async ({ step: dwell, max }) => {
        const scrollers = [document.scrollingElement, ...document.querySelectorAll('*')]
          .filter(n => n && n.scrollHeight > n.clientHeight + 40).slice(0, max);
        for (const sc of scrollers) {
          const step = Math.max(320, sc.clientHeight * 0.85);
          for (let y = 0; y < sc.scrollHeight; y += step) {
            sc.scrollTop = y;
            await new Promise(r => setTimeout(r, dwell));
          }
          sc.scrollTop = 0;
        }
      }, { step: T.scrollStep, max: T.scrollers }).catch(() => {});
    }
  }
  await page.waitForTimeout(noScroll ? 60 : T.settle);
  for (const f of frames()) {
    // Answer whole question-groups first (radios, multi-selects, custom
    // dropdowns), then let the per-control loop skip the inputs they own.
    let groupNames = new Set();
    try { groupNames = await fillChoiceGroups(f, R, fill, answered, only); } catch (e) {
      R.skipped.push(`choice groups failed: ${e.message.split('\n')[0]}`);
    }
    await dbgTrig('after groups');
    try { await tickConsent(f, R, fill); } catch {}
    await dbgTrig('after consent');

    // One round trip for the whole frame, instead of isVisible + describe +
    // getAttribute per control. Everything after this addresses fields by the
    // data-jh stamp inspect() left behind.
    const inv = await inspect(f);
    const fi = frames().indexOf(f);
    try { await fillNamedGroups(f, inv, R, fill, answered, only); } catch (e) {
      R.skipped.push(`radio groups failed: ${e.message.split('\n')[0]}`);
    }
    for (const info of inv.controls) {
      if (info.type === 'file') { R.files.push(info.text); continue; }
      // A bot trap is the one field where filling it is strictly worse than
      // leaving it: it is there to identify automation, and the submission that
      // trips it is discarded without a word. Never fill, and say so out loud so
      // it is obvious the field was seen and skipped on purpose.
      if (info.trap) { R.skipped.push(`bot trap, deliberately left empty: ${(info.label || info.text).slice(0, 70)}`); continue; }
      if (!info.visible) continue;

      if (info.type === 'password') { R.passwords++; continue; }   // never, under any condition
      if (info.type === 'checkbox' || info.type === 'radio') {
        if (!(info.name && groupNames.has(info.name))) R.skipped.push(`[${info.type}] ${info.text}`);
        continue;
      }
      if (info.value.trim()) { R.skipped.push(`already filled: ${info.text}`); continue; }

      const el = f.locator(`[data-jh="${info.jh}"]`).first();
      const qtext = info.label || info.text;
      // A field named for a repeating section (WorkExperience_..., Education_...)
      // belongs to that entry, not to the candidate. Filling "Location" there with
      // his home city put the wrong city against three employers.
      if (info.inEntry
          && /^(location|city|country|address|state)\b/i.test((info.label || '').trim())) {
        R.skipped.push(`${info.label} belongs to a ${/educat|school/i.test(info.name) ? 'education' : 'job'} entry - not the candidate's own`);
        continue;
      }
      if (only && !only.has(norm(qtext))) continue;   // repair pass: this field only

      // The matching ladder. The bank goes FIRST when it is near-certain, because
      // "this exact question was answered before" beats any regex - and a regex
      // that is broad enough to catch a question it was not written for is the
      // recurring bug here, not a hypothetical one.
      const bm = bankMatch(qtext);
      const known = MATCHERS.find(([, re]) => re.test(info.text));
      let key = null, val = null, src = '';
      if (bm && bm.score >= BANK_NEAR) { val = bm.entry.a; key = known ? known[0] : null; src = `bank ${bm.score.toFixed(2)}`; }
      else if (known && answers[known[0]] != null) { key = known[0]; val = answers[key]; }
      else if (bm) { val = bm.entry.a; key = known ? known[0] : null; src = `bank ${bm.score.toFixed(2)} - CHECK`; }
      else if (known) {
        R.noAnswer.push(`"${known[0]}" wanted by: ${info.text}`);
        R.noAnswerKeys.add(norm(qtext));
        continue;
      } else {
        R.unknown.push(`${info.required ? '*' : ' '}${info.tag}: ${info.text}`);
        R.unknownLabels.add(norm(qtext));
        continue;
      }
      if (!key) key = 'q:' + norm(qtext).split(' ').slice(0, 3).join('-');
      if (src) R.fromBank.push(`${qtext.slice(0, 60)} <- "${String(val).slice(0, 40)}" [${src}]`);

      // Recorded the moment a fill is attempted, so the read-back can tell the
      // difference between "not filled" and "filled and the form dropped it".
      const intent = { key, label: qtext, text: info.text, value: val, jh: info.jh, frame: fi };
      const won = () => { R.intent.push(intent); answered.add(key); };

      if (!fill) {
        R.filled.push(`${key} -> ${label(info)}${info.role === 'combobox' ? '  [dropdown]' : ''}`);
        continue;
      }

      val = String(val);
      if (info.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        const iso = answers[`${key}_iso`];
        if (!iso) { R.skipped.push(`${key}: "${val}" is not a date - add "${key}_iso": "YYYY-MM-DD" to answers.json`); R.failed.set(norm(qtext), `"${val}" is not a date - add "${key}_iso": "YYYY-MM-DD" to answers.json`); continue; }
        val = String(iso);
        intent.value = val;
      }
      try {
        if (info.tag === 'select') {
          const opts = info.options || [];
          const want = norm(val);
          const hit = opts.find(o => norm(o) === want)
                   || opts.find(o => norm(o).startsWith(want) || want.startsWith(norm(o)))
                   || (/^(yes|no)\b/.test(want) ? opts.find(o => norm(o) === (want.startsWith('yes') ? 'yes' : 'no')) : null);
          if (!hit) {
            R.skipped.push(`${key}: "${val.slice(0, 40)}" is not an option - it offers [${opts.slice(0, 8).join(', ')}]`);
            R.failed.set(norm(qtext), `the dropdown offers [${opts.slice(0, 10).join(', ')}] - none matches "${val.slice(0, 40)}"`);
            continue;
          }
          await el.selectOption({ label: hit }, { timeout: 4000 })
            .catch(() => el.selectOption(hit, { timeout: 3000 }));
          intent.value = hit;
        } else if (info.tag === 'div') {
          const ok = await fillClickToEdit(f, el, val);
          if (!ok) { R.skipped.push(`${key}: click-to-edit field would not open (${label(info)})`); R.failed.set(norm(qtext), 'the click-to-edit cell would not open'); continue; }
          R.filled.push(`${key} -> ${label(info)}  [click-to-edit]`);
          won();
          continue;
        } else if ((info.tag === 'button' || info.role === 'combobox' || info.hasPopup) && val.length <= 60) {
          const picked = await pickOption(f, el, val);
          if (!picked && answered.has(key)) continue;   // duplicate widget for a field already done
          if (picked && /\+\d/.test(picked)) {
            const m = picked.match(/\+\d+/);
            if (m) dialCode = m[0];
          }
          if (!picked && /location|address/.test(key)) {
            // retry as an autocomplete: type the leading token, take suggestion 1
            const token = val.split(',')[0].trim();
            await el.click({ timeout: 3000 }).catch(() => {});
            await el.fill('').catch(() => {});
            await el.type(token, { delay: 90 }).catch(() => {});
            await page.waitForTimeout(1600);
            const sug = f.locator('[role=option]:visible, [role=listbox] li:visible, ' +
                                  '[class*=autocomplete] li:visible, [class*=suggestion]:visible').first();
            if (await sug.count().catch(() => 0)) {
              const t = ((await sug.innerText().catch(() => '')) || '').trim();
              await sug.click({ timeout: 3000 }).catch(() => {});
              intent.value = t || val;
              R.filled.push(`${key} -> ${label(info)}  [autocomplete "${t.slice(0, 40)}"]`);
              won();
              continue;
            }
          }
          if (!picked) {
            R.skipped.push(`${key}: no option matching "${val}" in ${label(info)} - choose it yourself`);
            R.failed.set(norm(qtext), `no option on the form matches "${String(val).slice(0, 40)}"`);
            continue;
          }
          intent.value = picked;
          R.filled.push(`${key} -> ${label(info)}  [chose "${picked}"]`);
          won();
          continue;
        } else {
          // Some custom widgets (Retable's own form, Workday pickers) sit under an
          // overlay or off-screen, so a plain click times out. Scroll it in, then
          // fall back to filling without focus, then to a forced click.
          await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          try {
            await el.click({ timeout: 5000 });
          } catch {
            await el.click({ timeout: 4000, force: true }).catch(() => {});
          }
          try {
            await el.fill(val, { timeout: 5000 });
          } catch {
            // last resort: set the value and fire the events a framework listens for
            await el.evaluate((n, v) => {
              const setter = Object.getOwnPropertyDescriptor(
                n instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                                                 : HTMLInputElement.prototype, 'value').set;
              setter.call(n, v);
              n.dispatchEvent(new Event('input', { bubbles: true }));
              n.dispatchEvent(new Event('change', { bubbles: true }));
            }, val);
          }
          if (key === 'phone') phoneField = { el, info };
        }
        R.filled.push(`${key} -> ${label(info)}${src ? '  [' + src + ']' : ''}`);
        won();
      } catch (e) {
        R.skipped.push(`could not fill ${key} (${info.text}): ${e.message.split('\n')[0]}`);
        R.failed.set(norm(qtext), e.message.split('\n')[0].slice(0, 120));
      }
      await page.waitForTimeout(T.tick);
    }
  }

  // A widget may be skipped before its twin succeeds, so filter at the end
  // rather than relying on DOM order.
  R.skipped = R.skipped.filter(m => ![...answered].some(k => m.startsWith(k + ':')));

  if (fill && dialCode && phoneField) {
    const intl = String(answers.phone || '');
    if (intl.replace(/\s/g, '').startsWith(dialCode)) {
      // strip the dial code the selector already supplies
      const national = answers.phone_national ||
                       intl.replace(/\s/g, '').slice(dialCode.length).replace(/^0*/, '');
      try {
        await phoneField.el.fill(national, { timeout: 4000 });
        R.filled = R.filled.map(x => x.startsWith('phone ->')
          ? `${x}  [${dialCode} is in the selector, so the number went in as "${national}"]` : x);
      } catch {
        R.skipped.push(`phone: selector already holds ${dialCode} - remove it from the number yourself`);
      }
    }
  }
  return R;
}

function report(R) {
  const show = (t, a) => { if (a.length) { console.log(`\n${t} (${a.length})`); a.forEach(x => console.log('   ' + x)); } };
  show(R.fillMode ? 'FILLED' : 'WOULD FILL', R.filled);
  show('FILE UPLOADS on this page - press u', R.files);
  show('YOURS TO DECIDE (checkbox/radio/prefilled)', R.skipped);
  show('RECOGNISED, NO ANSWER - add these keys to answers.json', R.noAnswer);
  show('UNRECOGNISED (* = required)', R.unknown);
  // Bank answers are reused judgement, not stored facts, so they get their own
  // heading rather than blending into FILLED.
  show('FROM THE ANSWER BANK - a question answered before', R.fromBank);
  if (!R.filled.length && !R.unknown.length && !R.skipped.length) console.log('\nno form fields found on this page');
}

/* -------------------------------------------------------------- credentials */
// Passwords live in the openssl-encrypted vault (bin/creds), never in this file
// and never in answers.json. bin/creds prompts for the master passphrase on
// /dev/tty, so export JOBHUNT_KEY first if you would rather not retype it.
function creds(args) {
  rl.pause();
  const r = spawnSync(join(ROOT, 'bin', 'creds'), args,
                      { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  rl.resume();
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

// Click a control by its visible text, anywhere in any frame. Deliberately NOT
// wired to submit: `submit()` keeps its own captcha check and --submit gate, and
// this refuses the words that would bypass them.
// Clicking a button that is plainly on screen fails for three different reasons and
// Playwright reports all three as "Timeout 6000ms exceeded". Workday's Create Account
// is the case that cost an afternoon: enabled, visible, in the viewport, and sitting
// under a transparent overlay div, so the pointer event never reached it.
//
// The ladder: ordinary click, then clear what is on top of it, then activate it from
// the keyboard. That last step is how a keyboard user presses a button - a real focus
// and a real Enter on the real element - not a synthetic event and not a disguise.
async function clickHard(f, el, label = '') {
  await el.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
  let err = '';
  await el.click({ timeout: 4000 }).catch(e => { err = e.message.split('\n')[0].slice(0, 120); });
  if (!err) return { ok: true, how: 'click' };

  // Who is on top? A fixed banner or a leftover modal backdrop is removable; a real
  // piece of the page is not, and is worth naming in the report instead.
  const cover = await el.evaluate(n => {
    const r = n.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || top === n || n.contains(top)) return null;
    const st = getComputedStyle(top);
    const tr = top.getBoundingClientRect();
    const txt = (top.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const consentish = /cookie|consent|gdpr|privacy|banner|overlay|backdrop|modal|dialog/i;
    const cls = typeof top.className === 'string' ? top.className : '';
    const looksRemovable =
      (st.position === 'fixed' || st.position === 'absolute')
      && (consentish.test(cls) || consentish.test(top.id || '') || consentish.test(txt)
          || (tr.width >= innerWidth * 0.9 && tr.height >= innerHeight * 0.9));
    if (looksRemovable) { top.setAttribute('data-jh-cover', '1'); }
    return { tag: top.tagName.toLowerCase(), cls: cls.slice(0, 60), txt, looksRemovable,
             pos: st.position, z: st.zIndex };
  }).catch(() => null);

  if (cover && cover.looksRemovable) {
    await dismissBanners();
    await el.click({ timeout: 2500 }).catch(e => { err = e.message.split('\n')[0].slice(0, 120); });
    let stillThere = await f.locator('[data-jh-cover]').count().catch(() => 0);
    if (stillThere) {
      // Take it out of the way rather than clicking blind through it. Only ever a
      // banner or a stale backdrop reaches this line, and only for this one click.
      await f.evaluate(() => document.querySelectorAll('[data-jh-cover]').forEach(n => {
        n.setAttribute('data-jh-hid', n.style.pointerEvents || '');
        n.style.pointerEvents = 'none';
      })).catch(() => {});
      err = '';
      await el.click({ timeout: 2500 }).catch(e => { err = e.message.split('\n')[0].slice(0, 120); });
      await f.evaluate(() => document.querySelectorAll('[data-jh-cover]').forEach(n => {
        n.style.pointerEvents = n.getAttribute('data-jh-hid') || '';
        n.removeAttribute('data-jh-hid'); n.removeAttribute('data-jh-cover');
      })).catch(() => {});
      if (!err) return { ok: true, how: `clicked after neutralising a ${cover.tag} overlay covering it` };
    } else if (!err) {
      return { ok: true, how: 'clicked after dismissing the banner on top of it' };
    }
  }

  // Keyboard activation. Focus the element and press Enter: the same path a person
  // tabbing through the form takes, and it does not care what is painted on top.
  const gate = await captchaGate(f, el);
  if (gate) {
    return { ok: false, captcha: true,
             why: `it is behind ${gate} - an invisible captcha, not a bug. `
                + `Nothing is sent when it is pressed automatically. Click it in the window yourself.` };
  }
  const focused = await el.evaluate(n => { n.focus(); return document.activeElement === n; }).catch(() => false);
  if (focused) {
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(700);
    return { ok: true, how: 'activated from the keyboard - something was covering it'
                           + (cover ? ` (<${cover.tag} class="${cover.cls}">)` : '') };
  }

  return { ok: false, why: err + (cover ? ` - covered by <${cover.tag} class="${cover.cls}"> "${cover.txt}"` : '') };
}

// Workday wraps its account-creation and submit buttons in an invisible captcha:
// <div data-automation-id="noCaptchaWrapper"> containing a transparent
// <div data-automation-id="click_filter"> laid over the real button. The filter
// intercepts the pointer event and decides whether the interaction looks human, so
// an automated press is swallowed with no error, no aria-invalid, and - confirmed
// on the wire - no request sent at all. There is nothing to fix and nothing to work
// around: it is a bot check, and the standing rule is that Arion clicks it.
async function captchaGate(f, el) {
  return await el.evaluate(n => {
    const near = n.closest('[data-automation-id]');
    const wrap = n.closest('[data-automation-id="noCaptchaWrapper"]')
              || (near && near.querySelector('[data-automation-id="click_filter"]'))
              || document.querySelector('[data-automation-id="click_filter"]');
    if (wrap) return 'workday click_filter / noCaptchaWrapper';
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, [data-sitekey]')) {
      return 'a reCAPTCHA/hCaptcha on the page';
    }
    return null;
  }).catch(() => null);
}

const NEVER_CLICK = /^(submit|submit application|send application|apply and submit|confirm and submit)$/i;
async function clickText(want) {
  want = String(want).trim();
  if (!want) { console.log('usage: click:<visible text>'); return false; }
  if (NEVER_CLICK.test(want)) {
    console.log(`"${want}" is the submit button - use x, which checks the captcha and the --submit flag.`);
    return false;
  }
  for (const f of frames()) {
    const hit = await f.evaluate((w) => {
      const norm = t => (t || '').replace(/\s+/g, ' ').trim();
      let best = null;
      for (const n of document.querySelectorAll('a, button, [role=button], input[type=button], [role=link], ukg-button, *[class*=btn], *[class*=button]')) {
        const t = norm(n.innerText || n.value);
        if (!t || t.toLowerCase() !== w.toLowerCase()) continue;
        const r = n.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (!best || best.contains(n)) best = n;    // innermost match wins
      }
      if (!best) return null;
      best.setAttribute('data-jh-click', '1');
      return norm(best.innerText || best.value);
    }, want).catch(() => null);
    if (!hit) continue;
    const before = page.url();
    const outcome = await clickHard(f, f.locator('[data-jh-click]').first(), want);
    await f.evaluate(() => document.querySelectorAll('[data-jh-click]')
                                   .forEach(n => n.removeAttribute('data-jh-click'))).catch(() => {});
    if (!outcome.ok) { console.log(`could NOT click "${want}": ${outcome.why}`); return false; }
    if (outcome.how !== 'click') console.log(`   (${outcome.how})`);
    await f.evaluate(() => document.querySelectorAll('[data-jh-click]')
                                   .forEach(n => n.removeAttribute('data-jh-click'))).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await formReady(5000);
    console.log(`clicked "${hit}"${page.url() !== before ? ` -> ${page.url().slice(0, 90)}` : ''}`);
    return true;
  }
  console.log(`no clickable "${want}" on this page`);
  return false;
}

// Vault key for the current page. Real ATSes always have a hostname; the
// pathname fallback only matters for the file:// practice pages.
function hostOf(u = page.url()) {
  try { const x = new URL(u); return x.hostname || x.pathname.split('/').pop(); }
  catch { return '?'; }
}

async function passwordFields(f) {
  const all = await f.locator('input[type=password]').all();
  const vis = [];
  for (const el of all) if (await el.isVisible().catch(() => false)) vis.push(el);
  return vis;
}

async function emailField(f) {
  for (const sel of ['input[type=email]', 'input[name*=mail i]', 'input[id*=mail i]',
                     'input[name*=user i]', 'input[id*=user i]', 'input[type=text]']) {
    const els = await f.locator(sel).all();
    for (const el of els) if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function clickIfFound(f, re) {
  for (const sel of ['button', 'input[type=submit]', 'a[role=button]']) {
    for (const el of await f.locator(sel).all()) {
      if (!await el.isVisible().catch(() => false)) continue;
      const t = ((await el.getAttribute('value')) || (await el.innerText().catch(() => '')) || '').trim();
      if (re.test(t)) {
        const out = await clickHard(f, el, t);
        if (!out.ok) {
          console.log(`could not press "${t}": ${out.why}`);
          // Distinguish "the button is not here" from "the button is here and gated".
          // Reporting a captcha-gated button as missing sends the next reader looking
          // for the wrong thing entirely.
          return out.captcha ? { gated: t } : null;
        }
        if (out.how !== 'click') console.log(`   (${out.how})`);
        return t;
      }
    }
  }
  return null;
}

async function signIn() {
  const host = hostOf();
  let raw = creds(['get', host, '--json']);
  let from = host;
  if (!raw) {
    // An ATS on a shared identity provider logs you in on a different hostname
    // from the one the job lives on, so the vault entry is under that one.
    const dump = creds(['export']);
    if (dump) {
      try {
        const db = JSON.parse(dump);
        const hit = Object.entries(db).find(([h, r]) =>
          (r.note || '').includes(rec.slug) || (r.note || '').includes(rec.company))
          || Object.entries(db).find(([h]) => {
            const a = h.split('.').slice(-2).join('.'), b = host.split('.').slice(-2).join('.');
            return a === b;
          });
        if (hit) { raw = JSON.stringify(hit[1]); from = hit[0]; }
      } catch {}
    }
  }
  if (!raw) {
    console.log(`\nNo stored credentials for ${host}.`);
    console.log(`  existing account:  bin/creds set ${host}`);
    console.log(`  no account yet:    press n to register one`);
    return;
  }
  if (from !== host) console.log(`   using the vault entry for ${from} (this ATS signs in there)`);
  const { email, password } = JSON.parse(raw);
  for (const f of frames()) {
    const pws = await passwordFields(f);
    if (!pws.length) continue;
    const em = await emailField(f);
    if (em) { await em.click(); await em.fill(email); }
    await pws[0].click(); await pws[0].fill(password);
    console.log(`\nfilled ${email} + password for ${host}`);
    let clicked = await clickIfFound(f, /^(sign ?in|log ?in|continue)$/i);
    if (!clicked) {
      for (const t of ['Sign in', 'Log in', 'Continue', 'Sign In', 'Login']) {
        if (await clickText(t)) { clicked = t; break; }
      }
    }
    console.log(clicked ? `clicked "${clicked}"` : 'no sign-in button found - click it yourself');
    await page.waitForTimeout(3000);
    return;
  }
  console.log('no password field on this page - is this the sign-in page?');
}

// A form that refuses to advance and shows nothing in the field report is the
// hardest case to debug blind: the report only knows about controls, so a validation
// banner, an "account already exists" line or a disabled-button explanation is
// invisible to it. Dump what a human would read instead.
async function dumpText() {
  for (const f of frames()) {
    const t = await f.evaluate(() => {
      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
      const out = [];
      const walk = n => {
        if (n.nodeType === 3) {
          const v = n.nodeValue.replace(/\s+/g, ' ').trim();
          if (v) out.push(v);
          return;
        }
        if (n.nodeType !== 1 || skip.has(n.tagName)) return;
        const st = getComputedStyle(n);
        if (st.display === 'none' || st.visibility === 'hidden') return;
        for (const c of n.childNodes) walk(c);
      };
      walk(document.body);
      return out.join(' | ');
    }).catch(() => '');
    if (t) console.log(t.slice(0, 4000));
  }
}

// Some widgets only commit on blur, and some buttons only enable once a field has
// fired its own key handlers. A synthetic fill() does neither.
async function pressKey(key) {
  key = (key || '').trim();
  if (!key) { console.log('usage: press:<key>'); return; }
  await page.keyboard.press(key).catch(e => console.log(`press failed: ${e.message.split('\n')[0]}`));
  await page.waitForTimeout(600);
  console.log(`pressed ${key}`);
}

// Playwright's fill() sets the value and dispatches one input event. Some frameworks
// - Workday's account form among them - keep their own state and only trust the key
// handlers, so a filled field looks right on screen while the form still believes it
// is empty and leaves its submit button unactionable. Typing is ordinary browser use,
// not a disguise: same browser, same events a person's keyboard produces.
async function typeInto(spec, val) {
  const want = norm(spec);
  for (const v of await inspectAll({ withSections: false })) {
    const hits = v.controls.filter(c => c.visible && norm(c.label || c.text).startsWith(want));
    if (!hits.length) continue;
    const c = hits.find(h => !h.value.trim()) || hits[0];
    const el = v.f.locator(`[data-jh="${c.jh}"]`).first();
    await el.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
    await el.click({ timeout: 4000 }).catch(() => {});
    await el.press('ControlOrMeta+a').catch(() => {});
    await el.press('Delete').catch(() => {});
    await el.type(val, { delay: 45 }).catch(e => console.log(`   (${e.message.split('\n')[0].slice(0, 80)})`));
    await page.waitForTimeout(250);
    const now = await el.inputValue().catch(() => '');
    console.log(`typed into "${c.label}" (${now.length} chars now in the field)`);
    return true;
  }
  console.log(`no field whose label starts with "${spec}"`);
  return false;
}

// "Timeout exceeded" on a button you can see is three different bugs wearing one
// message: disabled, covered by something, or still animating. Playwright will not
// say which, so ask the page directly - including what is actually on top at the
// point the click would land.
async function whyNotClickable(want) {
  for (const f of frames()) {
    const info = await f.evaluate((w) => {
      const norm = t => (t || '').replace(/\s+/g, ' ').trim();
      let best = null;
      for (const n of document.querySelectorAll('a, button, [role=button], input[type=button], [role=link]')) {
        const t = norm(n.innerText || n.value);
        if (t && t.toLowerCase() === w.toLowerCase()) best = n;
      }
      if (!best) return null;
      const r = best.getBoundingClientRect();
      const st = getComputedStyle(best);
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const desc = n => n ? `<${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}>` : 'nothing';
      return {
        tag: best.tagName.toLowerCase(),
        type: best.getAttribute('type') || '',
        disabled: best.disabled === true,
        ariaDisabled: best.getAttribute('aria-disabled'),
        pointerEvents: st.pointerEvents,
        visibility: st.visibility,
        opacity: st.opacity,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        inViewport: r.top >= 0 && r.bottom <= innerHeight,
        onTopAtCentre: desc(top),
        isSelfOrChild: !!top && (top === best || best.contains(top)),
        form: best.form ? desc(best.form) : 'none',
      };
    }, want).catch(() => null);
    if (!info) continue;
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(`no element labelled "${want}"`);
}

// A Workday application is seven pages and the only thing between them is a Next
// button. Clicking it by hand seven times per application, on every application, is
// the single biggest remaining manual cost - and it is not a judgement call, unlike
// submit. Next advances; Submit still never happens here.
const NEXT_LABEL = /^(next|continue|save and continue|save & continue|save and next|proceed|start|begin|get started|next step|review)$/i;
async function nextPage({ thenFill = true } = {}) {
  for (const f of frames()) {
    const hit = await f.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const norm = t => (t || '').replace(/\s+/g, ' ').trim();
      for (const n of document.querySelectorAll('button, [role=button], a[role=button], input[type=button]')) {
        const t = norm(n.innerText || n.value);
        if (!t || !re.test(t)) continue;
        const r = n.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        n.setAttribute('data-jh-next', '1');
        return t;
      }
      return null;
    }, NEXT_LABEL.source).catch(() => null);
    if (!hit) continue;
    if (NEVER_CLICK.test(hit)) { console.log(`"${hit}" is the submit button - use x`); return false; }
    const before = page.url();
    // A wizard that never changes its URL is the normal case, not the exception
    // (Workday, Greenhouse, most SPAs). Fingerprint what the page is asking, so
    // "did it advance" is a real question rather than a guess about the address bar.
    const fingerprint = async () => (await page.evaluate(() => {
      const t = [];
      for (const n of document.querySelectorAll('h1, h2, h3, legend, label, [data-automation-id*=title]')) {
        const s = (n.innerText || '').replace(/\s+/g, ' ').trim();
        if (s) t.push(s.slice(0, 60));
        if (t.length > 25) break;
      }
      return t.join('|');
    }).catch(() => ''));
    const printBefore = await fingerprint();
    const out = await clickHard(f, f.locator('[data-jh-next]').first(), hit);
    await f.evaluate(() => document.querySelectorAll('[data-jh-next]')
                                   .forEach(n => n.removeAttribute('data-jh-next'))).catch(() => {});
    if (!out.ok) { console.log(`could not press "${hit}": ${out.why}`); return false; }
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await formReady(6000);
    console.log(`pressed "${hit}"${page.url() !== before ? ` -> ${page.url().slice(0, 90)}` : ''}`
                + (out.how !== 'click' ? ` (${out.how})` : ''));
    const moved = page.url() !== before || (await fingerprint()) !== printBefore;
    // A page that refuses to advance has usually rejected a field. Say which.
    if (!moved) { console.log('the page did not change - it has not accepted this step yet'); await whyStuck(); }
    else if (thenFill) await fillPage('next');
    return true;
  }
  console.log('no Next/Continue button on this page');
  return false;
}

// The other half of "it will not advance": the button worked, the page validated,
// and something on it is still wrong. Read the page's own error text back, and list
// what is required and empty, instead of leaving Claude to guess from a timeout.
async function whyStuck() {
  let found = 0;
  for (const f of frames()) {
    const out = await f.evaluate(() => {
      const clean = t => (t || '').replace(/\s+/g, ' ').trim();
      const errs = new Set();
      for (const n of document.querySelectorAll('[role=alert], [aria-live=assertive], [aria-live=polite], [class*=error], [class*=Error], [data-automation-id*=error]')) {
        const st = getComputedStyle(n);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const t = clean(n.innerText);
        // Workday marks its "current step 3 of 7" progress indicator aria-live, so a
        // naive sweep reports the breadcrumb as seven separate error messages.
        if (!t || t.length >= 300) continue;
        if (/^(current )?step \d+ of \d+$/i.test(t)) continue;
        errs.add(t);
      }
      const empty = [];
      for (const n of document.querySelectorAll('input:not([type=hidden]):not([type=submit]), textarea, select, [contenteditable=true]')) {
        const req = n.required || n.getAttribute('aria-required') === 'true';
        if (!req) continue;
        const r = n.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const v = n.isContentEditable ? clean(n.innerText) : clean(n.value);
        if (v) continue;
        let lab = '';
        if (n.id) { const l = document.querySelector(`label[for="${CSS.escape(n.id)}"]`); if (l) lab = clean(l.innerText); }
        if (!lab) lab = clean(n.getAttribute('aria-label') || n.name || n.placeholder);
        empty.push(lab || '(unlabelled)');
      }
      const invalid = [...document.querySelectorAll('[aria-invalid=true]')].map(n =>
        clean(n.getAttribute('aria-label') || n.name || n.id)).filter(Boolean);
      return { errs: [...errs], empty, invalid };
    }).catch(() => null);
    if (!out) continue;
    if (out.errs.length) { console.log(`page says: ${out.errs.join(' // ')}`); found++; }
    if (out.empty.length) { console.log(`required and still empty: ${out.empty.join(' | ')}`); found++; }
    if (out.invalid.length) { console.log(`marked invalid: ${out.invalid.join(' | ')}`); found++; }
  }
  if (!found) console.log('no error text and nothing required left empty - the page is not complaining');
}

// What the page sent and what came back. The refusal that never reaches the DOM
// almost always reaches the network tab.
function showNet() {
  if (!netLog.length && !conLog.length) { console.log('nothing logged yet - do the thing first, then run net'); return; }
  for (const e of netLog.slice(-25)) {
    console.log(`${e.when}  ${String(e.status).padEnd(6)} ${e.method.padEnd(5)} ${e.url}`);
    if (e.body) console.log(`        ${e.body.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  if (conLog.length) {
    console.log('--- console ---');
    for (const c of conLog.slice(-15)) console.log(`  ${c}`);
  }
}

// The markup itself, for the cases where the interesting part is an attribute:
// a data-automation-id, an aria-describedby pointing at an error node that is not
// rendered, a hidden input carrying a token, a button wired to nothing.
async function dumpDom(want) {
  const norm = t => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const f of frames()) {
    const out = await f.evaluate((w) => {
      const clean = t => (t || '').replace(/\s+/g, ' ').trim();
      const wl = w.toLowerCase();
      // Ranked, because a progress-bar <label> reading "Create Account/Sign In"
      // otherwise wins over the button actually called Create Account.
      let target = null;
      for (const sel of ['button, [role=button], input[type=submit]', 'input, textarea, select', 'a', 'label']) {
        let exact = null, prefix = null;
        for (const n of document.querySelectorAll(sel)) {
          const t = clean(n.innerText || n.value || n.getAttribute('aria-label') || '').toLowerCase();
          if (!t) continue;
          if (t === wl) { exact = n; break; }
          if (!prefix && t.startsWith(wl)) prefix = n;
        }
        target = exact || prefix;
        if (target) break;
      }
      if (!target) return null;
      // The form (or nearest sizeable container) is the useful unit, not one tag.
      const scope = target.closest('form') || target.closest('section,div[class],main') || target.parentElement;
      const attrs = n => [...n.attributes].map(a => `${a.name}="${a.value.slice(0, 80)}"`).join(' ');
      const hidden = [...scope.querySelectorAll('input[type=hidden], input[aria-hidden=true], [style*="display: none"] input')]
        .map(n => `  <input ${attrs(n)}>`);
      const auto = [...scope.querySelectorAll('[data-automation-id]')]
        .slice(0, 40).map(n => `  ${n.tagName.toLowerCase()} [${n.getAttribute('data-automation-id')}] "${clean(n.innerText).slice(0, 50)}"`);
      return {
        target: `<${target.tagName.toLowerCase()} ${attrs(target)}>`,
        scopeTag: `<${scope.tagName.toLowerCase()} ${attrs(scope)}>`,
        html: scope.outerHTML.slice(0, 3500),
        hidden, auto,
      };
    }, want).catch(() => null);
    if (!out) continue;
    console.log(`target:  ${out.target}`);
    console.log(`inside:  ${out.scopeTag}`);
    if (out.auto.length) { console.log('data-automation-ids:'); out.auto.forEach(l => console.log(l)); }
    if (out.hidden.length) { console.log('hidden inputs:'); out.hidden.forEach(l => console.log(l)); }
    console.log('--- markup ---');
    console.log(out.html);
    return;
  }
  console.log(`nothing labelled "${want}"`);
}

async function register() {
  const host = hostOf();
  // bin/creds takes the key from $JOBHUNT_KEY, then ~/.jobhunt-key, then a prompt.
  // Only the last of those needs a terminal, so only that case can fail here - and
  // failing here would mean printing the generated password into a log instead of
  // storing it.
  const canSave = !!process.env.JOBHUNT_KEY
    || existsSync(join(process.env.HOME || '', '.jobhunt-key'))
    || process.stdin.isTTY;
  if (!canSave) {
    console.log(`\nRefusing to register with no way to save the password.`);
    console.log(`No $JOBHUNT_KEY, no ~/.jobhunt-key, and no terminal to prompt on - the`);
    console.log(`generated password could only be printed, into a log file.`);
    console.log(`Run any bin/creds command once to create the key file, then retry.`);
    return;
  }
  const pw = creds(['gen']);
  if (!pw) { console.log('could not generate a password'); return; }
  const email = answers.email;

  let done = false;
  for (const f of frames()) {
    const pws = await passwordFields(f);
    if (!pws.length) continue;
    const em = await emailField(f);
    if (em) { await em.click(); await em.fill(email); }
    for (const box of pws) { await box.click(); await box.fill(pw); }  // password + confirm
    console.log(`\nfilled ${email} and a generated password into ${pws.length} field(s)`);
    done = true;
    break;
  }
  if (!done) { console.log('no password field here - open the registration form first'); return; }

  // Save BEFORE submitting: an account whose password was never stored is worse
  // than a registration that has to be retried.
  const saved = creds(['set', host, '--email', email, '--password', pw,
                       '--note', `${rec.company} (${rec.slug})`]);
  console.log(saved ? `saved to the vault under ${host}` :
              `COULD NOT SAVE - write this down before continuing: ${pw}`);

  // Other registration pages want name/address too.
  report(await scan({ fill: true }));

  // Press the button too. Creating an account on an employer's careers site is
  // ordinary automation of Arion's own account - his standing instruction
  // (2026-09-30) is that this whole step is Claude's, not his. The application's
  // own Submit is a different thing entirely and is still opt-in.
  await tickConsentForRegistration();
  const CREATE = /^(create account|register|sign up|create my account|continue)$/i;
  let pressed = null;
  for (const f of frames()) { pressed = await clickIfFound(f, CREATE); if (pressed) break; }
  if (pressed && pressed.gated) {
    console.log(`\nEverything is filled. "${pressed.gated}" is behind an invisible captcha,`);
    console.log(`so it is Arion's click - the one step of a registration that cannot be automated.`);
    console.log(`The password is already saved in the vault, so the account is usable once created.`);
    return;
  }
  if (!pressed) { console.log('\nno create/register button found - press it in the window'); return; }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await formReady(6000);
  console.log(`pressed "${pressed}"`);
  await whyStuck();
  console.log(`
If it did not advance, the line above says why. Most ATSes now email a verification
link - ask Claude to find it in Gmail. Captchas remain yours.`);
}

// Registration pages put the terms checkbox on the same page as the password, and
// an unticked one is the commonest reason Create Account does nothing. Ticking a
// terms box to open an account is part of opening the account; it is not the
// application's own consent step, which tickConsent handles during a fill.
async function tickConsentForRegistration() {
  for (const f of frames()) {
    const n = await f.evaluate(() => {
      const RE = /terms|privacy|agree|consent|acknowledge|i have read/i;
      let n = 0;
      for (const b of document.querySelectorAll('input[type=checkbox]')) {
        if (b.checked || b.disabled) continue;
        const r = b.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const near = (b.closest('label') || b.parentElement || {}).innerText || '';
        const lab = b.id ? (document.querySelector(`label[for="${CSS.escape(b.id)}"]`) || {}).innerText || '' : '';
        if (!RE.test(near + ' ' + lab)) continue;
        b.setAttribute('data-jh-terms', '1'); n++;
      }
      return n;
    }).catch(() => 0);
    if (!n) continue;
    for (const el of await f.locator('[data-jh-terms]').all()) await el.check({ timeout: 2500 }).catch(() => {});
    await f.evaluate(() => document.querySelectorAll('[data-jh-terms]')
                                   .forEach(x => x.removeAttribute('data-jh-terms'))).catch(() => {});
    console.log(`   ticked ${n} terms/consent box(es) to create the account`);
  }
}

/* ----------------------------------------------------------------- otp code */
// Greenhouse (and others) verify a human by emailing an 8-character code, shown
// as one box per character. Fill them one char at a time; widgets that
// auto-advance get a single sequential type instead.
async function fillCode(code) {
  code = String(code).trim();
  if (!code) { console.log('no code given'); return false; }
  for (const f of frames()) {
    const boxes = [];
    for (const el of await f.locator('input:not([type=hidden])').all()) {
      let d;
      try {
        if (!await el.isVisible({ timeout: 300 })) continue;
        d = await describe(el);
      } catch { continue; }
      const ml = await el.getAttribute('maxlength').catch(() => null);
      const isOtp = ml === '1' ||
                    /security code|verification code|one[- ]time|\bcode\b/i.test(d.text);
      if (isOtp) boxes.push({ el, single: ml === '1' });
    }
    if (!boxes.length) continue;

    if (boxes.length >= code.length && boxes[0].single) {
      for (let i = 0; i < code.length; i++) {
        await boxes[i].el.click({ timeout: 3000 }).catch(() => {});
        await boxes[i].el.fill(code[i], { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(80);
      }
    } else {
      await boxes[0].el.click({ timeout: 3000 });
      await boxes[0].el.fill('', { timeout: 3000 }).catch(() => {});
      await boxes[0].el.type(code, { delay: 90 });
    }
    console.log(`entered security code into ${Math.min(boxes.length, code.length)} field(s)`);
    return true;
  }
  console.log('no security-code field found on this page');
  return false;
}

// Interacting with a dropdown re-renders the form, which invalidates the element
// handles captured for the rest of the pass - so one pass is never enough. The old
// answer was to simply scan the whole form twice, which doubled the cost of every
// application to fix a handful of fields. Now the read-back says which fields
// actually failed and only those are retried, which is both quicker and the only
// version that knows whether the retry worked.
async function fillAndRepair({ between = null } = {}) {
  await dbgTrig('scan start');
  const R = await timed('fill pass', () => scan({ fill: true }));
  // Uploads go here, between the fill and the read-back. Not before the fill:
  // Greenhouse and others parse the CV and populate name/email/education from it,
  // and those fields would then read as "already filled" - leaving the parser's
  // guesses in place instead of the answers Arion checked. Not after the read-back
  // either: attaching swaps the file input for an "attached" widget, so a
  // read-back taken first describes a page that no longer exists.
  if (between) await between();
  let a = await timed('read-back', () => assess(R));

  const retryable = f => f.status === 'mismatch' || f.status === 'empty_required';
  let rounds = Number(flag('rounds') || 2);
  if (process.env.JOBHUNT_ONE_PASS) rounds = 1;
  for (let i = 1; i < rounds; i++) {
    const bad = new Set(a.fields.filter(retryable).map(f => norm(f.label)));
    if (!bad.size) break;
    const B = await timed(`repair pass ${i} (${bad.size} field${bad.size > 1 ? 's' : ''})`,
                          () => scan({ fill: true, only: bad, noScroll: true }));
    // Repair intents win; the first pass keeps everything the repair did not touch.
    const byLabel = new Map(R.intent.map(it => [norm(it.label), it]));
    for (const it of B.intent) byLabel.set(norm(it.label), it);
    R.intent = [...byLabel.values()];
    for (const line of B.filled) {
      if (!R.filled.some(x => x.split(' -> ')[0] === line.split(' -> ')[0])) R.filled.push(line + `  [pass ${i + 1}]`);
    }
    R.skipped = [...R.skipped.filter(m => !/already filled/.test(m)), ...B.skipped];
    R.fromBank.push(...B.fromBank);
    // A field the repair pass DID fill is no longer a failure, whatever the first
    // pass thought of it.
    R.failed = new Map([...R.failed, ...B.failed]
      .filter(([l]) => !B.intent.some(it => norm(it.label) === l)));
    const after = await timed(`read-back ${i + 1}`, () => assess(R));
    // Give up rather than loop if a round fixed nothing - a field the form keeps
    // rejecting is a decision for Arion, not something to retry harder.
    if (after.fields.filter(retryable).length >= a.fields.filter(retryable).length) { a = after; break; }
    a = after;
  }
  R.skipped = [...new Set(R.skipped.filter(m => !/already filled/.test(m)))];
  return { R, a };
}

// One way in for "fill the page that is on screen", so --auto, the f key and the
// hold loop all produce the same artefacts: a terminal report for Arion, and a
// session.json plus a screenshot for Claude.
let lastFill = null;

// Report without touching anything. Same artefacts as a fill, so the recon pass
// on an unfamiliar ATS is readable by Claude rather than being prose Arion has to
// relay back.
async function reconPage() {
  const R = await timed('recon scan', () => scan({ fill: false }));
  report(R);
  const a = await timed('read-back', () => assess(R));
  blockerReport(a);
  const st = await timed('state + screenshot', () => writeState('recon', a));
  await writeAsks(a);
  console.log(`\nstate:      ${STATE.replace(ROOT + '/', '')}`
    + (st.screenshot ? `\nscreenshot: ${st.screenshot}` : ''));
  timingReport();
  return { R, a };
}

async function fillPage(stage = 'fill', opts = {}) {
  const { R, a } = await fillAndRepair(opts);
  lastFill = R;
  report(R);
  if (R.passwords) console.log(`\n(${R.passwords} password field(s) deliberately untouched)`);
  printReadback(a);
  blockerReport(a);
  const st = await timed('state + screenshot', () => writeState(stage, a));
  const asks = await writeAsks(a);
  const rel = pth => pth.replace(ROOT + '/', '');
  console.log(`\nstate:      ${rel(STATE)}${st.screenshot ? `\nscreenshot: ${st.screenshot}` : ''}`);
  if (asks.length) {
    console.log(`\nClaude can answer these without anyone retyping the form:`);
    for (const q of asks) console.log(`   ${q.id}  [${q.status}] ${q.label.slice(0, 64)}`);
    console.log(`   echo 'answer:${asks[0].id}:<text>' > ${rel(join(rec.dir, '.session-cmd'))}`);
  }
  timingReport();
  return { R, a };
}

/* -------------------------------------------------------------------- submit */
// Only reachable with --submit. Deliberately not the default: a misfired
// application to a real employer cannot be taken back.
async function submit() {
  if (!has('submit')) {
    console.log('\nSubmit is off. Re-run with --submit to enable it, or click it yourself.');
    return;
  }
  // The discipline "check the counts agree before you submit" only held when
  // someone remembered to do it, and the one time it was not done the form went
  // in with 8 of 15 questions blank. So it is a gate now, not a habit. --force
  // is there because an employer's own form is occasionally wrong about what it
  // requires, and that judgement is Arion's.
  const a = await assess(lastFill);
  if (a.blockers.length && !has('force')) {
    console.log(`\nNOT SUBMITTING - ${a.blockers.length} field(s) unresolved:`);
    for (const f of a.blockers) console.log(`   [${f.status}] ${f.required ? '* ' : ''}${f.label.slice(0, 70)}`);
    console.log('\nFix them (f to re-fill, or answer them in the window), then press x again.');
    console.log('If the form is wrong about what it needs, re-run with --force.');
    await writeState('submit-blocked', a);
    await writeAsks(a);
    return;
  }
  for (const f of frames()) {
    const captcha = await f.locator('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey], iframe[src*="hcaptcha"]')
                           .count().catch(() => 0);
    if (captcha) {
      console.log('\nThis form has a captcha. Solve it yourself, then press x again.');
      const solved = await f.locator('textarea[name="g-recaptcha-response"]')
                            .inputValue().catch(() => '');
      if (!solved) return;
    }
  }
  for (const f of frames()) {
    const t = await clickIfFound(f, /^(submit|submit application|send application|apply)$/i);
    if (t) {
      console.log(`\nclicked "${t}"`);
      await page.waitForTimeout(4000);
      await writeState('submitted', await assess(null), { submitted_at: new Date().toISOString() });
      return;
    }
  }
  console.log('\nno submit button found - click it yourself');
}

/* --------------------------------------------------------------------- loop */
// Own line queue rather than rl.question: readline emits 'close' at EOF before
// buffered lines are consumed, so a piped command list (used by the tests) would
// otherwise be dropped. Also makes Ctrl-D a clean quit instead of a crash.
const rl = readline.createInterface({ input: process.stdin });
const queued = [];
const waiting = [];
let stdinClosed = false;
rl.on('line', l => { const w = waiting.shift(); w ? w(l) : queued.push(l); });
rl.on('close', () => { stdinClosed = true; while (waiting.length) waiting.shift()('q'); });
function ask(prompt) {
  process.stdout.write(prompt);
  if (queued.length) return Promise.resolve(queued.shift());
  if (stdinClosed) return Promise.resolve('q');
  return new Promise(r => waiting.push(r));
}

console.log(`
  Application:  ${rec.company} - ${rec.role}
  CV:           ${join(ROOT, 'cv')}
  Cover letter: ${rec.dir}

  Log in, click through, solve any captcha yourself. When a form is on screen,
  press f to fill it. Nothing is submitted and no password is ever typed.

    f / Enter   fill this page       u  attach CV + cover letter
    p / next    press Next, then fill   stuck  why it will not advance
    l           sign in (stored)     n  register a new account here
    r           report only          c  enter emailed security code
    v           read the page back   a  answer one outstanding field
    x           submit (needs --submit, blocked while fields are unresolved)
    s           show answer sheet    w  bring the window on screen
    q           finish
`);

if (has('auto')) {
  console.log('--auto: filling and attaching\n');
  // Attach before the read-back, not after: uploading swaps the file input for an
  // "attached" widget, so a read-back taken first describes a page that no longer
  // exists by the time Arion looks at it.
  await fillPage('auto', { between: () => timed('attach', () => attach()) });
  await showWindow();
  if (quiet) console.log('\nwindow is now on screen - review and submit.');
}

// --hold keeps the browser open without needing a terminal, for when the session
// is started for you and you finish in the window yourself.
if (has('hold')) {
  const mins = Number(flag('hold') || 60);
  const cmdFile = join(rec.dir, '.session-cmd');
  console.log(`\nBrowser open for ${mins} minutes. Finish in the window.`);
  console.log(`Drive it by appending a line to ${cmdFile} (use >> - they queue):`);
  console.log('  code:<8-char code>       fill the emailed security code');
  console.log('  answer:<id>:<text>       answer one field from .session-ask');
  console.log('  key:<name>=<value>       set an answers.json key, then re-fill');
  console.log('  fill | attach | report | verify | quit');
  console.log('  set:<label>[#n]=<value>     change one field by name; #n picks the nth match');
  console.log('  opts:<label>                list what a dropdown actually offers');
  console.log('  skills                      apply skill-levels.json to a skills grid');
  console.log('  rmentry:<text>              delete the job/qualification entry containing <text>');
  console.log('  expand                      open every folded section, then fill');
  console.log('  click:<visible text>        click a link or button by its label');
  console.log('  shot                        screenshot + session.json, change nothing');
  console.log('  text                        print the visible page text - what an error actually says');
  console.log('  why:<visible text>          why a button will not click - disabled, covered, or moving');
  console.log('  next                        click Next/Continue on a wizard page, then fill what loads');
  console.log('  stuck                       why the page will not advance - required fields still empty');
  console.log('  net                         recent POSTs, non-2xx responses and console errors');
  console.log('  dom:<label>                 the raw markup around a field or button, hidden inputs included');
  console.log('  type:<label>=<value>        type it key by key - for a form that ignores a synthetic fill');
  console.log('  press:<key>                 send a key (Tab, Enter, Escape) to the focused element');
  console.log('  unlock:<master passphrase>  supply the vault key to a held session');
  console.log('  signin | register           (need the vault key: export it, or unlock:)');
  const until = Date.now() + mins * 60 * 1000;
  let closed = false;
  ctx.on('close', () => { closed = true; });
  page.on('close', () => { closed = true; });
  while (Date.now() < until && !closed) {
    // closing the window must end the session, not crash it
    try { await page.waitForTimeout(2000); }
    catch { closed = true; break; }
    // A queue, not a single slot. The file used to be read-and-delete, so a second
    // command written while the first was still running simply replaced it and was
    // never run - which silently dropped an `expand` mid-sequence. Take the first
    // line, put the rest back, and `>>` appends safely.
    let cmd = '';
    try {
      if (!existsSync(cmdFile)) continue;
      const lines = readFileSync(cmdFile, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) { unlinkSync(cmdFile); continue; }
      cmd = lines.shift();
      if (lines.length) writeFileSync(cmdFile, lines.join('\n') + '\n');
      else unlinkSync(cmdFile);
    } catch { continue; }
    if (!cmd) continue;
    console.log(`\n> ${cmd}`);
    const busy = join(rec.dir, '.session-busy');
    try { writeFileSync(busy, cmd + '\n'); } catch {}
    try {
    if (cmd === 'quit') { try { if (existsSync(busy)) unlinkSync(busy); } catch {}; break; }
    else if (cmd.startsWith('unlock:')) {
      // Consumed straight into the environment; the command file is unlinked the
      // moment it is read, above, so the passphrase is not left on disk.
      process.env.JOBHUNT_KEY = cmd.slice(7);
      console.log('vault unlocked for this session');
      continue;
    }
    else if (cmd.startsWith('code:')) await fillCode(cmd.slice(5));
    else if (cmd.startsWith('answer:')) {
      // answer:<id>:<text> - the reply half of the ask channel. One field, filled
      // and then read back, so Claude finds out whether its answer actually took.
      const rest = cmd.slice(7);
      const i = rest.indexOf(':');
      if (i < 0) console.log('usage: answer:<id>:<text>');
      else {
        await answerAsk(rest.slice(0, i).trim(), rest.slice(i + 1));
        const a = await assess(lastFill);
        blockerReport(a);
        await writeState('answered', a);
        await writeAsks(a);
      }
    }
    else if (cmd.startsWith('key:')) {
      // A value that will recur belongs in answers.json, not in one field.
      const eq = cmd.indexOf('=');
      if (eq < 0) console.log('usage: key:<name>=<value>');
      else {
        const k = cmd.slice(4, eq).trim(), v = cmd.slice(eq + 1);
        answers[k] = v;
        try {
          writeFileSync(answersPath, JSON.stringify(answers, null, 2) + '\n');
          console.log(`answers.json: ${k} = ${v.slice(0, 60)}`);
        } catch (e) { console.log(`could not write answers.json: ${e.message}`); }
        await fillPage('after-key');
      }
    }
    else if (cmd === 'fill') await fillPage('fill');
    else if (cmd.startsWith('set:')) {
      const eq = cmd.indexOf('=');
      if (eq < 0) console.log('usage: set:<label prefix>=<value>');
      else {
        let spec = cmd.slice(4, eq).trim(), nth = 0;
        const m = spec.match(/#(\d+)$/);
        if (m) { nth = Number(m[1]); spec = spec.slice(0, m.index).trim(); }
        const want = norm(spec), val = cmd.slice(eq + 1);
        let done = false;
        for (const v of await inspectAll({ withSections: false })) {
          const hits = v.controls.filter(c => c.visible && norm(c.label || c.text).startsWith(want));
          if (!hits.length) continue;
          // Repeating sections give several fields the same label. "Set this" almost
          // always means the one that is still blank, not the first one down the page.
          const c = nth ? hits[nth - 1] : (hits.find(h => !h.value.trim()) || hits[0]);
          if (!c) { console.log(`only ${hits.length} field(s) match "${spec}"`); break; }
          const ok = await fillOne(v.f, v.f.locator(`[data-jh="${c.jh}"]`).first(), val, c.label);
          if (ok) console.log(`set "${c.label}" = ${val.slice(0, 60)}`);
          else {
            console.log(`could not set "${c.label}"`);
            // "could not" is useless on a dropdown without saying what it offers
            if (c.options && c.options.length) console.log(`   it offers: ${c.options.join(' | ').slice(0, 400)}`);
          }
          done = true;
          break;
        }
        if (!done) console.log(`no field whose label starts with "${cmd.slice(4, eq)}"`);
      }
    }
    else if (cmd.startsWith('opts:')) {
      const want = norm(cmd.slice(5));
      const dump = [];
      const say = line => { console.log(line); dump.push(line); };
      let found = false;
      for (const v of await inspectAll({ withSections: false })) {
        for (const c of v.controls.filter(c => c.visible && norm(c.label || c.text).startsWith(want))) {
          found = true;
          if (c.options && c.options.length) {
            say(`"${c.label}" [select]: ${c.options.join(' | ')}`);
            continue;
          }
          if (c.role === 'combobox' || c.hasPopup || c.tag === 'button') {
            const el = v.f.locator(`[data-jh="${c.jh}"]`).first();
            await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            await el.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(T.pick);
            let texts = await v.f.locator(OPTION_SELECTOR)
              .evaluateAll(ns => ns.map(n => (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim()))
              .catch(() => []);
            texts = [...new Set(texts.filter(Boolean))].slice(0, 60);
            await page.keyboard.press('Escape').catch(() => {});
            say(`"${c.label}" [combobox]: ${texts.length ? texts.join(' | ') : '(opened, but no options rendered)'}`);
            continue;
          }
          say(`"${c.label}" [${c.tag}${c.type ? ':' + c.type : ''}]: free text, maxlength ${c.maxlength || 'none'}`);
        }
        if (found) break;
      }
      if (!found) say(`no field whose label starts with "${cmd.slice(5)}"`);
      try { writeFileSync(join(rec.dir, '.session-opts'), dump.join('\n') + '\n'); } catch {}
    }
    else if (cmd === 'skills') await setSkillLevels();
    else if (cmd.startsWith('rmentry:')) await removeEntry(cmd.slice(8));
    else if (cmd === 'expand') { const o = await expandAll(); console.log(o.length ? `opened: ${o.join(' | ')}` : 'nothing left folded'); }
    else if (cmd.startsWith('click:')) await clickText(cmd.slice(6));
    else if (cmd === 'text') await dumpText();
    else if (cmd.startsWith('why:')) await whyNotClickable(cmd.slice(4).trim());
    else if (cmd === 'next') await nextPage();
    else if (cmd === 'stuck') await whyStuck();
    else if (cmd === 'net') showNet();
    else if (cmd.startsWith('dom:')) await dumpDom(cmd.slice(4).trim());
    else if (cmd.startsWith('type:')) {
      const eq = cmd.indexOf('=');
      if (eq < 0) console.log('usage: type:<label prefix>=<value>');
      else await typeInto(cmd.slice(5, eq).trim(), cmd.slice(eq + 1));
    }
    else if (cmd.startsWith('press:')) await pressKey(cmd.slice(6));
    else if (cmd === 'shot') { const a = await assess(lastFill); await writeState('look', a); console.log('screenshot written'); }
    else if (cmd === 'signin') await signIn();
    else if (cmd === 'register') await register();
    else if (cmd === 'attach') await attach();
    else if (cmd === 'report' || cmd === 'verify') await reconPage();
    else console.log('unknown command');
    } catch (e) {
      console.log(`command failed: ${e.message.split('\n')[0]}`);
    } finally {
      try { if (existsSync(busy)) unlinkSync(busy); } catch {}
    }
  }
  await ctx.close();
  process.exit(0);
}

for (;;) {
  const here = page.url();
  const login = await looksLikeLogin().catch(() => false);
  if (login) {
    console.log('\n[sign-in page. l = sign in with stored credentials, n = register a new\n' +
                ' account. The session is kept in the browser profile, so this ATS should\n' +
                ' stay logged in next time.]');
  }
  const cmd = (await ask(`\n[${hostOf(here)}] f/v/a/l/n/r/s/q > `)).trim().toLowerCase();

  if (cmd === 'q') break;
  if (cmd === 's') {
    const md = join(rec.dir, 'answers.md');
    console.log('\n' + (existsSync(md) ? readFileSync(md, 'utf8') : JSON.stringify(answers, null, 2)));
    continue;
  }
  if (cmd === 'r') { await reconPage(); continue; }
  if (cmd === 'l') { await signIn(); continue; }
  if (cmd === 'k') { await clickText(await ask('click what > ')); continue; }
  if (cmd === 'v') {
    const a = await assess(lastFill);
    printReadback(a); blockerReport(a);
    await writeState('verify', a); await writeAsks(a);
    continue;
  }
  if (cmd === 'a') {
    if (!pendingAsks.length) { console.log('nothing outstanding - press f or v first.'); continue; }
    for (const q of pendingAsks) console.log(`   ${q.id}  [${q.status}] ${q.label.slice(0, 64)}`);
    const id = (await ask('which id > ')).trim();
    const text = await ask('answer > ');
    await answerAsk(id, text);
    const a = await assess(lastFill);
    blockerReport(a); await writeState('answered', a); await writeAsks(a);
    continue;
  }
  if (cmd === 'next' || cmd === 'p') { await nextPage(); continue; }
  if (cmd === 'stuck') { await whyStuck(); continue; }
  if (cmd === 'text') { await dumpText(); continue; }
  if (cmd.startsWith('why:')) { await whyNotClickable(cmd.slice(4).trim()); continue; }
  if (cmd.startsWith('type:')) {
    const eq = cmd.indexOf('=');
    if (eq < 0) console.log('usage: type:<label prefix>=<value>');
    else await typeInto(cmd.slice(5, eq).trim(), cmd.slice(eq + 1));
    continue;
  }
  if (cmd === 'u') { await attach(); continue; }
  if (cmd === 'x') { await submit(); continue; }
  if (cmd === 'c') { await fillCode(await ask('security code > ')); continue; }
  if (cmd === 'n') { await register(); continue; }
  if (cmd === 'w') { await showWindow(); console.log('window brought on screen'); continue; }
  if (cmd === 'f' || cmd === '') {
    if (login) {
      console.log('This page has a password field. Filling email only - type the password yourself.');
    }
    await fillPage('fill');
    console.log('\nReview every field before submitting.');
    continue;
  }
  console.log('f fill, u attach, l sign in, n register, r report, v verify, a answer, x submit, s sheet, q quit');
  console.log('p/next advance the wizard, stuck why it will not, text read the page, why:<label>, type:<label>=<value>');
}

rl.close();
await ctx.close();
console.log('\nsession closed. Update the tracker:');
console.log(`  bin/jobhunt set ${slug} status=applied next="chase if silent in 2 weeks"`);
