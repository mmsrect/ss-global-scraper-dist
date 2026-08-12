# SmartScale Global Scraper — Install & Start

This folder is the whole app. There's no separate installer yet — you run
it directly from here. You'll need an access key from your admin before
you can sign in; if you don't have one, ask them first.

## Before you start (both Mac and Windows)

- **Google Chrome must already be installed** on this computer — the app
  drives a copy of it to do the scraping.
- **Node.js must be installed.** If you're not sure, open a terminal
  (see below) and type `node -v`. If you see a version number, you're
  set — skip to the next section. If not, download and install the
  **LTS** version from [nodejs.org](https://nodejs.org), then come back
  here.

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
