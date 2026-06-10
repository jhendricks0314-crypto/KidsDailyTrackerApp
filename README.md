# StudyQuest

A daily questions + chores tracker for kids. Runs as a website (great on
Android / Fire tablets — open in Chrome and "Add to Home Screen").

Parents create an **account** (username + password). Each account can have
many kids, and **a parent only ever sees their own kids' profiles and
progress**. All data is stored on the server (Netlify Blobs), so it follows
the account across devices — not tied to one tablet.

Written answers are graded by Claude through a secure serverless function, so
your API key is never exposed to the browser.

## What's in here

```
studyquest/
├─ index.html                  # app entry
├─ src/
│  ├─ main.jsx                  # mounts the app
│  └─ StudyQuest.jsx            # the whole front-end app
├─ netlify/
│  └─ functions/
│     └─ api.js                 # backend: accounts, kids, data, AI grading
├─ netlify.toml                 # build + routing config
├─ package.json
├─ vite.config.js
├─ .env.example                 # copy to .env for local dev
└─ .gitignore
```

## How it works

- **Accounts & sessions.** Passwords are hashed with scrypt (+ a per-user
  salt) and never stored in plain text. Logging in returns a signed session
  token kept on the device; it expires after 30 days.
- **Data isolation.** Every request that touches a kid's data is checked on
  the server against the logged-in parent. One parent cannot read or change
  another parent's kids — even if they somehow knew the internal IDs.
- **Storage.** Netlify Blobs — a key/value store built into Netlify. No
  separate database to sign up for or configure.
- **Grading.** The browser sends answers to `/api/grade` (your own function),
  which adds your `ANTHROPIC_API_KEY` and calls Anthropic. Math is always
  graded locally (exact match, no network). If the server is unreachable, the
  app falls back to offline keyword grading so it never fully breaks.

## Required environment variables

Set these in **Netlify → Site configuration → Environment variables**:

| Variable            | Required | Notes                                                            |
|---------------------|----------|------------------------------------------------------------------|
| `ANTHROPIC_API_KEY` | yes      | Your Anthropic key (`sk-ant-...`).                               |
| `SESSION_SECRET`    | yes      | Long random string used to sign login tokens (see below).       |
| `ANTHROPIC_MODEL`   | no       | Defaults to `claude-sonnet-4-6`.                                 |

Generate a good `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> Note: changing `SESSION_SECRET` later logs everyone out (they just log back in).

---

## Option A — Deploy via the Netlify website (easiest, no terminal)

1. Put this folder in a GitHub repository (drag-and-drop upload works at
   github.com → New repository → "uploading an existing file").
2. Go to https://app.netlify.com → **Add new site → Import an existing project**.
3. Pick your repo. Netlify reads `netlify.toml`, so build settings
   (build command `npm run build`, publish directory `dist`, functions in
   `netlify/functions`) fill in automatically.
4. Go to **Site configuration → Environment variables** and add
   `ANTHROPIC_API_KEY` and `SESSION_SECRET` (and optionally `ANTHROPIC_MODEL`).
5. Trigger a deploy (**Deploys → Trigger deploy → Deploy site**).
6. Open the site URL on your tablet, create your parent account, then use
   Chrome's menu → **Add to Home Screen**.

Netlify Blobs turns on automatically for the site — nothing to configure.

## Option B — Deploy with the Netlify CLI (terminal)

```bash
npm install -g netlify-cli

# from inside this folder
npm install
netlify login
netlify init            # link/create a site

netlify env:set ANTHROPIC_API_KEY "sk-ant-your-key-here"
netlify env:set SESSION_SECRET "$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
# optional:
netlify env:set ANTHROPIC_MODEL "claude-sonnet-4-6"

