# Flashcards

A flashcard app for you to rehearse your study notes interactively. You can use it with any question-and-answer material.

Flashcards reads your notes organized as question-and-answer pairs in Markdown and runs a local web app for you to practice. It shuffles the pairs so you can test your recall. There’s no manual import, account to create, or database to maintain.

This prototype has no spaced repetition or saved study progress.

> This is a **local prototype**, not a production-ready service. It is fully authored by AI.

![Example](docs/images/example.png)

## Quick start

You’ll need **Node.js 22.12+** and **npm**.

1. **Clone or download this project**, then open a terminal in the project folder.

2. **Install dependencies.**

```sh
npm ci
```

This installs the project’s dependencies in `node_modules/`.

3. **Add your cards.**

Create a folder for your materials:

```sh
mkdir -p materials
```

Then create `materials/practice.md` with these sample cards:

```md
# question
What does “once in a blue moon” mean?

# answer
Very rarely.

---

# question
How would you say “I like reading” more naturally?

# answer
I'm **an avid reader**.
```

`# question` and `# answer` are the headings Flashcards uses to identify your pairs. They are case insensitive, and each needs some content under it. You can use lists, quotes, code blocks, and deeper headings (`##` and below) in your questions and answers.

You can keep multiple Markdown files in `materials/`, including subfolders. You can practice them all together or choose a single file in the app.

If any file has a formatting error when loaded, practice shows you where to fix it. Fix and save the file, then refresh the browser.

> The `---` line is **optional**; you can use it to separate cards visually.

> Edits made on materials requires refreshing to load changes.

> `materials/`, its subfolders, and individual Markdown files may be symbolic links. 

> Only files whose name ends in `.md` (case-insensitive) are loaded; other files are skipped.

4. **Start the app.**

```sh
npm run dev
```

If you already have cards in another folder, you can point Flashcards to it:

```sh
MATERIALS_DIR=/path/to/cards npm run dev
```

5. **Start practicing.**

