// netlify/functions/api.js
//
// StudyQuest backend — a single router mounted at /api/:action.
//
// Responsibilities:
//   • Parent accounts (username + password), passwords hashed with scrypt
//   • Session tokens (HMAC-signed, stateless)
//   • Kid profiles owned by a parent (1-to-many)
//   • Per-kid data (daily questions, chores, chore logs)
//   • AI grading proxy (holds ANTHROPIC_API_KEY; never sent to the browser)
//
// Data isolation: every kid/data request is authorized against the logged-in
// parent. A parent can only ever read or write their own kids' data.
//
// Storage: Netlify Blobs (built in — no external database to set up).
//
// Required environment variables (set in Netlify -> Site config -> Env vars):
//   ANTHROPIC_API_KEY   your Anthropic key (sk-ant-...)
//   SESSION_SECRET      any long random string used to sign login tokens
// Optional:
//   ANTHROPIC_MODEL     defaults to "claude-sonnet-4-6"

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

const db = () => getStore("studyquest");

/* ----------------------------- main router ----------------------------- */
export default async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const action = new URL(request.url).pathname.split("/").filter(Boolean).pop();

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    switch (action) {
      // --- auth / first-run (no token required) ---
      case "signup":
        return await handleSignup(body);
      case "login":
        return await handleLogin(body);
      case "admin-status":
        return await handleAdminStatus();
      case "admin-init":
        return await handleAdminInit(body);

      // --- everything below requires a valid token ---
      case "me":
        return await withAuth(request, (pid) => handleMe(pid));
      case "verify-password":
        return await withAuth(request, (pid) => handleVerifyPassword(pid, body));
      case "change-password":
        return await withAuth(request, (pid) => handleChangePassword(pid, body));
      case "kids-list":
        return await withAuth(request, (pid) => handleKidsList(pid));
      case "kid-create":
        return await withAuth(request, (pid) => handleKidCreate(pid, body));
      case "kid-update":
        return await withAuth(request, (pid) => handleKidUpdate(pid, body));
      case "kid-delete":
        return await withAuth(request, (pid) => handleKidDelete(pid, body));
      case "data":
        return await withAuth(request, (pid) => handleData(pid, body));
      case "grade":
        return await withAuth(request, (pid) => handleGrade(body));
      case "generate":
        return await withAuth(request, (pid) => handleGenerate(body));
      case "help":
        return await withAuth(request, (pid) => handleHelp(body));

      // --- admin only (token + isAdmin re-checked server-side) ---
      case "admin-list-users":
        return await withAdmin(request, () => handleAdminListUsers());
      case "admin-reset-password":
        return await withAdmin(request, () => handleAdminResetPassword(body));

      default:
        return json({ error: "Unknown action" }, 404);
    }
  } catch (e) {
    return json({ error: "Server error", detail: String(e && e.message) }, 500);
  }
};

export const config = { path: "/api/:action" };

/* ------------------------------- auth bits ------------------------------ */

function requireSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("Server is missing SESSION_SECRET environment variable");
  return s;
}

function signToken(pid) {
  const secret = requireSecret();
  const payload = b64url(JSON.stringify({ pid, exp: Date.now() + TOKEN_TTL_MS }));
  const sig = b64url(crypto.createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const secret = requireSecret();
  const [payload, sig] = token.split(".");
  const expected = b64url(crypto.createHmac("sha256", secret).update(payload).digest());
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (!data.pid || !data.exp || Date.now() > data.exp) return null;
    return data.pid;
  } catch {
    return null;
  }
}

async function withAuth(request, fn) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const pid = verifyToken(token);
  if (!pid) return json({ error: "Not authenticated" }, 401);
  return fn(pid);
}

// Like withAuth, but also confirms the account is the admin (flag is read from
// storage every time — a token alone can never grant admin powers).
async function withAdmin(request, fn) {
  return withAuth(request, async (pid) => {
    const parent = await db().get(`parent:${pid}`, { type: "json" });
    if (!parent || !parent.isAdmin) return json({ error: "Admin access required" }, 403);
    return fn(pid, parent);
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash: derived };
}

function checkPassword(password, salt, hash) {
  const derived = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  return derived.length === stored.length && crypto.timingSafeEqual(derived, stored);
}

/* ----------------------------- auth handlers ---------------------------- */

async function handleSignup(body) {
  requireSecret(); // fail early with a clear message if unset
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const unameErr = validateUsername(username);
  if (unameErr) return json({ error: unameErr }, 400);
  if (username.toLowerCase() === "admin") return json({ error: "That username is reserved." }, 409);
  if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);

  const store = db();
  const lower = username.toLowerCase();
  const existing = await store.get(`uname:${lower}`);
  if (existing) return json({ error: "That username is already taken." }, 409);

  const pid = uid();
  const { salt, hash } = hashPassword(password);
  await store.setJSON(`parent:${pid}`, {
    id: pid,
    username,
    salt,
    hash,
    createdAt: Date.now(),
  });
  await store.set(`uname:${lower}`, pid);
  await store.setJSON(`kids:${pid}`, []);

  return json({ token: signToken(pid), parent: { username, isAdmin: false } }, 200);
}

