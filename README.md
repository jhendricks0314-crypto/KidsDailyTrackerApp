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
| `ANTHROPIC_API_KEY` | yes      | Your Anthropic key (`sk-ant-...`).                              |
| `ANTHROPIC_MODEL`   | no       | Defaults to `claude-sonnet-4-6`.                                 |

Login tokens are signed automatically using your `ANTHROPIC_API_KEY`, so there's
no separate signing secret to set up or paste anywhere.

---

## Option A — Deploy via the Netlify website (easiest, no terminal)

1. Put this folder in a GitHub repository (drag-and-drop upload works at
   github.com → New repository → "uploading an existing file").
2. Go to https://app.netlify.com → **Add new site → Import an existing project**.
3. Pick your repo. Netlify reads `netlify.toml`, so build settings
   (build command `npm run build`, publish directory `dist`, functions in
   `netlify/functions`) fill in automatically.
4. Go to **Site configuration → Environment variables** and add
   `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`).
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

## Build/deploy troubleshooting

**"Build failed on Netlify" / Node version errors (e.g. `node-sass` won't
install on Node 22):** StudyQuest itself has **no** Sass/`node-sass` dependency —
if you see that error, Netlify is almost certainly building a *different* repo
or older code, not this project. Make sure the repo Netlify deploys contains
**these** files (this `package.json` lists only React, Vite, and
`@netlify/blobs`). Replace the old repo contents with everything from this
package and push.

This project pins the build to **Node 20** (via `netlify.toml` →
`[build.environment] NODE_VERSION = "20"`, and `.nvmrc`) so deploys stay
predictable even if Netlify changes its default Node version.

## Answer grading: injection safety

Student answers are treated strictly as data, never as instructions:

- The AI grader is used as text-in/text-out only — there are **no tools, no code
  execution, and no agent actions** available to it, so an answer like "build me
  a program" has nothing to trigger; it's just graded as a wrong answer.
- The grading prompt explicitly tells the model to treat each answer as
  untrusted child input and to never follow instructions inside it.
- All inputs are coerced to strings, stripped of control characters, and
  length-capped before use.
- The grading result is **reconciled against the questions that were sent**: the
  response always has exactly one verdict per question (matched by item number),
  and any missing, extra, duplicated, or malformed entry **fails safe to
  "incorrect."** Only a strict `correct: true` counts as correct, and non-JSON
  model output is rejected. So a manipulated answer can't force a pass or change
  how many questions were graded.

## More updates

- **Admin login fixed:** log in with the username `admin` (the login field now
  accepts it instead of requiring an email). Reset a parent's password from the
  Parent area → 🛡️ Admin tab. If you forget the admin password, see "Admin
  account" above.
- **Per-kid categories are independent:** turning a topic off for one child no
  longer affects another child — each child's selections load and save on their
  own.
- **Set questions per subject, per kid:** in Parent → Question Categories, each
  subject has a "Questions/day" box (0–20). Set 0 to skip a subject entirely.
  Fewer questions also means fewer AI calls.
- **Chore reordering:** drag the ⠿ handle, or use the ▲ ▼ arrows, to reorder
  chores in Parent → Chores Setup.
- **Math charts now show y-axis values** (numbered gridlines), so bar/line-graph
  questions are answerable.
- **Reward ribbon:** it's centered, has a close (✕) button, shows how many plays
  remain, and the game can be played at most 3 times per day before the ribbon
  goes away.
- **Calendar shows questions and chores together** (📚 and 🧹 on each day) and no
  longer shows "undefined/undefined".
- **No SESSION_SECRET needed:** login tokens are signed automatically from your
  `ANTHROPIC_API_KEY`, so there's no separate secret to set (which also avoids
  Netlify's secret-scanning blocking the build). You may still set your own
  `SESSION_SECRET` if you prefer.

## Inviting another parent (share link)

In Parent → 👨‍👩‍👧 Family, use **📤 Share invite link** (or Copy link). Send it to
another parent. When they open it, they're taken to a screen where they can
**log in or create an account**, and they're added to your family automatically —
no code to type. (A copy-the-code option is still there as a fallback, and you
can regenerate the code to revoke an old invite.)

Note: an invite link lets whoever opens it join your family and see your kids, so
share it only with people you trust — same as the kids' link.

## Parent area: unlock once per session

Entering the Parent area asks for your account password once. After that you can
move in and out of the parent tabs freely without re-entering it. Use **🔒 Lock**
(in the Parent area header) to require the password again, or **← Exit parent
mode** to return to the kid view without locking. Signing out also re-locks it.

## Family names

- **Name your family at sign-up.** When you create a new account (not joining an
  existing family), there's an optional **Family name** field (e.g. "The Smith
  Family").
