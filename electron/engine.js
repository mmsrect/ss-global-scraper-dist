const path = require("path");
const os = require("os");
const fs = require("fs");
const { app, screen } = require("electron");
const rawChrome = require("./rawChromeDriver");
const { pacingRangeForSite, levelToRangeMs } = require("./pacing");

// 2026-08-11 (found via real research, after a stealth-plugin build and a
// CDP-leak-patched build both still lost to the same verification wall
// even with Mohsin solving it by hand): the wall wasn't reacting to
// anything a page's own JavaScript reports about itself - stealth patches
// operate at exactly that level, which is why neither one changed
// anything. It was reacting to the startup handshake automation
// frameworks send the moment they attach to a browser, before any page
// even loads. Puppeteer - stealth-patched or not - always sends that
// handshake, because it's baked into how the framework tracks pages
// internally, not something a plugin can opt out of. rawChromeDriver.js
// replaces it with a much thinner layer that only ever sends the exact
// commands each action needs, and never that handshake - full reasoning
// lives in that file's own notes.

// Never touches Mohsin's/Wasim's team's actual live Chrome (2026-08-11,
// final call after trying the alternative - driving the real Chrome
// directly meant asking to close it before every single run, and even
// with that handled properly, the underlying "only one process per
// profile" conflict kept resurfacing in new ways). Back to a completely
// separate, disposable browser this app owns outright - real cookies and
// history copied in once for trust, real Chrome never opened, quit, or
// depended on being closed at any point.

// A real saved Chrome profile on disk (not an in-memory session) - this is
// what makes the browser keep its cookies and sign-in state across every
// run and every app restart, the same way a real person's everyday browser
// does. Loaded automatically the moment a session starts; wiped only when
// "Reset cookies" is used on purpose.
function profileDir() {
  return path.join(app.getPath("userData"), "scraper-browser-profile");
}

// Where each OS actually keeps a person's real, everyday Chrome profile -
// used only to seed this app's own separate copy, never pointed at
// directly.
function realChromeProfilePaths() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const root = path.join(home, "Library", "Application Support", "Google", "Chrome");
    return { root, defaultProfile: path.join(root, "Default") };
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const root = path.join(localAppData, "Google", "Chrome", "User Data");
    return { root, defaultProfile: path.join(root, "Default") };
  }
  const root = path.join(home, ".config", "google-chrome");
  return { root, defaultProfile: path.join(root, "Default") };
}

// The real, installed Chrome application - not Puppeteer's own bundled
// "Chrome for Testing" binary. Used to launch this app's own separate
// profile (see above), so the automated window is genuinely real Chrome,
// not a build a site can recognize as a testing binary. Falls back to
// Puppeteer's bundled Chromium if real Chrome isn't installed, rather
// than blocking the app from working at all.
function realChromeExecutablePath() {
  let candidate;
  if (process.platform === "darwin") {
    candidate = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  } else if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    candidate = [
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    ].find((p) => fs.existsSync(p));
  } else {
    candidate = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find((p) => fs.existsSync(p));
  }
  return candidate && fs.existsSync(candidate) ? candidate : undefined;
}

// Chrome's own standard marker for "a copy of me is currently running
// against this profile" - present the same way across Mac/Windows/Linux.
// Only ever checked here against the REAL Chrome profile, and only at the
// one moment that matters - right before copying from it - so a live copy
// never gets read out from under it (this is what corrupted things once
// already; see the note on the clone function below).
//
// SingletonLock is a symlink, and its "target" isn't a real file path -
// it's just an identifier string (hostname-PID). fs.existsSync() follows
// symlinks and checks whether THAT resolves to something real, which
// silently reports "not running" even while Chrome genuinely holds the
// lock (confirmed live 2026-08-11 against Mohsin's own machine). Reading
// the symlink instead of resolving it is what actually proves whether the
// lock exists, regardless of what its target text points to.
function realChromeIsRunning(root) {
  try {
    fs.readlinkSync(path.join(root, "SingletonLock"));
    return true;
  } catch {
    return false;
  }
}

function copyFileBestEffort(src, dest) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch {
    // Locked, permission denied, or a transient OS quirk - skip just this
    // one file rather than aborting the whole clone. Cookies is the file
    // that actually matters here; losing a journal/lock file alongside it
    // costs nothing real.
  }
}

function copyDirBestEffort(srcDir, destDir) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirBestEffort(srcPath, destPath);
    else if (entry.isFile()) copyFileBestEffort(srcPath, destPath);
  }
}

// Deliberately narrow - real cookies, browsing history, and profile
// preferences are what actually make a browser look aged and trusted to a
// site's bot check (confirmed live 2026-08-11: the exact page that kept
// failing here cleared instantly in Mohsin's own everyday Chrome, same
// URL). Saved passwords and autofill/payment data are left out on
// purpose - no trust benefit for a scraper that only ever visits
// FastPeopleSearch, and copying them into an automation-driven profile
// would be a real, unnecessary risk. Heavy, trust-irrelevant folders
// (Cache, Extensions, Service Worker storage, etc.) are left out too.
// Local Storage is left out on purpose too (2026-08-11, live incident):
// it's a LevelDB directory, not a single self-contained file, and copying
// one out from under a real, open Chrome tore it badly enough to crash
// the automated browser the moment a new tab touched it.
const CLONE_ALLOWLIST = ["Cookies", "Cookies-journal", "Preferences", "History", "History-journal"];

// One-time, first-launch-ever-on-this-machine step: seeds this app's own,
// separate browser profile from whatever real Chrome profile is already
// on this computer. Runs the same way for every person this app gets
// installed for, on their own machine - not something special-cased for
// Mohsin. Always a copy into this app's own folder, never the real
// profile itself: their everyday Chrome is never opened, closed, or
// depended on being in any particular state, before or after.
//
// Skips entirely - falls back to starting blank, same as if no real
// Chrome existed at all - if their Chrome happens to be open at this
// exact moment. A live, in-use profile isn't safe to copy from (the exact
// crash above); simply not cloning this one time, with no prompt and no
// attempt to close anything, is the right call - the next app restart
// tries again on its own.
function cloneRealChromeProfileIfFirstRun() {
  if (fs.existsSync(profileDir())) return; // already has its own profile - not a first run

  const { root, defaultProfile } = realChromeProfilePaths();
  if (!fs.existsSync(defaultProfile)) return; // no real Chrome profile found on this machine
  if (realChromeIsRunning(root)) return; // open right now - not safe to copy from, skip this time, no prompt

  fs.mkdirSync(profileDir(), { recursive: true });

  // Local State sits next to Default, not inside it - it's what Chrome
  // needs to actually decrypt the cookies it's about to inherit.
  copyFileBestEffort(path.join(root, "Local State"), path.join(profileDir(), "Local State"));

  // Real bug, found live 2026-08-12 (Mohsin's report: the app's own
  // browser kept showing a "choose a profile" screen even after he'd
  // deleted every real Chrome profile on his machine entirely). Local
  // State is Chrome's whole-installation profile registry - if someone's
  // real Chrome has more than one profile, this file lists all of them,
  // but only ONE profile's actual folder ever gets copied below
  // ("Default" specifically). Copying Local State wholesale meant Chrome
  // opened believing a second profile existed - because the registry
  // said so - even though no data for it was ever actually copied in,
  // which is exactly what triggers that picker screen. Stripping the
  // registry down to just the one entry that genuinely has data removes
  // the mismatch outright, rather than leaving it to "Reset cookies" to
  // clean up after the fact.
  try {
    const localStatePath = path.join(profileDir(), "Local State");
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    if (localState.profile) {
      if (localState.profile.info_cache) {
        localState.profile.info_cache = { Default: localState.profile.info_cache.Default || {} };
      }
      localState.profile.last_used = "Default";
      localState.profile.last_active_profiles = ["Default"];
      localState.profile.profiles_order = ["Default"];
    }
    fs.writeFileSync(localStatePath, JSON.stringify(localState));
  } catch {
    // No Local State copied (real Chrome not found, or unreadable) -
    // nothing to strip down; Chrome starts a brand-new one on first
    // launch either way, which is already a clean single-profile state.
  }

  const destDefault = path.join(profileDir(), "Default");
  fs.mkdirSync(destDefault, { recursive: true });
  for (const name of CLONE_ALLOWLIST) {
    const srcPath = path.join(defaultProfile, name);
    if (!fs.existsSync(srcPath)) continue;
    const destPath = path.join(destDefault, name);
    try {
      if (fs.statSync(srcPath).isDirectory()) copyDirBestEffort(srcPath, destPath);
      else copyFileBestEffort(srcPath, destPath);
    } catch {
      // Same reasoning as copyFileBestEffort - skip this one item, keep going.
    }
  }
}

// Chrome treats anything other than a clean previous shutdown as a
// possible crash and can silently reopen whatever tab was last open on the
// next launch - real risk here since the app doesn't always get a chance
// to close the browser cleanly itself (a quit, a crash, dev-mode restart).
// Stamping the profile as cleanly exited before every launch, and setting
// its startup behavior to a plain blank tab, keeps Chrome from ever trying
// to restore anything on its own. Safe to do here since this is the app's
// own disposable profile, never a real person's actual settings.
async function markProfileForCleanStart() {
  const fsp = require("fs/promises");
  const prefsPath = path.join(profileDir(), "Default", "Preferences");
  try {
    const raw = await fsp.readFile(prefsPath, "utf8");
    const prefs = JSON.parse(raw);
    prefs.profile = prefs.profile || {};
    prefs.profile.exit_type = "Normal";
    prefs.profile.exited_cleanly = true;
    prefs.session = prefs.session || {};
    prefs.session.restore_on_startup = 5; // 5 = plain new tab, never "continue where I left off"
    await fsp.writeFile(prefsPath, JSON.stringify(prefs));
  } catch {
    // No profile yet (first run ever) or unreadable - nothing to patch,
    // and a brand-new profile has nothing to restore anyway.
  }
}

