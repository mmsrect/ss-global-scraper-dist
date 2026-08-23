// Drives the real Chrome binary directly over its own remote-debugging
// port, talking raw Chrome DevTools Protocol - no Puppeteer, no
// Puppeteer-extra, no stealth plugin anywhere in this file.
//
// Why (2026-08-11, found via real research after the stealth-plugin and
// CDP-leak-patched builds both still lost to the same verification wall
// even with Mohsin solving it by hand): sites like the one this app
// targets don't only look at what a page's JavaScript reports about
// itself - they can also recognize the startup "handshake" that
// automation frameworks send the moment they attach to a browser
// (specifically two calls, Runtime.enable and Target.setAutoAttach, that
// Puppeteer and Playwright both send automatically as part of how they
// track pages/frames internally - patching what a page reports about
// itself afterward doesn't touch this, because the tell already happened
// before any page code ran). A real, everyday Chrome window opened by a
// person, or one only ever spoken to with plain, direct devtools-style
// commands, never sends that handshake at all. This file is that second
// thing - the same real Chrome application, opened with its own
// debugging port and nothing else unusual, driven with only the small,
// specific commands each action actually needs.
//
// Deliberately narrow surface - only what engine.js actually uses
// (goto, evaluate, a couple of DOM checks, mouse movement, bring to
// front, open/close tabs). Shaped to be a drop-in replacement for the
// small slice of Puppeteer's page/browser objects the rest of the file
// already calls, so nothing about the scraping logic itself had to
// change.

const { spawn } = require("child_process");
const WebSocket = require("ws");

const CDP_HOST = "127.0.0.1";

// Ad-blocking at the network layer - TRIED AND REVERTED (2026-08-12).
// Added after a real Windows test got stuck on an ad-heavy page, then
// pulled back out the same day after live testing showed real evidence
// it was making things worse, not better: Chrome's own DevTools console
// showed 40 "Request was blocked by DevTools" lines on a single page
// that then never finished loading. Most likely mechanism - never fully
// confirmed, but concrete enough not to risk shipping - is that
// Cloudflare's own bot-check may watch for some of these same ad-network
// calls completing as part of what it's waiting on before clearing, so
// blocking them can leave a check waiting forever on a signal that's
// never coming. If ad-driven slowness needs solving again later, a
// softer approach (throttling instead of outright blocking specific
// domains, or blocking only after confirming exactly which one is
// actually needed vs. safe to drop) would need real evidence per domain
// first, not a blanket list like this one was.

// Real live bug (2026-08-12, Mohsin's report - a run showing "Checking
// match X..." in the terminal but sitting frozen, the browser window
// itself never moving off the page it was already on): every single
// command this file sends to the browser - a click, a page read, a mouse
// move, all of it - goes through send() below, and it had no time limit
// of its own at all. On the rare tick where Chrome just doesn't reply to
// one particular command, the promise waiting on it never resolves or
// rejects, so whatever step was mid-flight (a click, a profile read) just
// hangs indefinitely - not even the Stop button can interrupt an already
// in-flight command, since Stop only affects the waits this file
// explicitly checks between steps. A firm ceiling here is what turns that
// from an unrecoverable freeze into a normal, bounded failure - one the
// run already knows how to handle (skip this number and keep going, or a
// clean retry via the existing click-then-fallback-to-goto path).
const SEND_TIMEOUT_MS = 20000;

function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function waitForDebuggerReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${CDP_HOST}:${port}/json/version`);
      if (res.ok) return true;
    } catch {
      // Chrome hasn't opened its debugging port yet - keep polling.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// One raw CDP connection to a single page target. Every command is sent
// and awaited individually - no domain is ever "enabled" unless a
// specific feature genuinely needs it (none currently do; Runtime.evaluate,
// Page.navigate, Input.dispatchMouseEvent, and Page.bringToFront all work
// as plain one-off commands without their domain being switched on first).
class CdpSession {
  constructor(wsUrl, targetId) {
    this.targetId = targetId;
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      }
    });
    this.ws.on("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.ready;
    if (this.closed) throw new Error("CDP connection closed");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for the browser to respond to ${method}.`));
      }, SEND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closing/closed
    }
  }
}