netlify deploy --build --prod
```

## Run it locally first (optional)

```bash
npm install
cp .env.example .env         # then edit .env with your real values
netlify dev                  # serves the app AND the functions at http://localhost:8888
```

Use `netlify dev` (not plain `npm run dev`) so the serverless function and
Netlify Blobs run locally with your `.env` values.

> This app needs the backend to run. Opening `StudyQuest.jsx` as a plain
> static page (or pasting it into an artifact) won't work anymore, because it
> talks to `/api/*` for accounts and data.

---

## Using the app

1. **Create a parent account** (username + password) on first visit, or log in.
2. Open the **Parent area** (re-enter your password) to:
   - add kids and set each kid's grade level (1–12),
   - edit each kid's chores,
   - view the answer key for any kid.
3. Each kid gets 10 questions per subject per day, a chores checklist, and two
   progress calendars (questions and chores).
4. **Log out** from the header to switch accounts on a shared device.

## Changing the grading model

Set `ANTHROPIC_MODEL`. No code change needed. See
https://docs.claude.com/en/docs/about-claude/models/overview for current names.

## App updates (installed / home-screen app)

StudyQuest is a PWA: when you "Add to Home Screen," a service worker caches it
so it loads fast and works offline. To avoid people getting stuck on an old
cached version, the app checks for updates automatically:

- Every published deploy gets a unique build id (stamped into `version.json`
  and into the app bundle at build time — handled automatically by
  `npm run build`).
- While open, the app polls `/version.json` (about once a minute, and whenever
  you return to it). If the server's build id differs from the running one, a
  **"A new version is ready!"** banner slides down with an **Update** button.
- Tapping **Update** activates the new version and reloads — no app store, no
  reinstall. If the device was offline, the check simply retries later.

So to ship an update: change the code and redeploy to Netlify. Everyone with
the app open (or who opens it) sees the Update button shortly after, and
installed home-screen copies update themselves on the next launch.

> Updates only apply to the deployed site. Running `StudyQuest.jsx` as a bare
> static file has no backend and no service worker, so none of this applies.

## Question categories (per kid)

Each subject has topic **categories** you can turn on and off per child, in the
parent area under **🎯 Categories**:

- **Math** offers operation types (Addition, Subtraction, Multiplication,
  Division, Fractions, Word Problems, etc.). Math is generated locally so
  answers are always exactly correct — for that reason Math uses these
  built-in types only.
- **Reading, Science, History, Geography** let you pick built-in topics *and*
  **add your own** (e.g. "Dinosaurs", "Ancient Rome"). Custom topics are
  written fresh by the AI teacher, so they need an internet connection.
- Check the topics you want, then **Save categories**. Changes apply to the
  **next day's** question set (each day is generated once and then locked).
- If no categories are selected for a subject, all topics are used.

Selections are stored on each child's profile on the server, so they follow
the account and can be updated anytime.

## "Help me" — teacher support after repeated misses

If a child answers a question wrong **3 times**, a **🧑‍🏫 Help me with this**
button appears under that question. Tapping it asks the AI to act as a patient
teacher: it gives a short, grade-appropriate explanation of how to think about
the problem and walks the child to the correct answer. This needs an internet
connection; if it can't reach the teacher, it shows a gentle encouragement
message instead.

## Admin account & password resets

There is one special **admin** account that can reset any parent's password
(useful if a family gets locked out).

- **First-run setup:** the first time the app is opened with no admin yet, it
  shows a one-time screen to set the **admin** password. After that, the admin
  logs in like anyone else — username `admin` + the password you chose.
- **The `admin` username is reserved** — no one can sign up as `admin`.
- **Resetting a password:** log in as `admin`, open the **Parent area**
  (password gate), and go to the **🛡️ Admin** section. You'll see all accounts;
  click **Reset password** on any user and set a new one. Tell that user the new
  password — they can change it themselves after logging in. (Passwords are
  hashed, so even the admin can never *see* an existing password, only set a
  new one.)
- Admin powers are enforced on the server, not just hidden in the UI.

**Security tip:** open your deployed app and set the admin password *immediately*
after deploying, so no one else can claim the admin account first. For extra
safety, set the optional `ADMIN_SETUP_KEY` environment variable — then first-run
setup also requires that key.

## Families: multiple parents, shared kids

Kids belong to a **family**, and more than one parent account can share that
family — everyone sees the same kids and progress.

- When you sign up, a new family is created with a **family invite code**
  (shown in the parent area under **👨‍👩‍👧 Family**).
- To add a co-parent: share that code. They sign up, tick **"Join an existing
  family"**, and enter the code. They get their own username/password but see
  the same kids.
- You can **regenerate** the code at any time (the old one stops working), and
  see everyone currently in the family.
- Treat the code like a password — only share it with people who should see
  your kids.

Existing single-parent accounts are migrated to a family automatically on next
login, with their kids preserved.

## Changing your username or password

In the parent area under **⚙️ Account**, a parent can change their **username**
(if the new one is free) and/or their **password**. (The reserved `admin`
username can't be changed.)

## Chores by day of the week

In **🧹 Chores Setup**, each chore has weekday toggles (S M T W T F S) plus
quick presets (Every day / Weekdays / Weekend). Kids only see a chore on the
days it's scheduled, and the chore calendar reflects that.

## Custom categories for every subject (including Math)

You can now add your own topics to **any** subject, including Math. Built-in
Math types (Addition, Fractions, …) are still generated locally so their
answers are always exact; custom Math topics are written by the AI teacher like
other subjects (and so need an internet connection).

## Reward game

When a child gets **every question correct** *and* finishes **all of today's
chores**, a fun mini-game pops up as a reward (and a "Play 🎮" button stays
available). The game is chosen by grade: a calm **Memory Match** for younger
kids (grades 1–4) and a 20-second **Star Catcher** tap game for older kids
(grades 5–12). The games are self-contained, so they work offline too.

## Update: kids' no-login link, email accounts, visual math, daily emails

### 1. Kids' access link (no login)
Parents now get a **kids' access link** (Parent area → 👨‍👩‍👧 Family). Open it on
the child's tablet and add it to the home screen — it launches StudyQuest
straight into your family, no password needed, so kids never need your login.
From kid mode, tapping **🔒 Parent** asks for the parent email + password to
reach the management area. Making a new family code revokes the old link.

### 2. Reliable add/remove of kids
The Kids manager now updates its list directly from each server response, so a
child appears/disappears immediately after Add/Remove and errors are shown
rather than hidden.

### 3. Visual math topics
Math now includes **Geometry, Bar Graphs, Line Graphs, Coordinate Plane, and
Number Patterns**. These draw a small picture (shape, chart, or grid) with the
question — on screen and on the printed sheets — and still have exact,
auto-graded answers.

### 4. Email sign-up + verification
Accounts now use your **email address**. New sign-ups receive a verification
link; clicking it activates the account and drops you straight into your
family. Until verified, login is blocked (with a resend option). Changing your
email re-triggers verification. **Requires the email env vars below.**

### 5. Completion emails to parents
Instead of a scheduled progress report, StudyQuest now emails parents **when a
child finishes**, driven by what actually happens in the app:

- **Questions done:** once a child has answered and checked **every** question
  for the day, each verified parent gets an email listing all the questions with
  the child's answers, the correct answer for any they missed, and the score.
- **Chores done:** once a child completes **all of today's** chores, each parent
  gets an email — sent **separately** (one email per parent, not a shared To
  line).

Both are sent from the server, which re-checks that the child is genuinely done
before sending and sends **only once per child per day** for each type (so a
page reload or re-check won't send duplicates). A per-family cap also prevents
the endpoint from being used to spam inboxes. **Requires the email env vars
below.** (The old 8 PM scheduled report has been removed.)

### Email setup (needed for #4 and #5)
1. Create an account at https://resend.com and **verify your sending domain**.
2. Create an API key.
3. In Netlify → Site configuration → Environment variables, set:
   - `RESEND_API_KEY` — your Resend key
   - `FROM_EMAIL` — a from address on your verified domain (e.g. `StudyQuest <no-reply@yourdomain.com>`)
   - `APP_URL` — your site's public URL (e.g. `https://your-site.netlify.app`)
4. Redeploy. Without these, the app runs fine but verification/completion emails
   won't send (signup will tell you email isn't configured).

> Note: the kids' link and family code are shared secrets in a URL — fine for a
> home device. Regenerate the code to revoke access.

## Installing to the home screen (PWA)

StudyQuest is installable as an app. Requirements for the Android/Chrome install
prompt are now met: the manifest ships real PNG icons (192×192 and 512×512, plus
a maskable 512×512), a linked web manifest, and a service worker — all over
HTTPS (Netlify provides this automatically).

- **Android (Chrome):** open the site; either tap the in-app **📲 Install app**
  button (top of the screen) or use Chrome's menu → **Add to Home screen /
  Install app**. The button appears once Chrome confirms the site is
  installable.
- **iOS (Safari):** there is no automatic prompt on iOS. Tap **Share** →
  **Add to Home Screen**. The in-app button shows these steps.
- **Desktop (Chrome/Edge):** an install icon appears in the address bar, or use
  the in-app button.

**Note:** the install prompt only appears on the deployed HTTPS site (not over
plain HTTP or a raw file). If you'd previously visited the site, fully close the
tab and reopen — or clear the site data — so the browser re-reads the updated
manifest and icons. You can confirm installability in Chrome DevTools →
**Application → Manifest** (and the **Icons** section there shows the maskable
safe-zone preview).

## API usage controls (answer checking)

Two safeguards keep Anthropic API usage (and costs) down:

1. **All answers required before checking.** The "✓ Check my answers" button
   for a subject stays disabled until every question in that subject has an
   answer (it shows an "X/10 answered" hint). This means one grading call per
   complete attempt instead of many calls on half-finished subjects. (Math is
   graded locally in the browser and never calls the API at all.)

2. **Per-family rate limits.** The three AI endpoints — answer grading,
   question generation, and teacher help — are each capped per family (shared
   across all parents and the kids' link), over a rolling per-minute and
   per-day window. Going over returns a friendly "you're checking too fast"
   message and a short wait, rather than an error. Defaults (tunable via the
   `RL_*` environment variables in `.env.example`):

   | Endpoint            | Per minute | Per day |
   |---------------------|-----------:|--------:|
   | Grade answers       |         20 |     400 |
   | Generate questions  |         10 |     150 |
   | Teacher help        |         15 |     250 |

   These are generous for normal daily use by a household but stop a stuck or
   mischievous child (or a leaked link) from looping calls. Limits are enforced
   on the server, so they can't be bypassed from the browser.

## Celebration pop-ups

When a child aces a subject (every question correct) or finishes all of today's
chores, a fun full-screen congratulations pops up. There are **10 different
celebrations** ("Perfect Score!", "Woohoo!", "Blast Off!", "Superstar!",
"Magical!", "Bullseye!", "Way to Go!", "Amazing Job!", "Big Brain!", "On
Fire!"), each with its own emoji, colors, emoji animation, and particle effect
(raining emojis, bursting sparks, or rising confetti). A random one is shown
each time (never the same one twice in a row), so it stays fresh. These are
pure CSS/emoji, so they work offline and inside the installed app.

## Question generation is once-per-day (and never wasted)

Each child's question set is generated **once per calendar day** and then reused
all day — answering, checking, and reloading never create a new set. A stored
set that already has questions is always kept and **never regenerated**, even if
it's barely started (well under 50% answered). Combined with "all answers
required before checking" and the per-family rate limits, this keeps Anthropic
API calls to roughly one generation per child per day.