// Splits the actual screen this app is running on right down the middle -
// app on the left half (see main.js's leftHalfBounds), this browser window
// on the right half - computed fresh off the real display every launch
// rather than a fixed pixel size, so it lands correctly on any screen.
function rightHalfWindowArgs() {
  const { workArea } = screen.getPrimaryDisplay();
  const halfWidth = Math.floor(workArea.width / 2);
  const x = workArea.x + halfWidth;
  const y = workArea.y;
  return [`--window-position=${x},${y}`, `--window-size=${halfWidth},${workArea.height}`];
}

// The one shared browser session for this app - opens as its own real
// window, separate from the app's window and from the person's real
// Chrome entirely, and stays open across multiple searches in a run
// rather than relaunching per lookup.
//
// Tabs are kept in named slots rather than one single `page` (added
// 2026-08-14, tab-rotation test) - "A" is the original single-tab
// behavior and stays the default everywhere nothing else is specified,
// so nothing about single-site runs changes. A second slot ("B") only
// gets created the moment something actually asks for it, which today
// is only the rotation test itself.
let browser = null;
const pages = new Map(); // slot name -> Puppeteer page

// The pause range currently in effect, per site - fetched fresh from
// Supabase once per prepareBrowserForRun() call (2026-08-14, admin
// pacing) and cached here for the rest of that run, same "checked once at
// a natural boundary" shape as the kill switch. An admin moving the
// slider mid-run takes effect on the next Start/Resume, not live.
const pacingRangesBySite = new Map();

// Kept as the one entry point the run screen calls before starting (same
// name as the earlier live-Chrome approach) - now also refreshes this
// run's pacing from Supabase before anything launches. Fetches every live
// site's level, not just FastPeopleSearch's - TruePeopleSearch (added
// 2026-08-14) would otherwise silently ignore its own admin-set slider
// and fall back to pacing.js's default every run.
async function prepareBrowserForRun() {
  await ensureBrowser();
  pacingRangesBySite.set("fastpeoplesearch", await pacingRangeForSite("fastpeoplesearch"));
  pacingRangesBySite.set("truepeoplesearch", await pacingRangeForSite("truepeoplesearch"));
}

// Recovery for a real reported case (2026-08-11): a run that looked stuck
// got interrupted by Mohsin outside the app's own Stop button (closing
// the browser window directly), which can leave Chrome's process alive
// in the background holding this profile's lock even though this app's
// own in-memory `browser` reference is gone - the next Start then
// collided with that leftover process instead of launching a fresh one.
// Safe to clean up unconditionally here in a way it would NOT be safe to
// do against the person's real Chrome: profileDir() is always this app's
// own separate, disposable folder, so anything holding its lock is
// guaranteed to be a leftover copy of THIS app's own browser, never the
// person's real one - matching only by this exact, uniquely-named folder
// path is what makes that guarantee hold. Best-effort on purpose - if the
// process-matching step fails or finds nothing, still clears the lock
// files themselves so a stale, no-longer-real lock can never block a
// fresh launch on its own.
function clearStaleOwnProfileLock() {
  const dir = profileDir();
  try {
    fs.readlinkSync(path.join(dir, "SingletonLock")); // throws if no lock present - nothing to recover from
  } catch {
    return;
  }

  try {
    const { execFileSync } = require("child_process");
    if (process.platform === "win32") {
      execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${dir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      ]);
    } else {
      execFileSync("pkill", ["-f", dir]);
    }
  } catch {
    // No matching process found, or the kill attempt itself failed - fall
    // through to clearing the lock files regardless, below.
  }

  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // Wasn't there, or already gone - fine either way.
    }
  }
}

async function ensureBrowser() {
  if (browser && browser.connected) return browser;

  clearStaleOwnProfileLock();
  cloneRealChromeProfileIfFirstRun();
  await markProfileForCleanStart();

  const executablePath = realChromeExecutablePath();
  if (!executablePath) {
    throw new Error(
      "Couldn't find a real Chrome install on this computer. Install Google Chrome, then try again."
    );
  }

  browser = await rawChrome.launch({
    executablePath,
    userDataDir: profileDir(), // this app's own separate profile - never the person's real one
    windowArgs: rightHalfWindowArgs(),
    extraArgs: ["--hide-crash-restore-bubble", "--disable-session-crashed-bubble"],
  });

  browser.on("disconnected", () => {
    browser = null;
    pages.clear();
  });

  // Belt-and-braces on top of the preference patch above: whatever Chrome
  // actually opened on launch (its own default tab, or - if it still
  // decided to restore something - a leftover tab), close every one of
  // them except a single fresh tab this app creates and controls itself
  // (slot "A" - other slots only open later, on demand). Safe here since
  // this is the app's own disposable profile, never a real person's
  // actual open tabs.
  const firstPage = await browser.newPage();
  pages.set("A", firstPage);
  const otherPages = (await browser.pages()).filter((p) => p !== firstPage);
  for (const p of otherPages) {
    await p.close().catch(() => {});
  }

  return browser;
}

async function ensurePage(slot = "A") {
  const b = await ensureBrowser();
  const existing = pages.get(slot);
  if (existing && !existing.isClosed()) return existing;
  const p = await b.newPage();
  pages.set(slot, p);
  return p;
}

// Closing the browser properly (rather than letting the OS kill it when
// the app quits) is what lets Chrome record a clean exit on its own next
// time - the profile patch above is the safety net for when this doesn't
// get the chance to run (a crash, a force-quit).
app.on("before-quit", async () => {
  if (browser && browser.connected) {
    await browser.close().catch(() => {});
  }
});

// Called once the run screen's Stop button has actually finished winding
// the run down - closes the real browser window along with it, rather
// than leaving it sitting open with nothing left to do. The next Start
// launches a fresh window again automatically (same saved cookies, per
// ensureBrowser above).
async function closeBrowser() {
  if (browser && browser.connected) {
    await browser.close().catch(() => {});
  }
  browser = null;
  pages.clear();
  return true;
}

// Closes just one site's tab, leaving the browser and every other slot's
// tab untouched (added 2026-08-15, per-source rate-limit handling) - a
// site that hits its rate limit gets its own tab closed and dropped from
// rotation for the rest of this run, while whatever's still active in
// another slot keeps going uninterrupted. `ensurePage(slot)` already
// reopens a fresh tab on demand if this slot is ever asked for again (a
// brand new Start/Resume after a full stop), so nothing further is needed
// here to "give the site back" later.
async function closeTab(slot) {
  const p = pages.get(slot);
  if (p && !p.isClosed()) {
    await p.close().catch(() => {});
  }
  pages.delete(slot);
  return true;
}

// Deletes this app's own saved profile - cookies, history, everything it
// copied in - so the next launch re-seeds itself from the real Chrome
// profile again, same as the very first time. Never touches the real
// Chrome profile itself, only this app's own separate copy. Opt-in only,
// never called automatically. Needs the browser closed first since the
// profile folder is locked while it's in use.
async function resetCookies() {
  if (browser && browser.connected) {
    await browser.close();
    browser = null;
    pages.clear();
  }
  const fsp = require("fs/promises");
  // A closed browser doesn't always release its file handles on the
  // profile folder instantly, especially on Windows - a delete attempted
  // in that exact gap can fail with a real lock error. Retries a few
  // times with a short pause rather than surfacing that as "reset
  // failed" over what's really just bad timing.
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await fsp.rm(profileDir(), { recursive: true, force: true });
      return true;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr;
}

// --- Stop support ---
// The run screen's Stop button needs to actually interrupt a lookup that's
// mid-wait - and with the generous captcha-clearing timeouts below, that
// wait can run several minutes. Every wait in this file is written to
// check this signal and bail out immediately rather than only noticing
// between numbers, which is what made Stop feel unresponsive before.
let currentAbortController = null;
function requestStop() {
  currentAbortController?.abort();
}

class StoppedByUserError extends Error {
  constructor() {
    super("Stopped by user.");
    this.stoppedByUser = true;
  }
}

// Deliberately its own error class, not just another wait-timeout failure
// (2026-08-12, Mohsin's call) - a rate-limit page needs a genuinely
// different response than a captcha: this file can't just keep polling
// and waiting for it to clear on its own, because nothing about a rate
// limit clears with time the way a solved captcha does - it needs a
// different IP. What the run screen actually does with this (pause in
// place, leave the row untouched, wait for Mohsin to change his proxy and
// click Resume) lives entirely on that side (MyScrapingPanel.jsx) - this
// class only carries the signal across. The message text is matched
// there via .includes(), not exact equality, since every error crossing
// the IPC boundary arrives wrapped in Electron's own "Error invoking
// remote method..." prefix - same reasoning as StoppedByUserError above,
// which has the identical matching requirement on the other side.
// Site labels matched by the run screen's own text-based error detection
// below - kept here, next to the throw sites, rather than duplicated on
// the renderer side of the IPC boundary (custom Error properties don't
// reliably survive that crossing, only .message does - same reasoning as
// StoppedByUserError already relies on).
const RATE_LIMIT_SITE_LABELS = {
  fastpeoplesearch: "FastPeopleSearch",
  truepeoplesearch: "TruePeopleSearch",
};

