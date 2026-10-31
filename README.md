# Flashcards

A flashcard app for you to rehearse your study notes interactively. You can use it with any question-and-answer material.

Flashcards reads your notes organized as question-and-answer pairs in Markdown and runs a local web app for you to practice. It shuffles the pairs so you can test your recall. There’s no manual import, account to create, or database to maintain.

This prototype has no spaced repetition or saved study progress.

> This project is still experimental. It is fully authored by AI.

![Add](docs/images/add.png)
![File Picker](docs/images/file_picker.png)
![History](docs/images/history.png)

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

`# question` and `# answer` are the headings Flashcards uses to identify your pairs. They are case insensitive, and each needs some content under it. You can use lists, quotes, code blocks, and deeper headings (`##` and below) in your questions and answers. The `---` line is optional.

You can keep multiple Markdown files in the selected folder, including subfolders. Only `.md` files are loaded. If a file has a formatting error, you'll need to fix it and refresh. 

4. **Set up OneDrive (optional).**

To use OneDrive, register a Microsoft application that supports personal accounts. See [Microsoft's registration guide](https://learn.microsoft.com/en-us/graph/auth-register-app-v2). Add `http://localhost:3000/` as a Single-page application redirect URI.

Copy `.env.example` to `.env.local` and set `VITE_ONEDRIVE_CLIENT_ID` to your application's ID.

The app will request read and write access to your OneDrive. It uses the application's folder by default.

5. **Start the app.**

```sh
npm run dev
```

Open [localhost:3000](http://localhost:3000) and choose a local folder or OneDrive. 

> For local folders, Chromium browsers support reading and editing cards. Firefox and Safari support reading only.

Use **Add**, **Remove**, and **Edit** to change cards. Remove archives entries in `removed.md`, which is excluded from practice. External changes appear after Refresh.

Press **Space** to reveal or advance, **←** to revisit, and **→** to advance.

> For appearance tweaks, see the variables at the top of [src/style.css](src/style.css). The file selector and shared Add/Edit panel default widths are viewport ratios; a saved file-selector width takes precedence, and panel minimums still apply.

6. **Host it on your server (optional).**

With Caddy installed and running, deploy from the project folder as a user with sudo access:

```sh
sudo ./deploy/setup.sh --domain flashcards.example.com
```

The script builds the app with Node.js 22.12+ and npm. For more options, run:

```sh
./deploy/setup.sh --help
```

> The deployed app is served from `/srv/flashcards/dist`. Its Caddy site configuration is stored at `/etc/caddy/conf.d/flashcards.caddy`.