async function handleLogin(body) {
  requireSecret();
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) return json({ error: "Enter your username and password." }, 400);

  const store = db();
  const pid = await store.get(`uname:${username.toLowerCase()}`);
  if (!pid) return json({ error: "Incorrect username or password." }, 401);

  const parent = await store.get(`parent:${pid}`, { type: "json" });
  if (!parent || !checkPassword(password, parent.salt, parent.hash)) {
    return json({ error: "Incorrect username or password." }, 401);
  }
  return json({ token: signToken(pid), parent: { username: parent.username, isAdmin: !!parent.isAdmin } }, 200);
}

async function handleMe(pid) {
  const parent = await db().get(`parent:${pid}`, { type: "json" });
  if (!parent) return json({ error: "Account not found" }, 404);
  return json({ username: parent.username, isAdmin: !!parent.isAdmin }, 200);
}

async function handleVerifyPassword(pid, body) {
  const parent = await db().get(`parent:${pid}`, { type: "json" });
  if (!parent) return json({ error: "Account not found" }, 404);
  const ok = checkPassword(String(body.password || ""), parent.salt, parent.hash);
  return json({ ok }, ok ? 200 : 401);
}

async function handleChangePassword(pid, body) {
  const store = db();
  const parent = await store.get(`parent:${pid}`, { type: "json" });
  if (!parent) return json({ error: "Account not found" }, 404);
  if (!checkPassword(String(body.current || ""), parent.salt, parent.hash)) {
    return json({ error: "Current password is incorrect." }, 401);
  }
  const next = String(body.next || "");
  if (next.length < 6) return json({ error: "New password must be at least 6 characters." }, 400);
  const { salt, hash } = hashPassword(next);
  await store.setJSON(`parent:${pid}`, { ...parent, salt, hash });
  return json({ ok: true }, 200);
}

/* ------------------------------ admin handlers -------------------------- */

// Has the admin account been created yet, and is setup key-protected?
async function handleAdminStatus() {
  const exists = await db().get(`uname:admin`);
  return json({ initialized: !!exists, setupProtected: !!process.env.ADMIN_SETUP_KEY }, 200);
}

// One-time creation of the admin account. Open by default for first-run
// convenience; if ADMIN_SETUP_KEY is set, the matching key is required.
async function handleAdminInit(body) {
  requireSecret();
  const store = db();
  const existing = await store.get(`uname:admin`);
  if (existing) return json({ error: "Admin account already exists. Please log in instead." }, 409);

  if (process.env.ADMIN_SETUP_KEY) {
    const provided = String(body.setupKey || "");
    if (provided !== process.env.ADMIN_SETUP_KEY) return json({ error: "Incorrect setup key." }, 403);
  }

  const password = String(body.password || "");
  if (password.length < 8) return json({ error: "Admin password must be at least 8 characters." }, 400);

  const pid = uid();
  const { salt, hash } = hashPassword(password);
  await store.setJSON(`parent:${pid}`, {
    id: pid,
    username: "admin",
    salt,
    hash,
    isAdmin: true,
    createdAt: Date.now(),
  });
  await store.set(`uname:admin`, pid);
  await store.setJSON(`kids:${pid}`, []);

  return json({ token: signToken(pid), parent: { username: "admin", isAdmin: true } }, 200);
}

// List every parent account (admin view). Never returns password hashes.
async function handleAdminListUsers() {
  const store = db();
  const { blobs } = await store.list({ prefix: "parent:" });
  const users = [];
  for (const b of blobs) {
    const p = await store.get(b.key, { type: "json" });
    if (!p) continue;
    let kidCount = 0;
    try {
      const kids = await store.get(`kids:${p.id}`, { type: "json" });
      kidCount = Array.isArray(kids) ? kids.length : 0;
    } catch {}
    users.push({ username: p.username, isAdmin: !!p.isAdmin, kidCount, createdAt: p.createdAt || 0 });
  }
  users.sort((a, b) => (a.isAdmin === b.isAdmin ? a.username.localeCompare(b.username) : a.isAdmin ? -1 : 1));
  return json({ users }, 200);
}