// `site` (added 2026-08-15, multi-source rate-limit handling) names which
// site actually hit the wall, baked directly into the message text - the
// run screen's per-source fallback (close just that site's tab, keep
// going on whatever else is still active) needs to know which one, and
// message-text matching is the only thing that survives the IPC crossing
// intact. Every real throw site below always passes a real site id now;
// falling back to the bare id itself (rather than throwing) if a future
// site is ever added here without updating the label map, so this never
// hard-crashes over a missing label.
class RateLimitedError extends Error {
  constructor(site) {
    const label = RATE_LIMIT_SITE_LABELS[site] || site || "this site";
    super(`Rate limited on ${label} - change your proxy, then Resume.`);
    this.rateLimited = true;
    this.site = site;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new StoppedByUserError();
}

// A real live case (2026-08-11): a Cloudflare-style redirect tore down
// the tab's underlying connection entirely mid-wait, and every check
// below was written to quietly swallow a failed read (so one flaky tick
// doesn't take down an otherwise-fine wait) - which meant this exact
// situation just sat silently until the full multi-minute timeout ran
// out, looking exactly like the whole run had frozen. Called at the top
// of every poll tick, right alongside the existing Stop check, so a truly
// dead tab fails in seconds instead of minutes - the run loop's own
// per-row try/catch (already there) turns this into a normal "Error" on
// this one number and moves straight on to the next with a fresh tab,
// same as any other failure.
function throwIfPageDead(p) {
  if (p.isClosed()) {
    throw new Error("The browser tab closed unexpectedly mid-search - try again.");
  }
}

// --- Status broadcast ---
// Lets the run screen show what's actually happening inside the browser
// window right now (a verification check is up and needs a human) instead
// of just looking stuck. main.js wires this to the renderer.
let statusBroadcaster = null;
function onStatus(fn) {
  statusBroadcaster = fn;
}
function broadcastStatus(status, detail) {
  if (statusBroadcaster) statusBroadcaster({ status, detail, at: Date.now() });
}

// Plain narration lines for the docked terminal on the run screen
// (2026-08-11, Mohsin's request) - separate from the status states above
// (which drive actual UI behavior, like the captcha banner). This channel
// only ever describes what's happening right now in plain words - every
// call site below is a real step the engine is actually taking, not a
// summary invented after the fact.
function broadcastLog(message) {
  broadcastStatus("log", message);
}

// FastPeopleSearch's own result-card links carry a readable name right in
// the URL slug ("/reginald-sissons_id_G864...") - turning that into
// "Reginald Sissons" lets the terminal say who's about to be checked
// before that candidate's page has even loaded, rather than just an
// index number.
//
// Unused since the 2026-08-12 "current owner" rewrite of runPhoneSearch
// below (the owner link's own text already gives a real name, no slug
// parsing needed) - left in place rather than deleted, same as
// rawChromeDriver.js's click() method, in case the multi-candidate
// approach is ever reinstated.
function nameFromCandidateHref(href) {
  const slug = href.split("/").pop().split("_id_")[0] || "";
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || "this profile";
}

// --- Human-paced browsing ---
// A page that jumps straight from "loaded" to "read" every single time, at
// identical speed, is itself a tell. These helpers add the small, varied
// pauses and movements a real person makes without thinking about it -
// reading for a moment, drifting the mouse, scrolling to see more - so no
// two runs look exactly alike. Used between page loads and before reading,
// never anywhere that would affect what gets extracted.

function randomBetween(minMs, maxMs) {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

// Abort-aware sleep - rejects immediately (rather than after the full
// delay) the moment Stop is requested.
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new StoppedByUserError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new StoppedByUserError());
      },
      { once: true }
    );
  });
}

// A believable "just landed, glancing at the page" pause before doing
// anything else. The range is admin-controlled now (2026-08-14, "My
// scraping work"'s Pacing section) - minMs/maxMs come from that site's
// slider (see pacingRangesBySite / pacing.js's levelToRangeMs), not a
// number fixed in code. The 2000/4000 defaults here only cover a caller
// that somehow never set a range at all - normal runs always pass real
// values in.
async function humanPause(signal, minMs = 2000, maxMs = 4000) {
  await wait(randomBetween(minMs, maxMs), signal);
}

// Drifts the cursor across a handful of random points, each with its own
// short pause, rather than snapping straight to whatever gets clicked next.
// Worth noting plainly: these are real Input-layer events the PAGE
// genuinely receives (real mousemove events fire, :hover states genuinely
// change) - that's what matters for not reading as automated. They do
// NOT move the actual, visible system cursor on screen though - Chrome
// doesn't warp the real OS pointer for CDP-dispatched input in normal
// windowed mode, so watching the browser won't show a moving arrow the
// way watching a person drive the mouse would. That's a real limit of
// this technique, not something tunable away.
//
// Fixed 2026-08-12 (Mohsin's report - looked like it was "flickering" or
// "wiggling in place"): every random point used to be picked completely
// independently, with nothing stopping two picks in a row from landing
// close together by chance - a real hand covers real distance when it
// moves, it doesn't twitch a few pixels and call that a move. Each new
// point is now rejected and re-picked until it's meaningfully far from
// the last one, so every hop is a real, visible-if-you-could-see-it
// movement across the page, not a cluster of near-identical spots.
// Step/wait ranges trimmed a little 2026-08-12 (Mohsin's "make it a tad
// faster" ask) - same real, varied movement, just fewer hops and shorter
// pauses between them.
async function humanMouseWander(p, signal, steps = randomBetween(2, 4)) {
  const viewport = p.viewport() || { width: 1280, height: 800 };
  const minHopDistance = Math.min(viewport.width, viewport.height) * 0.25;
  let last = null;
  for (let i = 0; i < steps; i++) {
    throwIfAborted(signal);
    let x, y;
    let attempts = 0;
    do {
      x = randomBetween(60, viewport.width - 60);
      y = randomBetween(60, viewport.height - 60);
      attempts += 1;
    } while (last && Math.hypot(x - last.x, y - last.y) < minHopDistance && attempts < 10);
    last = { x, y };
    await p.mouse.move(x, y, { steps: randomBetween(15, 30) });
    await wait(randomBetween(100, 350), signal);
  }
}

// Scrolls down the page in a few real down-movements - and, per Mohsin's
// exact example (2026-08-12), a real chance after each one of scrolling
// back up a little before continuing further down, the way someone
// re-reading a line they just passed does, rather than one rare isolated
// flip somewhere in the whole sequence.
// Passes/wait ranges trimmed a little 2026-08-12 (Mohsin's "make it a tad
// faster" ask) - same real scrolling-with-an-occasional-re-read pattern,
// just fewer passes and shorter pauses between them.
async function humanScroll(p, signal, passes = randomBetween(2, 4)) {
  for (let i = 0; i < passes; i++) {
    throwIfAborted(signal);
    const down = randomBetween(250, 700);
    await p.evaluate((y) => window.scrollBy(0, y), down);
    await wait(randomBetween(250, 700), signal);

    if (Math.random() < 0.4) {
      const back = randomBetween(80, 250);
      await p.evaluate((y) => window.scrollBy(0, y), -back);
      await wait(randomBetween(200, 450), signal);
    }
  }
}

// Bundles the above into one "arrived on a page, taking it in" beat - call
// after every navigation, before reading anything off the page.
//
// Mouse-wander and scroll steps switched off 2026-08-13 (Mohsin's ask) -
// just the pause remains between actions now. humanMouseWander and
// humanScroll are left defined above, untouched, in case this gets
// switched back on later.
//
// `site` (2026-08-14) picks whose slider governs this pause - looked up
// in pacingRangesBySite, which prepareBrowserForRun() refreshes from
// Supabase once at the start of each run. Falls back to the same
// moderate default pacing.js itself falls back to if the site was never
// fetched for some reason (shouldn't normally happen).
async function actLikeSomeoneBrowsing(p, signal, site) {
  const range = pacingRangesBySite.get(site) || levelToRangeMs(2);
  await humanPause(signal, range.minMs, range.maxMs);
}

// A shared number can belong to several people - the same disambiguation
// rule the old tool used elsewhere (Skip Trace): check up to this many
// candidate profiles rather than assuming the first one is right.
//
// Unused since the 2026-08-12 "current owner" rewrite (client's explicit
// ask: stop visiting multiple profiles, trust the results page's own
// named owner instead) - left in place rather than deleted, same
// reasoning as nameFromCandidateHref above.
const MAX_PHONE_CANDIDATES = 5;