Open [127.0.0.1:5173](http://127.0.0.1:5173).

You can reveal an answer, hide it again, move to the next question, or revisit the previous one. Each card shows its source file and line number so you can find it in your notes. The material selector lets you choose what to practice, and a subtle bottom strip shows how much of the shuffled round remains.

Use **Add**, **Remove**, and **Edit** at the bottom-right to change cards. Add offers filtered file suggestions and always includes **Default** (`default.md`). Enter a new name to create a `file_name.md` file. Edit keeps your place and answer visibility; Remove asks for confirmation and archives the exact entry in `removed.md`, which is excluded from practice. In-app changes update the current round immediately; additions join its end when they match the current filter.

Each browser page holds its own snapshot. If another page or editor changes a destination file, saving reports a conflict and retains the dialog text. Copy any unsaved text before refreshing, since refresh starts a new shuffled round. No identifiers are embedded in your Markdown. Writes preserve symbolic links and untouched file content. Run one server per materials folder; revision checks do not lock out unrelated editors during the brief write operation.

Removal uses a `.flashcards-removal.json` recovery journal in the materials folder. If interrupted, the server completes the pending removal on the next read, write, or startup. If recovery detects conflicting external edits, it fails explicitly and retains the journal for manual recovery; keep that file until the source and archive have been checked. This protects against interrupted application writes, but does not promise durability through a power loss.

Press **Space** to reveal or advance, **←** to revisit, and **→** to advance.

> The server defaults to `127.0.0.1:5173`; set `HOST` and `PORT` to change it.

> For appearance tweaks, see the variables at the top of [src/style.css](src/style.css). The file selector and shared Add/Edit panel default widths are viewport ratios; a saved file-selector width takes precedence, and panel minimums still apply.

## OneDrive Personal and static hosting

The browser can connect directly to OneDrive Personal, without a card server. It creates or reuses **My Flashcards** in your OneDrive root by default. Click the current folder name to choose an existing folder using Microsoft’s OneDrive picker; its Markdown subfolders are included. The picker opens in a side pane and may ask for a separate Microsoft sign-in the first time. Use the same account as the app, then click the folder name again after returning. This ordinary folder is app-managed by convention, not Microsoft's permission-isolated App Folder. The selected folder is remembered for the browser session. Disconnect removes the app's session credentials; it does not delete your notes or revoke Microsoft's consent grant.

To enable the connection:

1. Register a Microsoft application that supports **personal Microsoft accounts**. Add a **Single-page application** redirect URI matching the exact site URL, including its path and trailing slash. For `npm run dev:web`, use `http://localhost:5173/`. Do not create or embed a client secret.
2. Copy `.env.example` to `.env.local`, set its public `VITE_ONEDRIVE_CLIENT_ID`, and leave `VITE_DEFAULT_STORAGE=onedrive` for the browser-only version. The browser requests delegated `Files.ReadWrite` so you can select existing folders; this permission reaches beyond the folder you select. Tokens and the PKCE state stay in `sessionStorage`, and the app requires reconnection when Microsoft expires/rejects the session.
3. Run `npm run dev:web`. For static hosting, run `npm run build` and serve `dist/` over HTTPS. Register that site's exact URL too, and rebuild when changing Vite configuration. `npm run preview:web` previews the build locally; register its actual URL if testing sign-in there. A deployment under a subpath needs Vite's matching `base`.

Without `VITE_DEFAULT_STORAGE=onedrive`, the existing local Node workflow remains the initial source and **Connect OneDrive** is available when a client ID is configured. Microsoft authorization codes, tokens, upload/download URLs, and your Markdown are never sent to the static host. Notes are read directly from Microsoft. Session credentials are accessible to scripts on the site's origin; serve the app from a trusted origin. Closing the session ends stored sign-in; this release has no offline write queue or persistent local deck.

OneDrive saves use conditional replacement of existing file IDs. An explicit stale-write rejection rereads the latest file and retries an Add/Edit operation a bounded number of times, preserving other remote content. Edit/Remove match the original parsed question-and-answer pair and affect **every identical occurrence in the selected file only**. Pair comparison normalizes line endings and trims surrounding whitespace; internal whitespace and Markdown differences remain significant. A changed/removed original retains your draft and reports a conflict. Other providers, Business accounts, collaborative offline editing, and persistent Markdown IDs are outside this implementation.

The simple `PUT /content` `If-Match` behavior passed disposable Personal-account tests but is omitted from Microsoft's endpoint header documentation. This prototype intentionally depends on that observed behavior; the conditional-write gate records this limitation and never falls back to unconditional replacement. See Microsoft's [simple upload reference](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0).

External changes appear on **Refresh**, which updates the practice snapshot; ordinary saves apply only their own effects to the current round. Source line labels describe the practice snapshot and may be stale after concurrent external changes. The browser sanitizes rendered Markdown and strips relative links/images rather than resolving them against the static host. Use explicit HTTP(S) asset URLs and HTTP(S)/mailto links for browser-hosted decks.

OneDrive uses a reserved `.flashcards-operation.json` in the selected folder to coordinate app saves and retain exact before/after content for recovery. A single active operation is allowed per connected folder. Removal confirms preservation of the exact removed entries in root-level `removed.md` before changing the source file. These separate writes are not an atomic transaction. If a save is interrupted, later saves stop and **Review pending save** shows the prepared source/archive. **Retry prepared save** repeats only the original conditional replacement (or no-clobber creation); it cannot re-append a duplicate by replanning an uncertain addition. If a revision changed, inspect OneDrive and the recovery details, then explicitly choose **Keep current files and clear pending save**. Clearing a pending operation neither undoes nor replays its changes. Never delete the recovery file while an operation is pending. `removed.md` and dot-prefixed recovery files are excluded from practice.

Application registration and real-account browser sign-in are separate from the automated mock-transport tests. No existing study material is needed to test this flow.

## Browser local folders

Run `npm run dev:web -- --port 3000 --strictPort`, open `http://localhost:3000`, and choose a local folder. The browser asks for read/write access; Markdown files in that folder and its subfolders become the deck. Supported Chromium browsers use the File System Access API for reading and writing. Firefox and Safari use the native folder input for read-only access; Add, Edit, and Remove are unavailable, and Refresh asks you to select the folder again to obtain updated files. Re-select the folder after reloading in any browser.

Edits affect every matching question/answer pair in the selected file. Removed entries are appended to `removed.md` before the source is changed. These are separate writes without a recovery journal or an atomic lock against other editors. If a save fails, inspect both files before retrying; concurrent edits can still race with a save.