// Admin sets a new password for a target account (by username).
async function handleAdminResetPassword(body) {
  const username = String(body.username || "").trim();
  const newPassword = String(body.newPassword || "");
  if (!username) return json({ error: "Which user?" }, 400);
  if (newPassword.length < 6) return json({ error: "New password must be at least 6 characters." }, 400);

  const store = db();
  const pid = await store.get(`uname:${username.toLowerCase()}`);
  if (!pid) return json({ error: "No account with that username." }, 404);
  const parent = await store.get(`parent:${pid}`, { type: "json" });
  if (!parent) return json({ error: "Account not found." }, 404);

  const { salt, hash } = hashPassword(newPassword);
  await store.setJSON(`parent:${pid}`, { ...parent, salt, hash });
  return json({ ok: true, username: parent.username }, 200);
}

async function getKids(store, pid) {
  return (await store.get(`kids:${pid}`, { type: "json" })) || [];
}

async function handleKidsList(pid) {
  const kids = await getKids(db(), pid);
  return json({ kids: kids.map(publicKid) }, 200);
}

async function handleKidCreate(pid, body) {
  const name = String(body.name || "").trim().slice(0, 40);
  const grade = clampGrade(body.grade);
  if (!name) return json({ error: "Enter the child's name." }, 400);

  const store = db();
  const kids = await getKids(store, pid);
  if (kids.length >= 20) return json({ error: "Too many kids on one account." }, 400);
  const kid = { id: uid(), name, grade, createdAt: Date.now() };
  kids.push(kid);
  await store.setJSON(`kids:${pid}`, kids);
  return json({ kid: publicKid(kid), kids: kids.map(publicKid) }, 200);
}

async function handleKidUpdate(pid, body) {
  const id = String(body.id || "");
  const store = db();
  const kids = await getKids(store, pid);
  const idx = kids.findIndex((k) => k.id === id);
  if (idx === -1) return json({ error: "Child not found." }, 404);
  if (typeof body.name === "string") kids[idx].name = body.name.trim().slice(0, 40) || kids[idx].name;
  if (body.grade != null) kids[idx].grade = clampGrade(body.grade);
  if (body.categories && typeof body.categories === "object") {
    kids[idx].categories = sanitizeCategories(body.categories);
  }
  await store.setJSON(`kids:${pid}`, kids);
  return json({ kids: kids.map(publicKid) }, 200);
}

// keep the stored category prefs small and well-formed
function sanitizeCategories(cat) {
  const clean = (obj) => {
    const out = {};
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj).slice(0, 12)) {
        const arr = Array.isArray(obj[k]) ? obj[k] : [];
        out[String(k).slice(0, 40)] = arr
          .filter((v) => typeof v === "string")
          .map((v) => v.trim().slice(0, 40))
          .filter(Boolean)
          .slice(0, 30);
      }
    }
    return out;
  };
  return { selected: clean(cat.selected), custom: clean(cat.custom) };
}

async function handleKidDelete(pid, body) {
  const id = String(body.id || "");
  const store = db();
  const kids = await getKids(store, pid);
  const next = kids.filter((k) => k.id !== id);
  await store.setJSON(`kids:${pid}`, next);
  // best-effort cleanup of that kid's data blobs
  try {
    const { blobs } = await store.list({ prefix: `d:` });
    await Promise.all(
      blobs
        .filter((b) => b.key.startsWith(`d:`) && keyKidId(b.key.slice(2)) === id)
        .map((b) => store.delete(b.key))
    );
  } catch {
    /* non-fatal */
  }
  return json({ kids: next.map(publicKid) }, 200);
}

/* ------------------------------ data handler ---------------------------- */
// Generic per-kid key/value used by the app for daily questions, chores, and
// chore logs. Keys look like:  daily:<kidId>:<date> | chores:<kidId> | chore-log:<kidId>:<date>
// The kidId is always the segment right after the first colon. We authorize it
// against the parent's kid list before reading/writing.