const MONTH_NUMBERS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// FastPeopleSearch sometimes stacks a second, separate verification widget
// (a "slide right to secure your access" puzzle, in its own embedded
// frame) right on top of Cloudflare's own check - confirmed live
// 2026-08-11. Real content can sit behind one wall, both, or neither, and
// there's no way to know in advance.
//
// RESULTS_WAIT_MS trimmed from 4 minutes to 1 (2026-08-12, Mohsin's call,
// live during real Windows testing - an ad-heavy results page was slow
// enough to sit at this wait for its full length before the app finally
// gave up and asked to skip/stop). Trade-off worth knowing: if a real
// captcha shows up and nobody notices it within a minute, this now gives
// up and asks sooner than before - not a big cost, since Skip/Stop just
// re-offers the same number to try again, but it does mean this can fire
// a little more eagerly than the old 4-minute version did.
const RESULTS_WAIT_MS = 60000; // 1 minute
const PROFILE_WAIT_MS = 60000; // 1 minute - trimmed to match, same reasoning as RESULTS_WAIT_MS above

// The genuine "nothing on file for this number" page is its own real,
// distinct heading (confirmed live against fastpeoplesearch.com,
// 2026-08-11) - not just "the results card never showed up." Checking for
// this specifically is what stops a still-stuck verification wall from
// ever being silently reported as "no record found": a timeout with
// neither signal present is treated as a real failure to load, not a
// negative result.
const NO_RESULTS_SELECTOR = "h1.list-results-header";
const HAS_RESULTS_SELECTOR = ".card[data-link]";

const CAPTCHA_POLL_MS = 2000; // trimmed a little 2026-08-12, Mohsin's "a tad faster" ask

// Recognizes the page states seen live so far (Cloudflare's own
// interstitial, the slide-to-verify widget, and - added 2026-08-11 after
// a live run hit it and the run screen never noticed - a third, separate
// "Are you human?" page of its own at /bot-check, with its own re-CAPTCHA
// widget) by title/URL/body text rather than a specific selector - new
// wording or a new provider still gets caught by these generic phrases
// without needing a code change.
//
// TruePeopleSearch's own wall added 2026-08-14 (first real live check
// against that site, during selector research): a phone-search result URL
// (/resultphone?...) redirects to its own /InternalCaptcha?returnUrl=...
// page, plain title "Captcha" - genuinely different wording/URL shape
// from any of FastPeopleSearch's three, so none of the checks above would
// have caught it. Shared here rather than split into a per-site function,
// same as the rest of this list - harmless to check against FastPeopleSearch
// too, since that site never produces this title/URL shape.
async function isCaptchaShowing(p) {
  return p
    .evaluate(() => {
      const title = document.title || "";
      const url = document.location ? document.location.href : "";
      const text = document.body ? document.body.innerText.slice(0, 800) : "";
      return (
        /just a moment/i.test(title) ||
        /verification required/i.test(text) ||
        /verify you are human/i.test(text) ||
        /slide right to secure/i.test(text) ||
        /are you human/i.test(text) ||
        /\/bot-check/i.test(url) ||
        /^captcha$/i.test(title.trim()) ||
        /\/InternalCaptcha/i.test(url) ||
        // New shape, confirmed live 2026-08-14 on FastPeopleSearch: a
        // Cloudflare challenge whose title reads "Security Challenge"
        // rather than "Just a moment..." - same underlying Cloudflare
        // check, different title text, previously undetected here.
        /^security challenge$/i.test(title.trim())
      );
    })
    .catch(() => false);
}

// A genuinely different page from any of the captcha states above
// (confirmed live 2026-08-12 - real title "Rate Limited - FastPeopleSearch.com",
// real URL fastpeoplesearch.com/rate-limited, real heading "Rate Limit
// Exceeded"): this one isn't a check to solve, it's the site declining to
// serve this IP any more requests for a while. No amount of waiting on
// this page changes that - see RateLimitedError above for what happens
// once this is detected.
async function isRateLimited(p) {
  return p
    .evaluate(() => {
      const title = document.title || "";
      const url = document.location ? document.location.href : "";
      const text = document.body ? document.body.innerText.slice(0, 800) : "";
      return /\/rate-limited/i.test(url) || /rate limit exceeded/i.test(text) || /rate limited/i.test(title);
    })
    .catch(() => false);
}

// Polls for the real target selector instead of a single blind wait, so a
// captcha showing up mid-wait can be surfaced to the run screen the moment
// it appears, and cleared the moment it's gone - the same wait just keeps
// going and picks up the real content on its own once a person clears it,
// no manual resume needed. Also the one place Stop actually interrupts a
// long wait quickly rather than only being noticed between numbers.
async function waitForRealContent(p, selector, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let sawCaptcha = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    throwIfPageDead(p);
    if (await isRateLimited(p)) {
      broadcastLog("⛔ FastPeopleSearch rate limit hit.");
      throw new RateLimitedError("fastpeoplesearch");
    }

    const found = await p.$(selector).catch(() => null);

    // TEMPORARY DIAGNOSTIC (2026-08-12) - investigating a live, repeated
    // "verification cleared, then nothing" report. Logs the exact page
    // state on every single poll tick so the real cause is observed
    // directly instead of guessed at again - remove once confirmed fixed.
    if (process.env.SCRAPER_DEBUG) {
      const debugState = await p
        .evaluate((sel) => ({ url: document.location.href, title: document.title, readyState: document.readyState, selectorExists: !!document.querySelector(sel) }), selector)
        .catch((err) => ({ evalError: err.message }));
      console.log("[waitForRealContent tick]", { selector, found: !!found, ...debugState });
    }

    if (found) {
      if (sawCaptcha) {
        broadcastStatus("captcha-clear");
        // A real person doesn't solve a puzzle and immediately start
        // clicking around at full speed again - going straight back to
        // rapid browsing right after clearing a check is itself the kind
        // of pattern that gets a network/IP flagged as automated (exactly
        // what FastPeopleSearch's own verification page says it's
        // watching for). A longer breather here, before anything else
        // happens on the page, is deliberate.
        await wait(randomBetween(4000, 9000), signal);
      }
      return true;
    }

    const captchaNow = await isCaptchaShowing(p);
    if (captchaNow && !sawCaptcha) {
      sawCaptcha = true;
      broadcastStatus(
        "captcha-waiting",
        "A verification check is showing in the browser window - solve it there. This run continues on its own the moment it clears."
      );
    } else if (!captchaNow && sawCaptcha) {
      if (process.env.SCRAPER_DEBUG) console.log("[waitForRealContent] captcha-clear branch (transitional - selector not found yet)");
      sawCaptcha = false;
      broadcastStatus("captcha-clear");
    }

    await wait(CAPTCHA_POLL_MS, signal);
  }

  if (sawCaptcha) broadcastStatus("captcha-clear");
  return false;
}

// The results-page-specific version of the wait above (2026-08-11, real
// live bug fix - Mohsin reported a genuine "no results" number looking
// completely frozen). waitForRealContent only ever checked for a
// negative once its full timeout had already run out - fine for
// correctness, but it meant every single true no-results number sat
// through the entire multi-minute wait before ever reporting anything,
// even when the real page had already loaded and settled seconds in.
// Confirmed live against both a real no-results page and a real hit
// (2026-08-11): NO_RESULTS_SELECTOR exists on every results page
// regardless of outcome, same as before, but its actual TEXT only ever
// reads "No results found..." on a genuine negative - a real hit's
// version of the same heading reads completely differently ("Who Owns
// The Phone Number..."). That's what makes it safe to check the negative
// on every single poll tick, right alongside the positive one, instead
// of only after giving up - a real hit's heading text can never
// accidentally match the negative phrase, so there's no race to
// reintroduce here even though both signals share one polling loop.
async function waitForResultsOutcome(p, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let sawCaptcha = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    throwIfPageDead(p);
    if (await isRateLimited(p)) {
      broadcastLog("⛔ FastPeopleSearch rate limit hit.");
      throw new RateLimitedError("fastpeoplesearch");
    }

    const state = await p
      .evaluate(
        (hasSel, noSel) => ({
          hasResults: !!document.querySelector(hasSel),
          isNoResults: /no results found/i.test(document.querySelector(noSel)?.textContent || ""),
        }),
        HAS_RESULTS_SELECTOR,
        NO_RESULTS_SELECTOR
      )
      .catch(() => ({ hasResults: false, isNoResults: false }));

    if (state.hasResults || state.isNoResults) {
      if (sawCaptcha) {
        broadcastStatus("captcha-clear");
        await wait(randomBetween(4000, 9000), signal);
      }
      return state.hasResults ? "has-results" : "no-results";
    }

    const captchaNow = await isCaptchaShowing(p);
    if (captchaNow && !sawCaptcha) {
      sawCaptcha = true;
      broadcastStatus(
        "captcha-waiting",
        "A verification check is showing in the browser window - solve it there. This run continues on its own the moment it clears."
      );
    } else if (!captchaNow && sawCaptcha) {
      sawCaptcha = false;
      broadcastStatus("captcha-clear");
    }

    await wait(CAPTCHA_POLL_MS, signal);
  }

  if (sawCaptcha) broadcastStatus("captcha-clear");
  return "timeout";
}

