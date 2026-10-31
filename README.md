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

The browser connects directly to OneDrive Personal using Microsoft's permission-isolated app folder, normally **Apps/<application name>**. It uses that folder by default; click the current folder name to open Microsoft’s folder picker and select a subfolder. The picker integration with app-folder-only permissions is experimental and requires live verification. Markdown subfolders of the selected folder are included. Connect once to create the app folder, then move or copy existing cards into it using OneDrive and refresh the deck. Folder selections are remembered in this browser. Disconnect removes session credentials; it does not delete notes or revoke Microsoft's consent grant. If you previously granted broader OneDrive access, revoke that grant in your Microsoft account's app permissions separately. Resolve pending changes for old folders before migrating: the restricted app cannot resume changes targeting a folder outside its app folder, and copying a folder creates a different destination.

To enable the connection:

1. Register a Microsoft application that supports **personal Microsoft accounts**. Add a **Single-page application** redirect URI matching the exact site URL, including its path and trailing slash. For `npm run dev`, use `http://localhost:3000/`. Do not create or embed a client secret.
2. Copy `.env.example` to `.env.local`, set its public `VITE_ONEDRIVE_CLIENT_ID`. The browser requests delegated `Files.ReadWrite.AppFolder` and its OneDrive equivalent `OneDrive.AppFolder`, which grant access to the entire app folder and its contents. The app folder name comes from the Microsoft application registration. Tokens and the PKCE state stay in `sessionStorage`, and the app requires reconnection when Microsoft expires/rejects the session.
3. Run `npm run dev`. For static hosting, run `npm run build` and serve `dist/` over HTTPS. Register that site's exact URL too, and rebuild when changing Vite configuration. `npm run preview:web` previews the build locally; register its actual URL if testing sign-in there. A deployment under a subpath needs Vite's matching `base`.

Microsoft authorization codes, tokens, upload/download URLs, and your Markdown are never sent to the static host. Notes are read directly from Microsoft. Session credentials are accessible to scripts on the site's origin; serve the app from a trusted origin. Closing the session ends stored sign-in; pending writes are retained in the browser, but the deck itself is not persisted offline.

OneDrive saves use conditional replacement of existing file IDs. An explicit stale-write rejection rereads the latest file and retries the operation a bounded number of times. Edit and Remove match the original parsed question-and-answer pair and affect **every identical occurrence in the selected file only**; if none remain, the operation does nothing. Pair comparison normalizes line endings and trims surrounding whitespace; internal whitespace and Markdown differences remain significant. Other providers, Business accounts, collaborative offline editing, and persistent Markdown IDs are outside this implementation.

The first OneDrive save uses source and archive snapshots cached when the folder loads; rejected writes refresh the affected file. A cached no-op is checked against the current file. The cache uses IndexedDB on this origin and is cleared when switching folders or disposing the connection; an interrupted browser session can leave cached content behind until browser site data is cleared. Other scripts on the same origin can access it, and file contents are also held briefly in memory while processing.

The simple `PUT /content` `If-Match` behavior passed disposable Personal-account tests but is omitted from Microsoft's endpoint header documentation. This prototype intentionally depends on that observed behavior; the conditional-write gate records this limitation and never falls back to unconditional replacement. See Microsoft's [simple upload reference](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0).

External changes appear on **Refresh**, which updates the practice snapshot; ordinary saves apply only their own effects to the current round. Source line labels describe the practice snapshot and may be stale after concurrent external changes. The browser sanitizes rendered Markdown and strips relative links/images rather than resolving them against the static host. Use explicit HTTP(S) asset URLs and HTTP(S)/mailto links for browser-hosted decks.

Pending Add, Edit, and Remove requests are stored in this browser and run in order for their original destination. Practice remains available while they wait. Temporary failures retry after approximately 2, 4, and 8 seconds, then every two minutes while the app is open; OneDrive's `Retry-After` is honored. History shows the error and retry countdown, or **Needs Review** when the outcome cannot be established safely. Reconnect the same account and folder to resume after a reload; clearing browser site data removes the local queue. Completed History is session-only. The queue requires IndexedDB and Web Locks in a secure context (HTTPS or localhost); Web Locks prevent tabs on the same origin from running the same queued operation concurrently.

OneDrive recovery information is stored in the originating browser, not in OneDrive. Other devices and browser profiles cannot see its pending operations; clearing site data also removes them. Removal archives before changing the source, and those writes are not atomic. If a save's outcome is uncertain, review its details in History and inspect the source and `removed.md` in OneDrive before deciding how to resolve it. An outstanding request on another device may still finish later. `removed.md` and dot-prefixed files are excluded from practice.

Application registration and real-account browser sign-in are separate from the automated mock-transport tests. No existing study material is needed to test this flow.

## Browser local folders

Run `npm run dev`, open `http://localhost:3000`, and choose a local folder. The browser asks for read/write access; Markdown files in that folder and its subfolders become the deck. Supported Chromium browsers use the File System Access API for reading and writing. Firefox and Safari use the native folder input for read-only access; Add, Edit, and Remove are unavailable, and Refresh asks you to select the folder again to obtain updated files. Re-select the folder after reloading in any browser.

Edits and removals affect every currently matching question/answer pair in the selected file; if none remain, they do nothing. Removed entries are archived in `removed.md` before the source is changed, skipping pairs already in the archive. Local saves re-read and retry detected changes, but the files have no atomic lock against other editors and concurrent edits can still race with a save. The browser stores pending stages for recovery.

## Public hosting and limits

Serve the built static files over HTTPS on a dedicated origin that hosts no untrusted apps or scripts. Scripts on that origin can access saved local folder handles and session credentials. [deploy/nginx.conf.example](deploy/nginx.conf.example) provides a static-only Nginx starting configuration with security headers, request and connection limits, and explicit 404 responses for the retired `/api` routes. It requires a public hostname, certificate, and a directory containing only the built public files. The config belongs inside Nginx's `http` context; adjust the paths and hostname, run `nginx -t`, and test the actual deployment before use. Remove any old reverse proxy or running materials service separately. Static hosting does not authenticate visitors. The limits are per apparent client IP and do not protect against distributed attacks; configure trusted proxy IP handling if applicable.

The example CSP blocks external Markdown images by default to avoid contacting their hosts. To permit specific trusted image hosts, add their HTTPS origins to `img-src`; those hosts can then observe visitors' IP addresses and requests. OneDrive download URLs can use dynamic HTTPS hosts, so `connect-src` permits HTTPS broadly; scripts remain restricted to the app origin. The example policy and its Microsoft sign-in origins have not been validated against a live deployment: test login, folder selection, reads and writes with disposable files and adjust it as needed. The policy is not a substitute for trusting the app origin.

Folder loads limit entries to 2,000, depth to 32, each Markdown file to 5 MiB and total Markdown content to 50 MiB. OneDrive listings and downloads are bounded while reading; choose a smaller folder if a limit is reached. The browser's native folder picker may allocate its file list before the app can apply its limits. These limits do not protect the host from distributed traffic.