async function handleData(pid, body) {
  const op = body.op;
  const key = String(body.key || "");
  const kidId = keyKidId(key);
  if (!kidId || !isAllowedDataKey(key)) return json({ error: "Bad data key" }, 400);

  const store = db();
  const kids = await getKids(store, pid);
  if (!kids.some((k) => k.id === kidId)) {
    return json({ error: "Not authorized for this child." }, 403);
  }

  const blobKey = `d:${key}`;
  if (op === "get") {
    const value = await store.get(blobKey, { type: "json" });
    return json({ value: value ?? null }, 200);
  }
  if (op === "set") {
    await store.setJSON(blobKey, body.value);
    return json({ ok: true }, 200);
  }
  return json({ error: "Unknown data op" }, 400);
}

function keyKidId(key) {
  const parts = String(key).split(":");
  return parts.length >= 2 ? parts[1] : "";
}
function isAllowedDataKey(key) {
  return /^daily:[^:]+:\d{4}-\d{2}-\d{2}$/.test(key) || /^chores:[^:]+$/.test(key) || /^chore-log:[^:]+:\d{4}-\d{2}-\d{2}$/.test(key);
}

/* ------------------------------ grade handler --------------------------- */

async function handleGrade(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "Server is missing ANTHROPIC_API_KEY" }, 500);

  const subject = String(body.subject || "").slice(0, 80);
  const grade = Number(body.grade) || 1;
  const items = Array.isArray(body.items) ? body.items : null;
  if (!subject || !items || items.length === 0) return json({ error: "Expected { subject, grade, items[] }" }, 400);
  if (items.length > 40) return json({ error: "Too many items" }, 400);

  const safeItems = items.map((it, i) => ({
    n: Number(it.n) || i + 1,
    question: String(it.question || "").slice(0, 500),
    expected: String(it.expected || "").slice(0, 300),
    student_answer: String(it.student_answer || "").slice(0, 500),
  }));

  const prompt =
    `You are a kind, encouraging teacher grading a Grade ${grade} student's short answers ` +
    `for the subject "${subject}".\n\n` +
    `For each item below, decide if the student's answer is CORRECT. Be reasonably lenient: ` +
    `accept synonyms, minor spelling/typo errors, partial-but-essentially-right answers, and ` +
    `extra words, as long as the core idea matches the expected answer. Mark it incorrect if it ` +
    `is blank, off-topic, or factually wrong.\n\n` +
    `Return ONLY a JSON array (no prose, no markdown fences). Each element must be:\n` +
    `{"n": <item number>, "correct": <true|false>, "note": "<a short, warm note under 12 words for the student>"}\n\n` +
    `Items:\n${JSON.stringify(safeItems, null, 2)}`;

  let aiRes;
  try {
    aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
  } catch {
    return json({ error: "Upstream request failed" }, 502);
  }
  if (!aiRes.ok) {
    const detail = await safeText(aiRes);
    return json({ error: "Anthropic API error", status: aiRes.status, detail }, 502);
  }

  const data = await aiRes.json();
  let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

  let results;
  try {
    results = JSON.parse(text);
  } catch {
    return json({ error: "Could not parse grading result" }, 502);
  }
  if (!Array.isArray(results)) return json({ error: "Unexpected grading shape" }, 502);

  const clean = results.map((r, i) => ({
    n: Number(r && r.n) || i + 1,
    correct: !!(r && r.correct),
    note: r && typeof r.note === "string" ? r.note.slice(0, 120) : "",
  }));
  return json({ results: clean }, 200);
}

/* ----- shared Claude call: returns concatenated text or throws ----- */
async function callClaude(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const e = new Error("Server is missing ANTHROPIC_API_KEY");
    e.code = 500;
    throw e;
  }
  let aiRes;
  try {
    aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens || 1024, messages: [{ role: "user", content: prompt }] }),
    });
  } catch {
    const e = new Error("Upstream request failed");
    e.code = 502;
    throw e;
  }
  if (!aiRes.ok) {
    const detail = await safeText(aiRes);
    const e = new Error(`Anthropic API error ${aiRes.status}: ${detail}`);
    e.code = 502;
    throw e;
  }
  const data = await aiRes.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

function stripFences(text) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}

