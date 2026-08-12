# SmartScale Global Scraper — Install & Start

This folder is the whole app. There's no separate installer yet — you run
it directly from here. You'll need an access key from your admin before
you can sign in; if you don't have one, ask them first.

## Before you start (both Mac and Windows)

- **Google Chrome must already be installed** on this computer — the app
  drives a copy of it to do the scraping.
- **Node.js must be installed — and it needs to be the LTS version, not
  the newest one.** Open a terminal (see below) and type `node -v`.
  - If nothing happens / it says the command isn't found, install
    Node.js from [nodejs.org](https://nodejs.org) — the button labeled
    **LTS**, not "Current."
  - If you get a version number, check it: **it needs to start with 22
    or lower (v22.x, v20.x, etc.) — not v23 or higher.** A too-new
    version installs fine but breaks one specific step later in a way
    that's confusing to diagnose (see the troubleshooting section at the
    bottom). If yours is too new, install the LTS version from the link
    above over it, then re-check with `node -v`.

## Windows

1. Copy this whole folder anywhere on your computer (Desktop, Documents,
   wherever's convenient).
2. Open the folder in File Explorer, click the address bar, type `cmd`,
   and press Enter — this opens a Command Prompt already inside the
   folder.
3. Type this and press Enter (only needed once, the first time):
   ```
   npm install
   ```
   This takes a few minutes the first time. You'll see a lot of text
   scroll by — that's normal.
4. Once that finishes, type:
   ```
   npm start
   ```
   The app window should open.
5. Enter your access key when asked. You won't need to enter it again
   on this computer after that.

**To run it again later:** repeat step 4 only (`npm start` inside the
same folder) — no need to run `npm install` again unless you're told
the app has been updated.

## Mac

1. Copy this whole folder anywhere on your computer (Desktop, Documents,
   wherever's convenient).
2. Open **Terminal** (search for it with Spotlight — Cmd+Space, type
   "Terminal").
3. Type `cd ` (with a trailing space), then drag this folder from Finder
   straight into the Terminal window — it fills in the path for you.
   Press Enter.
4. Type this and press Enter (only needed once, the first time):
   ```
   npm install
   ```
   This takes a few minutes the first time. You'll see a lot of text
   scroll by — that's normal.
5. Once that finishes, type:
   ```
   npm start
   ```
   The app window should open. If macOS shows a security warning about
   an unidentified developer, right-click the app in the warning and
   choose "Open" — you'll only need to do that once.
6. Enter your access key when asked. You won't need to enter it again
   on this computer after that.

**To run it again later:** repeat step 5 only (`npm start` inside the
same folder) — no need to run `npm install` again unless you're told
the app has been updated.

## Getting an update

For now, updating means getting a fresh copy of this whole folder from
your admin and running `npm install` again inside it (same as first-time
setup) — there's no in-app update button yet.

## Something not working?

Screenshot whatever you're seeing (the error message, or what the screen
looks like) and send it to your admin rather than trying to fix it
yourself — most issues are quick to diagnose with a screenshot in hand.

### One specific error worth knowing about

If `npm start` shows something like:

```
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
```

...deleting and reinstalling **will not fix it** if it's caused by what
it usually is: too new a Node.js version (see the checklist at the top).
The real fix:

1. Install the **LTS** version of Node.js from
   [nodejs.org](https://nodejs.org), replacing whatever's there now.
2. In this folder, delete the `node_modules` folder and the
   `package-lock.json` file.
3. Run `npm install` again, then `npm start`.

If it still happens after that, screenshot the error and send it to your
admin rather than guessing further.