- **Shown in the header.** The family name appears under the StudyQuest title at
  the top of the app, for everyone in the family (including the kids' link).
- **Rename anytime.** Parent area → 👨‍👩‍👧 Family → **Family name** lets you set or
  change it; the header updates immediately.
- **Joining another family.** Opening an invite link (or entering a code) moves
  you into that family. If your old family has no other parents left, it (and its
  kids/data) is automatically deleted so nothing lingers. Before this happens, you'll see a confirmation warning that names your current family and how many children would be permanently deleted, so it never happens by surprise. If another parent is
  still in your old family, it's kept for them.

## Admin event logs (troubleshooting)

Signed in as **admin**, open Parent area → **📋 Logs** to view server-side
events for troubleshooting issues and workflows.

- **Levels:** error, warn, info, verbose, debug. Pick a minimum level (it
  includes everything more severe). Logged events include sign-ups, successful
  and failed logins, email-verification, family joins and deletions, completion
  emails, rate-limit hits, and AI generation/grading errors — plus a verbose
  "request" line per call.
- **Query by:** date range, **family** (id or name), **username/email**, free
  text, and level. Use the Today / Last 7 days shortcuts for quick scoping.
- **Details:** click "details" on an entry to see structured context (request
  id, HTTP status, etc.). Secrets (passwords, tokens) are automatically redacted
  and never logged.
- **Retention:** use **🗑️ Clear logs…** to delete everything, or only entries
  older than a date you choose.

**What gets persisted** is controlled by the `LOG_LEVEL` env var (default
`info`). Set it to `verbose` or `debug` temporarily while diagnosing something,
then set it back — verbose logs every request and uses more storage. Logs live
in Netlify Blobs alongside the app's other data; no extra setup is needed.

## Email links not working (e.g. in Yahoo)

Verification (and completion) emails include both a button **and** a full
clickable link, built with email-client-robust HTML so they work across Gmail,
Yahoo, Outlook, and Apple Mail.

The most important requirement is that **`APP_URL` is set** in Netlify (e.g.
`https://studyquestai.com`). If it isn't, the link can come out relative and
will appear to "work" from a browser tab but be dead when clicked from an email
client like Yahoo. The app now forces an absolute `https://` link and, if no
base URL is configured, records an **error** in the admin Logs ("set APP_URL").
If a verify link ever fails, check the Logs and confirm `APP_URL` is set, then
redeploy.

## Guided setup (first-run walkthrough)

When a logged-in parent has no kids yet, StudyQuest now shows a step-by-step
walkthrough instead of an empty screen:
1. **Welcome** — a summary of everything the app can do.
2. **Add your first child** — name, grade level (and family name if not set yet).
3. **Pick topics** — choose which categories each subject practices and how many
   questions per subject (0 skips a subject).
4. **Chores** — edit/add chores and choose which days they appear.
5. **Finish** — the child's first set of questions is generated from those
   settings automatically.

## Clearer "who's playing"

The kid switcher in the header now shows **profile avatars** (a friendly animal
+ color unique to each child). The selected child is enlarged, fully colored,
and marked with a ✓; the others are dimmed. A "Now playing: [name]" banner also
appears above the tabs, with a reminder to "tap your face up top" to switch —
designed so even a young child can tell which profile they're using.

## Admin: manage users per family

In Parent area → 🛡️ Admin (admin only), users are grouped by family. You can:
- **Add a parent** to any family by email — they're emailed a link to set their
  own password.
- **Delete** a parent. If they were the last one in their family, that family and
  its kids are removed too.
- **Send a reset link** to any parent.

For security, the admin can **never set or see passwords** — passwords are only
ever chosen by the user from a link emailed to them.

## Password reset by email

Parents who forget their password can tap **Forgot password?** on the login
screen to receive a reset link by email. The link opens a "Choose a new
password" screen and signs them in. (Requires email to be configured — see the
Resend setup above. Reset links expire in 2 hours.)

## Reward game button

Once a child closes the "you earned a game" ribbon, it no longer disappears
entirely — a single pulsing **"Play your reward game!"** button remains so they
can reopen the game without the ribbon nagging them. (Still limited to 3 plays
per day.)

## Setup walkthrough: add multiple kids

The first-run walkthrough now loops: after you finish setting up a child, it
asks "Would you like to add another child?" Choosing **Add another child** starts
the per-child steps again from the name (the family name is only asked once);
choosing **All done** generates everyone's questions and opens the app.

## Kids can personalize their profile