/* --------------------------- question generation ------------------------ */
// Generates short-answer questions for one or more non-math subjects, drawn
// from the parent-selected categories. Used for built-in AND custom topics.
async function handleGenerate(body) {
  const grade = Number(body.grade) || 1;
  const requests = Array.isArray(body.requests) ? body.requests : null;
  if (!requests || requests.length === 0) return json({ error: "Expected { grade, requests[] }" }, 400);

  const safe = requests.slice(0, 8).map((r) => ({
    subject: String(r.subject || "").slice(0, 80),
    categories: (Array.isArray(r.categories) ? r.categories : []).filter((c) => typeof c === "string").map((c) => c.slice(0, 40)).slice(0, 30),
    count: Math.max(1, Math.min(10, Number(r.count) || 10)),
  }));

  const prompt =
    `You are an experienced ${gradeLabel(grade)} teacher writing a short-answer practice worksheet.\n` +
    `Write age-appropriate questions for a Grade ${grade} student. Each question must have a single, ` +
    `clear, factual answer that can be written in a few words (NO multiple choice, NO essays).\n\n` +
    `For each subject below, write exactly "count" questions, spread as evenly as possible across the ` +
    `listed categories. Keep every question and answer self-contained and unambiguous.\n\n` +
    `Subjects:\n${JSON.stringify(safe, null, 2)}\n\n` +
    `Return ONLY valid JSON (no prose, no markdown fences) in exactly this shape:\n` +
    `{ "questions": { "<subject>": [ { "q": "<question>", "a": "<concise correct answer>", "category": "<one of the listed categories>" } ] } }\n` +
    `Each subject key must match the subject name exactly, and each array must have the requested count.`;

  let text;
  try {
    text = await callClaude(prompt, 2000);
  } catch (e) {
    return json({ error: e.message }, e.code || 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return json({ error: "Could not parse generated questions" }, 502);
  }
  const q = parsed && parsed.questions && typeof parsed.questions === "object" ? parsed.questions : null;
  if (!q) return json({ error: "Unexpected generation shape" }, 502);

  // normalize
  const out = {};
  for (const r of safe) {
    const arr = Array.isArray(q[r.subject]) ? q[r.subject] : [];
    out[r.subject] = arr
      .filter((it) => it && typeof it.q === "string" && typeof it.a === "string")
      .slice(0, r.count)
      .map((it) => ({
        q: it.q.slice(0, 300),
        a: it.a.slice(0, 200),
        category: typeof it.category === "string" ? it.category.slice(0, 40) : "",
      }));
  }
  return json({ questions: out }, 200);
}

/* ------------------------------ teacher help ---------------------------- */
// After a child misses a question several times, explain it like a patient
// teacher and guide them to the answer.
async function handleHelp(body) {
  const subject = String(body.subject || "").slice(0, 80);
  const grade = Number(body.grade) || 1;
  const question = String(body.question || "").slice(0, 500);
  const expected = String(body.expected || "").slice(0, 300);
  const attempts = (Array.isArray(body.attempts) ? body.attempts : []).filter((a) => typeof a === "string").map((a) => a.slice(0, 200)).slice(0, 10);
  if (!question) return json({ error: "Expected a question" }, 400);

  const prompt =
    `You are a warm, patient ${gradeLabel(grade)} teacher helping a Grade ${grade} student who is stuck.\n\n` +
    `Subject: ${subject}\n` +
    `Question: ${question}\n` +
    `The correct answer is: ${expected}\n` +
    `The student has already tried${attempts.length ? ` ${attempts.length} time(s): ${JSON.stringify(attempts)}` : " several times"} and is frustrated.\n\n` +
    `Write a short, encouraging explanation (2 to 4 sentences, simple words a Grade ${grade} child understands). ` +
    `Gently explain how to think about the problem, then clearly tell them the correct answer and why it is right. ` +
    `Be kind and supportive. Do NOT use markdown, headings, or lists — just friendly sentences spoken directly to the child.`;

  let text;
  try {
    text = await callClaude(prompt, 400);
  } catch (e) {
    return json({ error: e.message }, e.code || 502);
  }
  return json({ help: text.slice(0, 800) }, 200);
}

function gradeLabel(g) {
  return g <= 5 ? "elementary school" : g <= 8 ? "middle school" : "high school";
}

function publicKid(k) {
  return { id: k.id, name: k.name, grade: k.grade, categories: k.categories || null };
}
function clampGrade(g) {
  const n = Math.round(Number(g) || 1);
  return Math.max(1, Math.min(12, n));
}
function validateUsername(u) {
  if (u.length < 3 || u.length > 30) return "Username must be 3–30 characters.";
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) return "Username can use letters, numbers, dots, dashes, underscores.";
  return null;
}
function uid() {
  return crypto.randomBytes(9).toString("base64url");
}
function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