// Reads name/address off a person's profile page, plus - matching the old
// tool's exact disambiguation rule - how recently the SPECIFIC searched
// number was reported on file for this particular person. That recency is
// what decides which candidate is the real match when a number is shared,
// not just whichever profile came up first.
//
// Every phone number on the page is still read here (has to be, to find
// the searched one and rank candidates against each other) - but per a
// client scope change (2026-08-11, phone mode only): what actually gets
// returned to the caller is just that one searched number, never the rest
// of what's on the profile. Address/Name/Skip Trace modes are untouched by
// this - they don't exist yet, and whatever they eventually surface is a
// separate decision for whenever they're built, not something this rule
// should quietly reach into.
// The 14 property-detail fields confirmed live 2026-08-11 as genuinely
// available on FastPeopleSearch's own profile page (not just the
// cyberbackgroundchecks.com site the old tool used) - Age comes from the
// short bio line right under the page's name heading ("Age 84, Born June
// 1942..."), the other 13 from a clearly-labeled "Current Address
// Property Details" box further down. Mapped label -> master-file column
// name here once, so both extractProfile (below) and any future mode
// reading this same page agree on the exact same mapping. "Lot SqFt." is
// the one label that doesn't match its column name verbatim (the master
// file's own header is "Lot SQ FT," matching the extension's real
// schema) - every other label is already an exact match.
// Bedrooms added 2026-08-12 - confirmed live it's a real, normal
// labeled pair (<dt>Bedrooms</dt><dd>3</dd>) sitting right alongside
// Bathrooms in the exact same box, contrary to the earlier 2026-08-11/12
// call that it was "genuinely absent" (that only held for the two
// profiles checked that day). Reuses the same dl-loop below rather than
// needing any new extraction logic.
const PROPERTY_LABEL_TO_HEADER = {
  Bedrooms: "Bedrooms",
  Bathrooms: "Bathrooms",
  "Square Feet": "Square Feet",
  "Year Built": "Year Built",
  "Estimated Value": "Estimated Value",
  "Estimated Equity": "Estimated Equity",
  "Last Sale Amount": "Last Sale Amount",
  "Last Sale Date": "Last Sale Date",
  "Occupancy Type": "Occupancy Type",
  "Ownership Type": "Ownership Type",
  "Land Use": "Land Use",
  "Property Class": "Property Class",
  Subdivision: "Subdivision",
  "Lot SqFt.": "Lot SQ FT",
};

async function extractProfile(p, searchedDigits) {
  return p.evaluate((digits, labelToHeader) => {
    const name = document.querySelector("#full_name_section .fullname")?.textContent?.trim() || null;

    // Confirmed live 2026-08-11: the page's <h1> (person + city/state) is
    // always immediately followed by a short bio <p> - "Age 84, Born June
    // 1942 / Lives in Surprise, AZ / (623) 544-2939" - on every real
    // profile checked. Age is pulled out of that line with a plain regex
    // rather than a dedicated selector, since the page doesn't give Age
    // its own element anywhere.
    const bioText = document.querySelector("h1")?.nextElementSibling?.textContent || "";
    const ageMatch = bioText.match(/Age\s+(\d+)/);
    const age = ageMatch ? ageMatch[1] : "";

    // Born month/year (added 2026-08-12, Mohsin's ask) - the other half
    // of this exact same bio line ("Age 39, Born June 1987..."), already
    // being read for Age above and thrown away until now. Confirmed live
    // 2026-08-12 the wording is consistent enough to match with one
    // plain regex, same as Age's own.
    const bornMatch = bioText.match(/Born\s+([A-Za-z]+\s+\d{4})/);
    const born = bornMatch ? bornMatch[1] : "";

    // "Current Address Property Details" - present on every real profile
    // checked live, a plain set of label/value pairs, matched by the real
    // column name via labelToHeader above rather than by position (so a
    // profile missing one particular field, e.g. no Subdivision on
    // record, just leaves that one column blank instead of shifting every
    // field after it out of place).
    const property = {};
    if (born) property["Born"] = born;
    const propertySection = document.querySelector("#current-addresses-property");
    if (propertySection) {
      propertySection.querySelectorAll("dl").forEach((dl) => {
        const label = dl.querySelector("dt")?.textContent?.trim() || "";
        const value = dl.querySelector("dd")?.textContent?.trim() || "";
        const header = labelToHeader[label];
        if (header) property[header] = value;
      });
    }

    // Confirmed live 2026-08-11 against the real page (not assumed): the
    // street and city/state/zip here are two separate lines joined by a
    // plain <br>, never a comma - "16275 W Boulder Dr<br>Surprise AZ
    // 85374", not "16275 W Boulder Dr, Surprise AZ 85374". Reading this
    // via plain .textContent (as the earlier version of this file did)
    // collapses that line break into just whitespace, losing the one
    // signal that marks where the street ends and the region begins -
    // that's exactly what left every saved lead's Region blank and its
    // Street holding the whole merged address. Turning the <br> into a
    // real comma before flattening to text is what lets the master
    // file's own Street/Region split (which does expect a comma, matching
    // every other address source this file handles) work correctly here
    // too, without needing two different splitting rules for two sources.
    const addressLink = document.querySelector("#current_address_section h3 a");
    let address = null;
    if (addressLink) {
      const withCommaBreak = addressLink.innerHTML.replace(/<br\s*\/?>/gi, ", ");
      const scratch = document.createElement("div");
      scratch.innerHTML = withCommaBreak;
      address = scratch.textContent.replace(/\s+/g, " ").trim();
    }

    const phones = Array.from(document.querySelectorAll("#phone_number_section dl")).map((dl) => {
      const number = dl.querySelector("dt a")?.textContent?.trim() || "";
      const dds = dl.querySelectorAll("dd");
      const type = dds[0]?.textContent?.trim() || null;
      const reportedText = dds[dds.length - 1]?.textContent?.trim() || "";
      return { number, type, digits: number.replace(/\D/g, ""), reportedText };
    });

    const matched = phones.find((entry) => entry.digits === digits);

    // Record-keeping addition (2026-08-11, Mohsin's call) - separate from
    // and does not relax the client-facing scope rule above: every OTHER
    // number this profile has, beyond the one that was actually searched,
    // still never becomes its own lead, still never goes to the client -
    // this is purely extra context saved alongside the real lead in the
    // master file, for Mohsin/Wasim's own records. The searched number
    // itself is excluded here (it's already the lead's Mobile 1, handled
    // separately) so it's never duplicated into this list.
    const otherMobiles = phones
      .filter((entry) => entry.digits !== digits && /wireless/i.test(entry.type || ""))
      .map((entry) => entry.number);
    const landlines = phones.filter((entry) => /landline/i.test(entry.type || "")).map((entry) => entry.number);

    return {
      name,
      address,
      age,
      property,
      otherMobiles,
      landlines,
      matchedNumber: matched ? matched.number : null,
      matchedType: matched ? matched.type : null,
      matchedReportedText: matched?.reportedText || "",
    };
  }, searchedDigits, PROPERTY_LABEL_TO_HEADER);
}

// "First reported December 2019" -> a plain sortable integer (year*12 +
// month), same shape the old tool used for its own "last reported" text -
// 0 if the searched number isn't listed on this profile at all (loses
// every real comparison rather than crashing).
//
// Unused since the 2026-08-12 "current owner" rewrite - there's only one
// profile now, nothing left to rank against another. Left in place rather
// than deleted, same reasoning as the other candidate-ranking helpers
// above.
function reportedRank(reportedText) {
  const match = reportedText.match(/reported\s+(\w+)\s+(\d{4})/i);
  if (!match) return 0;
  const month = MONTH_NUMBERS[match[1].toLowerCase()] || 0;
  return parseInt(match[2], 10) * 12 + month;
}