// Wraps one CdpSession as a Puppeteer-Page-shaped object - just the
// handful of methods engine.js actually calls.
function wrapPage(session, targetId, fixedViewport, cache) {
  let closed = false;
  // Real live bug (2026-08-11): a Cloudflare-style "Are you human?"
  // redirect can tear down the tab's underlying CDP target entirely
  // rather than navigating the same one in place - the WebSocket this
  // page is built on closes out from under it, with no call to this
  // wrapper's own .close() ever happening. isClosed() used to only ever
  // reflect that local flag, so ensurePage() (which trusts isClosed() to
  // decide whether to reuse this page or open a fresh one) kept handing
  // back a page whose connection was already dead - every search after
  // that point failed immediately with "CDP connection closed" instead of
  // the run recovering with a fresh tab, which is exactly what Mohsin hit
  // live. Checking the session's own closed state here is what makes an
  // externally-torn-down target actually count as closed.
  const isClosed = () => closed || session.closed;

  async function evaluate(fn, ...args) {
    const fnText = typeof fn === "function" ? fn.toString() : String(fn);
    const argsJson = args.map((a) => JSON.stringify(a)).join(", ");
    const expression = `(${fnText})(${argsJson})`;
    const result = await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation error";
      throw new Error(desc);
    }
    return result.result?.value;
  }

  let lastMouse = { x: 0, y: 0 };

  const mouse = {
    async move(x, y, { steps = 1 } = {}) {
      const from = lastMouse;
      for (let i = 1; i <= steps; i++) {
        const ix = from.x + ((x - from.x) * i) / steps;
        const iy = from.y + ((y - from.y) * i) / steps;
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: ix,
          y: iy,
          button: "none",
        });
      }
      lastMouse = { x, y };
    },
  };

  return {
    isClosed,

    async bringToFront() {
      await session.send("Page.bringToFront");
    },

    async goto(url, { waitUntil } = {}) {
      await session.send("Page.navigate", { url });
      // Not listening for the Page domain's own load events on purpose
      // (that's Page.enable - the same category of "framework announcing
      // itself" this file exists to avoid). A short poll for the document
      // settling is the plain-CDP-safe equivalent of Puppeteer's
      // domcontentloaded, and everything downstream already polls for its
      // own real content on top of this anyway.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const state = await evaluate(() => document.readyState);
          if (state === "interactive" || state === "complete") break;
        } catch {
          // page mid-navigation, not queryable yet - keep polling
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },

    evaluate,

    async $(selector) {
      const found = await evaluate((sel) => document.querySelector(sel) !== null, selector);
      return found ? { selector } : null;
    },

    viewport() {
      return fixedViewport;
    },

    mouse,

    // Currently unused (2026-08-12, later same day) - engine.js's
    // candidate-visiting loop went back to direct href navigation, the
    // click+back-navigation approach below it was built for didn't work
    // well live. Left in place rather than deleted, in case it's worth
    // revisiting later; not currently called from anywhere.
    //
    // Real click at an element's actual on-screen position - genuine
    // Input.dispatchMouseEvent press/release, the same input-layer event
    // a real click produces, not a synthetic el.click() call (which
    // leaves its own tell - event.isTrusted is false on a JS-triggered
    // click, true on this). Added 2026-08-12 (Mohsin's call): the
    // candidate-visiting loop used to jump straight to each profile's own
    // URL in turn, which is not how a person actually works through a
    // list of links - they click one, read it, go back, click the next.
    // Scrolls the target into view first (mirrors a person who has to
    // find the link on the page before clicking it), picks a point
    // slightly off-center within the element rather than its exact
    // midpoint every time, and genuinely moves the mouse there first via
    // the same stepped movement humanMouseWander already uses, before
    // pressing and releasing.
    // Root-caused live 2026-08-12 (Mohsin reported the run going silent
    // for minutes at a time, browser window frozen on the same page) by
    // running the exact same search directly and watching it happen: the
    // click was landing on exactly the right element - confirmed via a
    // direct elementFromPoint check right before dispatching - but the
    // page still never navigated on the third candidate in a row. The
    // coordinates are measured once, then the mouse spends 200-400ms
    // actually moving into position (the human-paced steps above) before
    // the press/release fires - long enough for something on the page
    // (a lazily-loaded card lower down, an ad slot) to shift the layout
    // out from under an already-computed point. The click was never the
    // problem on its own; the real bug was that nothing here ever
    // *checked* whether it worked - a click that silently landed on
    // nothing looked identical to a successful one, so the caller moved
    // straight on to waiting for the next page, which was never coming.
    // That's the exact shape of the multi-minute "stuck" report.
    //
    // Fix: after clicking, confirm the URL actually changed. If it
    // didn't, the page most likely shifted mid-click - re-measure fresh
    // coordinates and try again rather than trusting the first attempt.
    // Only after every attempt fails does this throw, which is what lets
    // the caller's existing fallback (a direct URL navigate) take over
    // immediately instead of sitting through a long silent wait first.
    // `options.confirm` (2026-08-23) - how this click knows it landed.
    //
    // The URL check below was written for links that navigate, and every
    // caller until now was one. Prop Wire's "Next page" is not: it re-renders
    // the results in place and leaves the address bar exactly as it was, so a
    // click that worked perfectly looked like three failed attempts and threw.
    //
    // A caller that clicks something non-navigational passes its own proof
    // instead - an async predicate polled after each attempt. The retry
    // behaviour (three goes, fresh coordinates each time, because the page can
    // shift under the pointer mid-click) is the valuable part and is kept
    // identical for both kinds.
    async click(selector, options = {}) {
      const { confirm = null, confirmTimeoutMs = 10000 } = options;
      const beforeUrl = confirm ? null : await evaluate(() => document.location.href);
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const rect = await evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: "center", behavior: "instant" });
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }, selector);
        if (!rect || rect.width === 0 || rect.height === 0) {
          throw new Error(`No visible element found for selector: ${selector}`);
        }

        const targetX = rect.x + rect.width * (0.35 + Math.random() * 0.3);
        const targetY = rect.y + rect.height * (0.35 + Math.random() * 0.3);
        await mouse.move(targetX, targetY, { steps: 10 + Math.floor(Math.random() * 8) });
        await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));

        await session.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: targetX,
          y: targetY,
          button: "left",
          clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: targetX,
          y: targetY,
          button: "left",
          clickCount: 1,
        });

        if (confirm) {
          // The caller's own proof, polled rather than waited out once - an
          // in-page re-render can take a moment longer than a navigation and
          // there is no URL to watch for it.
          const startedAt = Date.now();
          let landed = false;
          while (Date.now() - startedAt < confirmTimeoutMs) {
            await new Promise((r) => setTimeout(r, 200));
            if (await confirm().catch(() => false)) {
              landed = true;
              break;
            }
          }
          if (landed) return;
        } else {
          // Real navigations start fast - a second is generous for the URL
          // to have actually changed if this click genuinely landed.
          await new Promise((r) => setTimeout(r, 900));
          const afterUrl = await evaluate(() => document.location.href).catch(() => beforeUrl);
          if (afterUrl !== beforeUrl) return; // worked - most attempts resolve here on the first try
        }

        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
        }
      }

      throw new Error(
        confirm
          ? `Click on ${selector} didn't change the page after ${maxAttempts} attempts.`
          : `Click on ${selector} didn't navigate anywhere after ${maxAttempts} attempts.`
      );
    },

    async close() {
      if (closed) return;
      closed = true;
      cache.delete(targetId);
      session.close();
      try {
        await fetch(`http://${CDP_HOST}:${session.port}/json/close/${targetId}`);
      } catch {
        // best-effort - the browser closing entirely will clean this up too
      }
    },
  };
}

