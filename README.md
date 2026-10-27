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

> For appearance tweaks, see the variables at the top of [src/style.css](src/style.css).