Kids can tap their avatar in the "Now playing" banner (or the "Change my icon"
link) to open a picker and choose their **icon** and **background color**. The
icon set is a wide range of fun emoji (animals, dinosaurs, robots, ninjas,
superheroes, vehicles, sports, and more). Note: we intentionally don't include
copyrighted characters (e.g. Mario, Sonic, Bluey, Disney) — bundling that
artwork would infringe those companies' rights. The chosen icon and color follow
the child everywhere their profile appears (header, banner, calendar, etc.).

## Notification settings

Parent area → 🔔 Notifications lets each family:
- Turn the **"questions finished"** and **"chores finished"** emails on or off
  independently.
- Add up to **5 extra email addresses** that also receive the enabled emails
  (e.g. a second parent, a grandparent). These extra addresses are assumed valid
  and don't require verification — double-check spelling. All logged-in parents
  in the family always receive the emails too.

## Fraction question fix

Fraction questions no longer reveal the answer in the formatting hint. The hint
now shows a neutral example (e.g. "write your answer as a fraction, for example
2/7") that can never match the actual answer.

## Faster calendar

The progress calendar previously fetched each day's questions and chores in
separate, sequential requests (dozens of round-trips per month), which made it
slow to update. It now loads the whole month in a **single batched request**
(via a new `mget` data operation) and **caches** months it has already loaded,
so opening the calendar and flipping between months is much faster. Past months
are never re-fetched (they don't change); the current month refreshes in the
background while showing cached data instantly.

## Fixes

- **Wizard "Child not found" on save:** the setup walkthrough now creates the
  child and their categories/counts in a single atomic write (instead of
  create-then-update), and uses the authoritative new-child id returned by the
  server. This removes the race that could produce a "Child not found" error
  when saving a new kid's settings.
- **Orphaned families auto-cleanup:** any family left with no parents (and all of
  its kids/data) is now deleted automatically — this runs whenever the admin
  opens the Users-by-Family screen, and after any parent is removed. There's also
  a 🧹 "Clean up orphaned families" button in the Admin tab to do it on demand.

## More fixes & features

- **Add-a-kid uses the setup walkthrough:** adding a child from the parent
  (Kids) page now launches the same guided flow — name & grade, then topics &
  per-subject question counts, then chores — starting at the child's name (the
  Welcome screen is skipped). Questions are generated from the chosen counts
  instead of defaulting to 10.
- **Fixed Science/History resetting to 0:** a subject whose count wasn't
  explicitly set is now correctly treated as the default rather than 0.
- **Changing categories updates questions:** when a parent saves category/count
  changes, today's set is topped up if a subject's count increased (existing
  questions and answers are kept; only the unanswered tail is trimmed if a count
  decreased), and untouched upcoming days are regenerated with the new settings.
- **Extra subjects:** beyond the core five, parents can now add up to 5 optional
  subjects — Art, Music, Coding, Health, and Spanish — each with their own
  topics. They're off by default and added from the Categories screen (or during
  setup).
- **Questions are pre-generated ~10 days ahead** in a single batch instead of an
  API call every day, which makes daily loads faster and cheaper. The existing
  rule is preserved: new days are only generated when the most recent set was at
  least half answered, so it won't pile on work if a child falls behind.

## Kids Mode (open straight to the family, no login)

A child should be able to just open the installed app and see their family — no
password. To set this up on a child's device:

1. Install StudyQuest on the device (Add to Home Screen) and log in as a parent
   once.
2. Go to the parent area → 👨‍👩‍👧 Family → **"Switch this device to Kids Mode."**

From then on, every time the app is opened on that device it goes straight to
the family's kid view with no login. Under the hood this stores a long-lived
(1-year), family-scoped token on the device; the parent account is logged out on
that device so it stays a kid device. A parent can tap the 🔒 lock button and log
in again anytime to regain parent access (e.g. to change settings), and can
switch back to Kids Mode afterward.

Notes:
- The kid-mode token only allows kid actions (viewing/answering questions,
  chores, choosing an avatar). It can't reach parent-only screens or other
  families.
- This is per device — set it up on each child's tablet. (The older "copy the
  kids' link" method still works too.)
- "↻ new code" still revokes all kid-mode devices if you ever need to.

## Subjects (formerly "Categories")

The "Categories" chooser is now called **Subjects**. The two levels are now
named clearly:
- **Subjects** — the things you pick for each child (Math, Reading & Writing,
  Science, History, Geography, Art, Music, Coding, Health, Spanish).
- **Topics** — the sub-areas inside each subject (e.g. Addition, Fractions).

You can now freely choose **any 1 to 10 subjects** for each child — nothing is
mandatory. Turn subjects on or off in the Subjects tab (at least one must stay
on), pick the topics within each, and set how many questions per subject per day
(1–20). Existing children keep their current subjects; brand-new children start
with the five original subjects on by default, which you can change.