// Looks up a phone number on FastPeopleSearch and reads the real lead
// details off the matching person's page - name, address, and that one
// searched number's own type (Wireless/Landline).
//
// Rewritten 2026-08-12 (client scope change, walked through live on a
// real search): the results page names its own "current owner" right at
// the top, hyperlinked straight to their profile - that line is read
// directly and its profile visited, instead of opening and ranking up to
// 5 candidate profiles (the old approach, superseded - see
// MAX_PHONE_CANDIDATES/nameFromCandidateHref/reportedRank above). Client
// confirmed the current-owner line is almost always the right match, and
// explicitly did not want multiple profiles opened - it wastes time
// against a results page that can carry thousands of matches. If that
// line is ever missing (not yet seen live, planned for regardless), the
// number is skipped and settled as "too-many-results" rather than
// guessed at.
//
// Client scope change (2026-08-11): phone mode stops at the one number
// that was searched - it never pulls in whatever other numbers happen to
// sit on that same person's page. One phone in, that one phone's lead out,
// nothing extra riding along. This is a phone-mode-only rule - Address,
// Name, and Skip Trace modes don't exist yet, and this decision says
// nothing about what they should return once they're built.
// No saving, no duplicate checking, no qualifying yet - that's Phase 3.
//
// `slot` (added 2026-08-14, tab-rotation test): which tab this lookup
// runs in - defaults to "A" so every existing caller keeps behaving
// exactly as before. The run screen alternates "A"/"B" itself when
// rotation is turned on; this function doesn't know or care that a
// rotation is happening, it just runs in whichever tab it's told.
async function runPhoneSearch(rawPhone, slot = "A") {
  const digits = String(rawPhone).replace(/\D/g, "");
  if (digits.length !== 10) {
    throw new Error("Enter a 10-digit US phone number.");
  }
  const dashed = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;

  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  // Tracks the last page we know for certain actually loaded, updated at
  // each real navigation below - not a live read of wherever the browser
  // happens to be right now. Purely for error logging (2026-08-12,
  // Mohsin's ask): when something genuinely unexpected goes wrong, we log
  // both where it happened and where things were right before that, so a
  // failure can be traced back to the step that actually caused it rather
  // than just the step that happened to be running when it surfaced.
  let lastKnownUrl = null;
  let p;

  try {
    p = await ensurePage(slot);
    await p.bringToFront();
    throwIfAborted(signal);
    broadcastLog(`Searching FastPeopleSearch for ${dashed}...`);
    await p.goto(`https://www.fastpeoplesearch.com/${dashed}`, { waitUntil: "domcontentloaded" });
    lastKnownUrl = `https://www.fastpeoplesearch.com/${dashed}`;

    // The results page loads its own content in behind a "Loading Search
    // Results…" placeholder, and possibly behind one or two verification
    // walls first. waitForResultsOutcome checks for a real hit and a
    // genuine no-results outcome on every poll tick, side by side - a true
    // negative resolves the moment the page actually settles, rather than
    // always sitting through the full multi-minute timeout first (that
    // full-timeout wait on every negative number was a real, reported bug
    // - see the function's own notes for how this was confirmed safe).
    const outcome = await waitForResultsOutcome(p, RESULTS_WAIT_MS, signal);

    if (outcome === "no-results") {
      broadcastLog("No results found for this number.");
      return { found: false };
    }

    if (outcome === "timeout") {
      broadcastLog("This number's page never fully loaded - giving up on it for now.");
      throw new Error("This number's page never fully loaded (may still be showing a verification check) - try again.");
    }

    // Take a beat and look the results page over before pulling anything
    // off it - a real person doesn't start clicking the instant a page
    // finishes loading.
    try {
      await actLikeSomeoneBrowsing(p, signal, "fastpeoplesearch");
    } catch (err) {
      if (err instanceof StoppedByUserError) throw err;
      // A transient hiccup mid-pace (e.g. the page reloading itself right
      // as a wall clears) shouldn't take down a page that already has real
      // content on it - just skip straight to reading it.
    }

    // Read straight off the results page's own "current owner" line
    // instead of visiting a list of candidate cards (2026-08-12, client
    // scope change - superseded the multi-candidate ranking approach
    // below). FastPeopleSearch already tells you who it thinks the real
    // match is - "The current owner of the phone number ... is <Name>",
    // name hyperlinked straight to their profile - so re-deriving that by
    // opening up to 5 profiles and comparing "reported" dates was wasted
    // work the site had already done for us. Client confirmed this line
    // is almost always the right match, and no longer wants multiple
    // profiles opened at all.
    //
    // The phrase appears twice on a real results page (once here, once
    // repeated inside an FAQ answer further down, alongside a second,
    // unrelated link back to the search itself) - confirmed live
    // 2026-08-12. Matching every element containing the phrase and taking
    // the one with the fewest descendant elements (and an actual link
    // inside it) reliably picks the small, tightly-wrapped sentence this
    // one lives in over the larger FAQ paragraph, without hardcoding a
    // class name FastPeopleSearch could change - same "match by
    // text/shape, not a brittle selector" approach already used for
    // captcha/rate-limit detection above.
    const currentOwner = await p
      .evaluate(() => {
        const matches = Array.from(document.querySelectorAll("body *")).filter(
          (el) =>
            !/^(script|style)$/i.test(el.tagName) &&
            /current owner of the phone number/i.test(el.textContent || "") &&
            el.querySelector("a[href]")
        );
        if (matches.length === 0) return null;
        matches.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
        const link = matches[0].querySelector("a[href]");
        return { href: link.getAttribute("href"), name: link.textContent.trim() };
      })
      .catch(() => null);

    // Fallback: the "current owner" line hasn't been seen missing on a
    // real results page yet (client hasn't hit this case in testing
    // either) - but a heavily-shared number could plausibly show a list of
    // results with no single named owner. Rather than guess at ranking one
    // of them, per the client's explicit instruction this is treated as a
    // final, settled outcome of its own ("too many results"), not a retry
    // - same shape as the existing no-results outcome above.
    if (!currentOwner) {
      broadcastLog("No single current owner shown for this number - too many results, skipping.");
      return { found: false, status: "too-many-results" };
    }

    broadcastLog(`Current owner: ${currentOwner.name} - opening their profile...`);

    // No separate pre-navigation pause here (removed 2026-08-13, Mohsin's
    // ask) - one pause per page, right after it loads (actLikeSomeoneBrowsing
    // above and below), not an extra one stacked on before following the
    // link too.

    // The owner link's href is already a full URL on a real page (unlike
    // a result card's data-link, which is relative) - confirmed live
    // 2026-08-12. Handle either shape rather than assuming one.
    const ownerUrl = /^https?:\/\//i.test(currentOwner.href)
      ? currentOwner.href
      : `https://www.fastpeoplesearch.com${currentOwner.href}`;

    await p.goto(ownerUrl, { waitUntil: "domcontentloaded" });

    const profileLoaded = await waitForRealContent(p, "#full_name_section", PROFILE_WAIT_MS, signal);
    if (!profileLoaded) {
      throw new Error("The current owner's profile never fully loaded (may still be showing a verification check) - try again.");
    }
    lastKnownUrl = ownerUrl;

    try {
      await actLikeSomeoneBrowsing(p, signal, "fastpeoplesearch");
    } catch (err) {
      if (err instanceof StoppedByUserError) throw err;
    }

    const profile = await extractProfile(p, digits);

    // Real bug, fixed 2026-08-14 (Mohsin's catch): a profile loading
    // successfully isn't the same thing as the searched number actually
    // being the number that led here - extractProfile already computes
    // whether the searched digits matched one of this profile's own
    // listed numbers (matchedNumber/matchedType), but this used to return
    // found:true unconditionally regardless of that, so a real mismatch
    // (the "current owner" line pointed at a profile that, once opened,
    // doesn't actually list the number that was searched) got logged as
    // "Done" even though nothing was ever saved for it (the lead-save
    // step downstream only fires on a real wireless-type match, so no
    // data was ever wrongly saved - only the status was wrong). Now
    // treated the same as any other genuine no-record outcome.
    if (!profile.matchedNumber) {
      broadcastLog("Opened the profile, but it doesn't actually list the number that was searched - marking Not Found.");
      return { found: false };
    }

    return {
      found: true,
      name: profile.name,
      address: profile.address,
      age: profile.age,
      property: profile.property,
      // Only the number that was actually searched - not the rest of
      // whatever's on this person's page (client scope change, see the
      // note above runPhoneSearch). otherMobiles/landlines are the one
      // deliberate exception, and only for the master file's own record -
      // see the note on their extraction above for why this doesn't
      // relax that rule.
      phone: profile.matchedNumber,
      phoneType: profile.matchedType,
      otherMobiles: profile.otherMobiles,
      landlines: profile.landlines,
      candidatesChecked: 1,
    };
  } catch (err) {
    // Never log a voluntary Stop - that's not a failure, it's someone
    // clicking a button. Everything else (a genuine timeout, a rate
    // limit, an unexpected page state) gets the full picture sent to the
    // run screen via the status channel - not through the thrown error
    // itself, since a thrown error crossing the IPC boundary back to the
    // renderer arrives stripped down to its bare message text only (see
    // the note on this same behavior elsewhere in this file); the status
    // channel carries a real object through untouched.
    if (!(err instanceof StoppedByUserError)) {
      const currentUrl = await p
        ?.evaluate(() => document.location.href)
        .catch(() => null);
      broadcastStatus("error-detail", {
        message: err.message,
        url: currentUrl || lastKnownUrl,
        previousUrl: lastKnownUrl,
        context: `runPhoneSearch(${dashed})`,
      });
    }
    throw err;
  } finally {
    currentAbortController = null;
  }
}

// --- TruePeopleSearch (phone mode) ---
// Second site, added 2026-08-14. Same job, same master file, same columns
// as FastPeopleSearch's own runPhoneSearch above - only the navigation,
// selectors, and captcha shapes differ, per Mohsin's framing ("just
// another source"). Every selector/URL/text pattern below was confirmed
// live against the real site before being written here, never guessed -
// see claude/site-research/truepeoplesearch.md for the full walkthrough,
// including the real HTML each selector was pulled from and the live
// end-to-end test that validated the ranking logic against an
// independently-known-correct answer.

// No single "current owner" line the way FastPeopleSearch has post its
// 2026-08-12 rewrite - confirmed live 2026-08-14, TruePeopleSearch's
// results page is a plain list of candidate cards with no indication of
// which is most current. Phone mode here goes back to the PRE-rewrite
// approach instead, reusing exactly the helpers that rewrite left in
// place for this reason (MAX_PHONE_CANDIDATES, nameFromCandidateHref,
// reportedRank above) rather than inventing new ones.
const TPS_NO_RESULTS_TEXT = /we could not find any records for that search criteria/i;
// The attribute itself already carries the profile href - no need to
// even read the anchor text/href separately. Scoped to `.card-summary`
// specifically (not a bare `[data-detail-link]` anywhere on the page) -
// a real live bug (2026-08-14, Mohsin's report): a bare attribute
// selector was also picking up one persistent, unrelated element that
// carries the same attribute on every results page regardless of what
// was actually searched - confirmed live across two completely different
// numbers, both times landing on the exact same dead profile ID, which
// 404s as "This record is no longer available." Scoping to the real
// candidate-card class (confirmed live in claude/site-research/
// truepeoplesearch.md's real-HTML section) is the fix; the dead-page
// fast-fail below (waitForTPSProfileOutcome) is the safety net in case
// something like this slips through again for a different reason.
const TPS_CANDIDATE_SELECTOR = ".card-summary[data-detail-link]";
// A candidate profile that's been removed/expired - confirmed live
// 2026-08-14 as the same root cause behind the stray candidate above.
// Checked as a fast-fail alongside "did the real profile load" rather
// than only discovered after sitting through the full timeout - same
// "check the negative on every poll tick" instinct as every other wait
// in this file.
const TPS_RECORD_GONE_TEXT = /this record is no longer available/i;