// Reused across pages()/newPage() calls, keyed by Chrome's own target id -
// without this, every call to pages() would hand back a brand-new wrapper
// object for the exact same real tab, and engine.js's "close every tab
// except the one I just opened" check (which compares by object identity,
// the same way it would against Puppeteer's own cached Page objects)
// would never recognize its own tab as itself - closing the one it meant
// to keep (the actual live bug this fixes).
async function connectToTarget(port, targetId, wsUrl, fixedViewport, cache) {
  if (cache.has(targetId)) return cache.get(targetId);
  const session = new CdpSession(wsUrl, targetId);
  session.port = port;
  await session.ready;
  // Same reasoning as isClosed() above - a target that gets torn down
  // externally (not via this file's own .close()) should still stop
  // being handed back by a later pages()/newPage() lookup, not just by
  // ensurePage()'s isClosed() check.
  session.ws.on("close", () => cache.delete(targetId));

  const wrapped = wrapPage(session, targetId, fixedViewport, cache);
  cache.set(targetId, wrapped);
  return wrapped;
}

// Launches the real Chrome binary with a deliberately small, ordinary
// flag set - a debugging port and a profile folder, nothing that an
// automation framework would normally add (no --enable-automation, no
// disabled-feature bundle). This is what keeps navigator.webdriver false
// and the "controlled by automated software" banner from ever appearing,
// natively, rather than patching either one after the fact.
async function launch({ executablePath, userDataDir, windowArgs, extraArgs = [] }) {
  const port = randomPort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...windowArgs,
    ...extraArgs,
  ];

  const child = spawn(executablePath, args, { stdio: "ignore" });

  const debuggerReady = await waitForDebuggerReady(port);
  if (!debuggerReady) {
    child.kill();
    throw new Error("Chrome didn't open its debugging port in time.");
  }

  let disconnectHandler = null;
  child.on("exit", () => {
    if (disconnectHandler) disconnectHandler();
  });

  const windowSizeMatch = windowArgs.join(" ").match(/--window-size=(\d+),(\d+)/);
  const fixedViewport = windowSizeMatch
    ? { width: parseInt(windowSizeMatch[1], 10), height: parseInt(windowSizeMatch[2], 10) }
    : { width: 1280, height: 800 };

  const pageCache = new Map();

  return {
    process: child,
    port,
    connected: true,
    on(event, handler) {
      if (event === "disconnected") disconnectHandler = handler;
    },
    async pages() {
      const res = await fetch(`http://${CDP_HOST}:${port}/json/list`);
      const list = await res.json();
      const pageTargets = list.filter((t) => t.type === "page");
      return Promise.all(
        pageTargets.map((t) => connectToTarget(port, t.id, t.webSocketDebuggerUrl, fixedViewport, pageCache))
      );
    },
    async newPage() {
      // Chrome's devtools port rejects this one specific request unless
      // it arrives as PUT (a hardening change in recent versions - every
      // other endpoint here still accepts a plain GET).
      const res = await fetch(`http://${CDP_HOST}:${port}/json/new?about:blank`, { method: "PUT" });
      const target = await res.json();
      return connectToTarget(port, target.id, target.webSocketDebuggerUrl, fixedViewport, pageCache);
    },
    async close() {
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  };
}

module.exports = { launch };
