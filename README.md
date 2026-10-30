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

Create a Markdown file in a local or OneDrive folder with these sample cards:

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

You can keep multiple Markdown files in the selected folder, including subfolders. Only `.md` files are loaded. If a file has a formatting error, fix it and refresh. The `---` line is optional.

4. **Start the app.**

```sh
npm run dev
```

Open [localhost:3000](http://localhost:3000) and choose a local folder or OneDrive. See the sections below for browser support and OneDrive setup.

Use **Add**, **Remove**, and **Edit** to change cards. Remove archives entries in `removed.md`, which is excluded from practice. External changes appear after Refresh.

Press **Space** to reveal or advance, **←** to revisit, and **→** to advance.

> For appearance tweaks, see the variables at the top of [src/style.css](src/style.css). The file selector and shared Add/Edit panel default widths are viewport ratios; a saved file-selector width takes precedence, and panel minimums still apply.

## OneDrive Personal and static hosting

The browser can connect directly to OneDrive Personal, without a card server. It creates or reuses **My Flashcards** in your OneDrive root by default. Click the current folder name to choose an existing folder using Microsoft’s OneDrive picker; its Markdown subfolders are included. The picker opens in a side pane and may ask for a separate Microsoft sign-in the first time. Use the same account as the app, then click the folder name again after returning. This ordinary folder is app-managed by convention, not Microsoft's permission-isolated App Folder. The selected folder is remembered for the browser session. Disconnect removes the app's session credentials; it does not delete your notes or revoke Microsoft's consent grant.

To enable the connection:

1. Register a Microsoft application that supports **personal Microsoft accounts**. Add a **Single-page application** redirect URI matching the exact site URL, including its path and trailing slash. For `npm run dev`, use `http://localhost:3000/`. Do not create or embed a client secret.
2. Copy `.env.example` to `.env.local`, set its public `VITE_ONEDRIVE_CLIENT_ID`. The browser requests delegated `Files.ReadWrite` so you can select existing folders; this permission reaches beyond the folder you select. Tokens and the PKCE state stay in `sessionStorage`, and the app requires reconnection when Microsoft expires/rejects the session.
3. Run `npm run dev`. For static hosting, run `npm run build` and serve `dist/` over HTTPS. Register that site's exact URL too, and rebuild when changing Vite configuration. `npm run preview:web` previews the build locally; register its actual URL if testing sign-in there. A deployment under a subpath needs Vite's matching `base`.

Microsoft authorization codes, tokens, upload/download URLs, and your Markdown are never sent to the static host. Notes are read directly from Microsoft. Session credentials are accessible to scripts on the site's origin; serve the app from a trusted origin. Closing the session ends stored sign-in; this release has no offline write queue or persistent local deck.

OneDrive saves use conditional replacement of existing file IDs. An explicit stale-write rejection rereads the latest file and retries an Add/Edit operation a bounded number of times, preserving other remote content. Edit/Remove match the original parsed question-and-answer pair and affect **every identical occurrence in the selected file only**. Pair comparison normalizes line endings and trims surrounding whitespace; internal whitespace and Markdown differences remain significant. A changed/removed original retains your draft and reports a conflict. Other providers, Business accounts, collaborative offline editing, and persistent Markdown IDs are outside this implementation.

The simple `PUT /content` `If-Match` behavior passed disposable Personal-account tests but is omitted from Microsoft's endpoint header documentation. This prototype intentionally depends on that observed behavior; the conditional-write gate records this limitation and never falls back to unconditional replacement. See Microsoft's [simple upload reference](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0).

External changes appear on **Refresh**, which updates the practice snapshot; ordinary saves apply only their own effects to the current round. Source line labels describe the practice snapshot and may be stale after concurrent external changes. The browser sanitizes rendered Markdown and strips relative links/images rather than resolving them against the static host. Use explicit HTTP(S) asset URLs and HTTP(S)/mailto links for browser-hosted decks.

Pending Add, Edit, and Remove requests are stored in this browser and run in order for their original destination. Practice remains available while they wait. Temporary failures retry after approximately 2, 4, and 8 seconds, then every two minutes while the app is open; OneDrive's `Retry-After` is honored. History shows the error and retry countdown, or **Needs Review** when the outcome cannot be established safely. Reconnect the same account and folder to resume after a reload; clearing browser site data removes the local queue. Completed History is session-only. The queue requires IndexedDB and Web Locks in a secure context (HTTPS or localhost); Web Locks prevent tabs on the same origin from running the same queued operation concurrently.

OneDrive uses a reserved `.flashcards-operation.json` in the selected folder to coordinate app saves and retain exact before/after content for recovery. A single active operation is allowed per connected folder. Removal archives before changing the source; these writes are not an atomic transaction. Recovery inspects each stage independently and retries only the prepared conditional replacement or no-clobber creation. An uncertain Add whose result may already be present needs review, because identical cards do not prove authorship. History shows prepared content for review; **Keep current files and dismiss** releases the operation without undoing or replaying it. Other clients' journal operations remain available through **Review pending save**. Never delete the recovery file while an operation is pending. `removed.md` and dot-prefixed recovery files are excluded from practice.

Application registration and real-account browser sign-in are separate from the automated mock-transport tests. No existing study material is needed to test this flow.

## Browser local folders

Run `npm run dev`, open `http://localhost:3000`, and choose a local folder. The browser asks for read/write access; Markdown files in that folder and its subfolders become the deck. Supported Chromium browsers use the File System Access API for reading and writing. Firefox and Safari use the native folder input for read-only access; Add, Edit, and Remove are unavailable, and Refresh asks you to select the folder again to obtain updated files. Re-select the folder after reloading in any browser.

Edits affect every matching question/answer pair in the selected file. Removed entries are appended to `removed.md` before the source is changed. The browser stores each pending stage, but the files have no atomic lock against other editors and concurrent edits can still race with a save. If a local write was interrupted by a reload and may still be finishing, History asks for review instead of starting another write. Inspect both files before dismissing an uncertain removal.

## Public hosting and limits

Serve the built static files over HTTPS on a dedicated origin that hosts no untrusted apps or scripts. Scripts on that origin can access saved local folder handles and session credentials. Configure your web server to set a Content Security Policy appropriate for Microsoft sign-in and the OneDrive picker, `X-Content-Type-Options: nosniff`, a restrictive frame policy, and rate limits. Test the policy against sign-in and folder selection before use. External images in Markdown contact their hosts.

Folder loads limit entries to 2,000, depth to 32, each Markdown file to 5 MiB and total Markdown content to 50 MiB. Choose a smaller folder if a limit is reached. OneDrive size is checked after download; these limits do not fully bound network traffic or server-side bandwidth.