// TruePeopleSearch's own rate-limit page - two genuinely different
// shapes confirmed live so far, both real, both caught here:
//  1. (2026-08-14) A styled page at `truepeoplesearch.com/ratelimited`
//     (no hyphen - FastPeopleSearch's own equivalent is `/rate-limited`,
//     with one), heading "This IP address has been temporarily
//     rate-limited."
//  2. (2026-08-14, same day) A second, plain-text response served
//     directly AT the profile URL that was actually requested (no
//     redirect, no styled page, often no real <title> either) - "This IP
//     has been rate limited, sorry for the inconvenience. If you are
//     using a VPN please turn it off..." Caught the first check too
//     narrow (`/temporarily rate-limited/i` didn't match this wording at
//     all) - broadened to a plain `/rate.?limited/i` against the body
//     text, which covers both real wordings without needing to
//     special-case each one.
// Reuses the same RateLimitedError the FastPeopleSearch side already
// throws - the run screen's handling of it (pause the whole run, leave
// the row untouched, wait for a proxy change and a manual Resume) is
// already site-agnostic, nothing there needed to change either time.
async function isTPSRateLimited(p) {
  return p
    .evaluate(() => {
      const title = document.title || "";
      const url = document.location ? document.location.href : "";
      const text = document.body ? document.body.innerText.slice(0, 800) : "";
      return /\/ratelimited/i.test(url) || /rate.?limited/i.test(title) || /rate.?limited/i.test(text);
    })
    .catch(() => false);
}
const TPS_RESULTS_WAIT_MS = 60000; // 1 minute, same reasoning/value as FastPeopleSearch's own RESULTS_WAIT_MS
const TPS_PROFILE_WAIT_MS = 60000;

// Profile-page version of the wait above - checks three things on every
// poll tick, not just after a timeout: a genuine dead/removed candidate
// (fails fast, no reason to sit through a minute for a page that will
// never load real content), the real profile actually loading (a plain
// `h1` check - see below for why that's safe despite the dead-record
// page also having one), or a captcha.
//
// `loaded` was briefly tightened to require an actual phone-numbers
// entry specifically (reasoning: a bare `h1` check is what let the
// dead-record page look "loaded" on a first pass) - reverted same day
// after a real live case: a genuine, fully-rendered candidate profile
// (confirmed live via screenshot - real name, address, background report,
// the works) simply has no Phone Numbers section on it at all, so that
// stricter check polled the full timeout waiting for something that was
// never going to appear. Safe to go back to a plain `h1` check because
// `gone` is evaluated in the same pass and checked first by the caller -
// a dead page matching both `gone` and a bare `h1` still correctly
// resolves as "gone", never "loaded". A profile that genuinely has no
// phone section still gets its number-match correctly, downstream:
// extractTPSProfile finds no phone entries at all, matchedNumber comes
// back null, and this candidate is skipped from ranking exactly the same
// as any other real non-match - the timeout-vs-loaded distinction here
// is purely about not stalling, not about correctness of the eventual
// answer.
async function waitForTPSProfileOutcome(p, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let sawCaptcha = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    throwIfPageDead(p);
    if (await isTPSRateLimited(p)) {
      broadcastLog("⛔ TruePeopleSearch rate limit hit.");
      throw new RateLimitedError("truepeoplesearch");
    }

    const state = await p
      .evaluate((goneTextPattern) => {
        const title = document.title || "";
        const text = document.body?.innerText || "";
        return {
          gone: new RegExp(goneTextPattern, "i").test(text) || /404 page not found/i.test(title),
          loaded: !!document.querySelector("h1"),
        };
      }, TPS_RECORD_GONE_TEXT.source)
      .catch(() => ({ gone: false, loaded: false }));

    if (state.gone) return "gone";
    if (state.loaded) {
      if (sawCaptcha) {
        broadcastStatus("captcha-clear");
        await wait(randomBetween(4000, 9000), signal);
      }
      return "loaded";
    }

    const captchaNow = await isCaptchaShowing(p);
    if (captchaNow && !sawCaptcha) {
      sawCaptcha = true;
      broadcastStatus(
        "captcha-waiting",
        "A verification check is showing in the browser window - solve it there. This run continues on its own the moment it clears."
      );
    } else if (!captchaNow && sawCaptcha) {
      sawCaptcha = false;
      broadcastStatus("captcha-clear");
    }

    await wait(CAPTCHA_POLL_MS, signal);
  }

  if (sawCaptcha) broadcastStatus("captcha-clear");
  return "timeout";
}

// Same shape as FastPeopleSearch's own waitForResultsOutcome (checks the
// negative on every poll tick, not just after a full timeout, so a true
// no-results number doesn't sit through the whole wait) - separate
// function because the actual selectors/text are entirely different on
// this site, not because the logic needs to differ.
async function waitForTPSResultsOutcome(p, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let sawCaptcha = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    throwIfPageDead(p);
    // TruePeopleSearch's own rate-limit page - confirmed live 2026-08-14
    // (Mohsin caught a real one, closing the gap this comment used to
    // flag as "not yet seen"). See isTPSRateLimited's own note for the
    // real URL/text signals.
    if (await isTPSRateLimited(p)) {
      broadcastLog("⛔ TruePeopleSearch rate limit hit.");
      throw new RateLimitedError("truepeoplesearch");
    }

    const state = await p
      .evaluate((candidateSel, noResultsPattern) => {
        const text = document.body?.innerText || "";
        return {
          hasResults: document.querySelectorAll(candidateSel).length > 0,
          isNoResults: new RegExp(noResultsPattern, "i").test(text),
        };
      }, TPS_CANDIDATE_SELECTOR, TPS_NO_RESULTS_TEXT.source)
      .catch(() => ({ hasResults: false, isNoResults: false }));

    if (state.hasResults || state.isNoResults) {
      if (sawCaptcha) {
        broadcastStatus("captcha-clear");
        await wait(randomBetween(4000, 9000), signal);
      }
      return state.hasResults ? "has-results" : "no-results";
    }

    const captchaNow = await isCaptchaShowing(p);
    if (captchaNow && !sawCaptcha) {
      sawCaptcha = true;
      broadcastStatus(
        "captcha-waiting",
        "A verification check is showing in the browser window - solve it there. This run continues on its own the moment it clears."
      );
    } else if (!captchaNow && sawCaptcha) {
      sawCaptcha = false;
      broadcastStatus("captcha-clear");
    }

    await wait(CAPTCHA_POLL_MS, signal);
  }

  if (sawCaptcha) broadcastStatus("captcha-clear");
  return "timeout";
}

// Every property field on this site follows one uniform shape -
// `{Label}<br><b>{Value}</b>` - confirmed live 2026-08-14 (see the
// research file's real-HTML section), unlike FastPeopleSearch's own
// messier layout which needed PROPERTY_LABEL_TO_HEADER's hand-written
// mapping. Reuses that same map here anyway (rather than a second one)
// since the label text itself is identical between the two sites for
// every field they share - only "Lot Square Feet" (this site's own
// wording) needs its own entry alongside FastPeopleSearch's "Lot SqFt.".
const TPS_PROPERTY_LABEL_TO_HEADER = {
  ...PROPERTY_LABEL_TO_HEADER,
  "Lot Square Feet": "Lot SQ FT",
};

// Reads everything this project's master file needs off one real profile
// page - name, address, age/born, every property-detail field, email if
// present, and every phone number listed (to find the searched one and
// rank this candidate against the others). Mirrors extractProfile above
// field-for-field; only the selectors differ.
async function extractTPSProfile(p, searchedDigits) {
  return p.evaluate((digits, labelToHeader) => {
    const name = document.querySelector("h1")?.textContent?.trim() || null;

    // Same combined "Age X, Born Month Year" bio line as FastPeopleSearch -
    // but NOT the <h1>'s next sibling (a real bug, fixed 2026-08-14,
    // Mohsin's catch: Age/Born were coming back blank on real runs). The
    // real markup is `<h1>Name</h1><div class="d-sm-none mt-0"></div>
    // <span>Age X, Born Month Year<br>Lives in City, ST</span>...` - the
    // element right after the h1 is an EMPTY div, not the bio span, so
    // reading its textContent always returned "". Found by matching the
    // actual text pattern among the h1's sibling spans instead of trusting
    // sibling position, which is exactly the kind of fragile assumption
    // this project's "match by text/shape, not a brittle selector" habit
    // exists to avoid - this one slipped through by copying
    // FastPeopleSearch's own (correct, for that site's own real markup)
    // approach without re-checking it against this site's actual HTML.
    const bioSpan = Array.from(document.querySelector("h1")?.parentElement?.querySelectorAll("span") || []).find((s) =>
      /^\s*Age\b/i.test(s.textContent || "")
    );
    const bioText = bioSpan?.textContent || "";
    const ageMatch = bioText.match(/Age\s+(\d+)/);
    const age = ageMatch ? ageMatch[1] : "";
    const bornMatch = bioText.match(/Born\s+([A-Za-z]+\s+\d{4})/);
    const born = bornMatch ? bornMatch[1] : "";

    // Street/city/state/zip separated by a literal <br>, same technique
    // as FastPeopleSearch's own address extraction - turn it into a comma
    // before flattening to text so the master file's Street/Region split
    // (which expects a comma) works unchanged.
    const addressLink = document.querySelector('a[data-link-to-more="address"]');
    let address = null;
    if (addressLink) {
      const withCommaBreak = addressLink.innerHTML.replace(/<br\s*\/?>/gi, ", ");
      const scratch = document.createElement("div");
      scratch.innerHTML = withCommaBreak;
      address = scratch.textContent.replace(/\s+/g, " ").trim();
    }

    // Property details - one uniform shape, `{Label}<br><b>{Value}</b>`,
    // confirmed live to cover all 16 fields with a single loop (no
    // per-field selector needed). "N/A" is the site's own literal text
    // for a field it doesn't have data for (confirmed live) - treated the
    // same as genuinely blank, never saved as the literal string.
    const property = {};
    if (born) property["Born"] = born;
    Array.from(document.querySelectorAll("b")).forEach((b) => {
      const container = b.parentElement;
      if (!container) return;
      // The label is the container's own leading text node, before the
      // <br><b>...</b> - reading container.childNodes[0] rather than
      // container.textContent avoids also picking up the value itself.
      const label = container.childNodes[0]?.textContent?.trim() || "";
      const header = labelToHeader[label];
      if (!header) return;
      const value = b.textContent.trim();
      if (value && value !== "N/A") property[header] = value;
    });

    // Email Addresses section is entirely absent (not just empty) on a
    // profile with no known email - confirmed live 2026-08-14 (different
    // missing-data shape than property's own "N/A" convention). Located
    // by its heading text rather than a class name, matching this
    // project's existing "match by text/shape, not a brittle selector"
    // approach for anything without a clean id/data-attribute to key off.
    let email = null;
    const emailHeading = Array.from(document.querySelectorAll("h2")).find((h) => /Email Addresses/i.test(h.textContent || ""));
    if (emailHeading) {
      const row = emailHeading.closest(".row")?.parentElement;
      const emailDiv = row?.querySelector(".row.pl-sm-2 .col div");
      email = emailDiv?.textContent?.trim() || null;
    }

    const phones = Array.from(document.querySelectorAll('a[data-link-to-more="phone"]')).map((a) => {
      const number = a.textContent.trim();
      const digitsOnly = number.replace(/\D/g, "");
      // Type sits in the sibling "- <span class='smaller'>Wireless</span>"
      // text right after the link, inside the same parent.
      const afterLink = a.parentElement?.textContent || "";
      const typeMatch = afterLink.match(/-\s*([A-Za-z]+)/);
      const type = typeMatch ? typeMatch[1] : null;
      const reportedBlock = a.parentElement?.querySelector(".dt-ln")?.textContent || "";
      return { number, type, digits: digitsOnly, reportedText: reportedBlock };
    });

    const matched = phones.find((entry) => entry.digits === digits);
    const otherMobiles = phones
      .filter((entry) => entry.digits !== digits && /wireless/i.test(entry.type || ""))
      .map((entry) => entry.number);
    const landlines = phones.filter((entry) => /landline/i.test(entry.type || "")).map((entry) => entry.number);

    return {
      name,
      address,
      age,
      property,
      email,
      otherMobiles,
      landlines,
      matchedNumber: matched ? matched.number : null,
      matchedType: matched ? matched.type : null,
      matchedReportedText: matched?.reportedText || "",
    };
  }, searchedDigits, TPS_PROPERTY_LABEL_TO_HEADER);
}

// Locked shape (Mohsin, 2026-08-14, walked through live against a real
// 4-candidate number pulled from a genuine past leads export - see the
// research file for the full validated example): search -> collect up to
// MAX_PHONE_CANDIDATES real candidate profiles -> open each, check
// whether the searched number is actually listed there (confirmed live
// that not every "candidate" the results page shows actually has the
// number - roughly 1 in 4 in the real test) -> among the real matches,
// keep whichever has the most recent "Last reported" date -> only that
// one profile's data gets saved. No single match among the checked
// candidates is a genuine Not Found, not guessed at.
//
// `slot` (same convention as FastPeopleSearch's own runPhoneSearch) -
// which tab this lookup runs in, defaults to "A".
async function runPhoneSearchTruePeopleSearch(rawPhone, slot = "A") {
  const digits = String(rawPhone).replace(/\D/g, "");
  if (digits.length !== 10) {
    throw new Error("Enter a 10-digit US phone number.");
  }
  const tpsFormatted = `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;

  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  let lastKnownUrl = null;
  let p;

  try {
    p = await ensurePage(slot);
    await p.bringToFront();
    throwIfAborted(signal);
    broadcastLog(`Searching TruePeopleSearch for ${tpsFormatted}...`);
    const resultsUrl = `https://www.truepeoplesearch.com/resultphone?phoneno=${tpsFormatted}`;
    await p.goto(resultsUrl, { waitUntil: "domcontentloaded" });
    lastKnownUrl = resultsUrl;

    const outcome = await waitForTPSResultsOutcome(p, TPS_RESULTS_WAIT_MS, signal);

    if (outcome === "no-results") {
      broadcastLog("No results found for this number.");
      return { found: false };
    }
    if (outcome === "timeout") {
      broadcastLog("This number's page never fully loaded - giving up on it for now.");
      throw new Error("This number's page never fully loaded (may still be showing a verification check) - try again.");
    }

    try {
      await actLikeSomeoneBrowsing(p, signal, "truepeoplesearch");
    } catch (err) {
      if (err instanceof StoppedByUserError) throw err;
    }

    // Dedupe by href before taking the first N - see TPS_CANDIDATE_SELECTOR's
    // own note above for why a raw element count can't be trusted here.
    const candidateHrefs = await p
      .evaluate((sel) => {
        const seen = [];
        document.querySelectorAll(sel).forEach((el) => {
          const href = el.getAttribute("data-detail-link");
          if (href && !seen.includes(href)) seen.push(href);
        });
        return seen;
      }, TPS_CANDIDATE_SELECTOR)
      .catch(() => []);

    const candidates = candidateHrefs.slice(0, MAX_PHONE_CANDIDATES);
    broadcastLog(
      `${candidates.length} candidate${candidates.length === 1 ? "" : "s"} to check` +
        (candidateHrefs.length > candidates.length ? ` (capped at ${MAX_PHONE_CANDIDATES})` : "") +
        "..."
    );

    let best = null; // { profile, rank }
    for (const href of candidates) {
      throwIfAborted(signal);
      const profileUrl = `https://www.truepeoplesearch.com${href}`;
      broadcastLog(`Checking ${nameFromCandidateHref(href)}...`);
      await p.goto(profileUrl, { waitUntil: "domcontentloaded" });
      lastKnownUrl = profileUrl;

      const profileOutcome = await waitForTPSProfileOutcome(p, TPS_PROFILE_WAIT_MS, signal);
      if (profileOutcome === "gone") {
        // A real, live case (2026-08-14) - the results page can list a
        // candidate whose actual profile has been removed/expired. Fails
        // fast rather than sitting through the full timeout waiting for
        // content that will never load.
        broadcastLog("This candidate's record is no longer available - skipping it.");
        continue;
      }
      if (profileOutcome === "timeout") {
        // A single candidate failing to load (still-showing verification,
        // a genuinely slow page) shouldn't sink the whole number - skip
        // just this one candidate and keep checking the rest, same
        // "don't let one bad step end the search" instinct as elsewhere
        // in this file.
        broadcastLog("This candidate's profile never fully loaded - skipping it.");
        continue;
      }

      try {
        await actLikeSomeoneBrowsing(p, signal, "truepeoplesearch");
      } catch (err) {
        if (err instanceof StoppedByUserError) throw err;
      }

      const profile = await extractTPSProfile(p, digits);
      if (!profile.matchedNumber) continue; // this candidate doesn't actually list the number - not a real match

      const rank = reportedRank(profile.matchedReportedText);
      if (!best || rank > best.rank) {
        best = { profile, rank };
      }
    }

    if (!best) {
      broadcastLog("None of the candidates actually listed this number - marking Not Found.");
      return { found: false };
    }

    const profile = best.profile;
    return {
      found: true,
      name: profile.name,
      address: profile.address,
      age: profile.age,
      property: profile.property,
      phone: profile.matchedNumber,
      phoneType: profile.matchedType,
      otherMobiles: profile.otherMobiles,
      landlines: profile.landlines,
      candidatesChecked: candidates.length,
    };
  } catch (err) {
    if (!(err instanceof StoppedByUserError)) {
      const currentUrl = await p
        ?.evaluate(() => document.location.href)
        .catch(() => null);
      broadcastStatus("error-detail", {
        message: err.message,
        url: currentUrl || lastKnownUrl,
        previousUrl: lastKnownUrl,
        context: `runPhoneSearchTruePeopleSearch(${tpsFormatted})`,
      });
    }
    throw err;
  } finally {
    currentAbortController = null;
  }
}

module.exports = {
  runPhoneSearch,
  runPhoneSearchTruePeopleSearch,
  resetCookies,
  requestStop,
  onStatus,
  closeBrowser,
  closeTab,
  prepareBrowserForRun,
};
