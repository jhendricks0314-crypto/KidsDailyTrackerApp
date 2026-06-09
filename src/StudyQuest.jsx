import React, { useState, useEffect, useCallback } from "react";
import { useAppUpdate, UpdateBanner } from "./appUpdate.jsx";

/* =========================================================================
   StudyQuest — daily questions + chores tracker for kids
   Single-file React app. Runs in any modern browser (Android / Fire tablet).
   Persists data via window.storage (survives across sessions).
   ========================================================================= */

/* ----------------------------- utilities ------------------------------ */

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
};

const fmtDate = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

const uid = () => Math.random().toString(36).slice(2, 10);

const rint = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rint(0, arr.length - 1)];

// normalize free-text answers for forgiving comparison
const norm = (s) =>
  (s || "")
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:'"()]/g, "")
    .replace(/\s+/g, " ");

/* ------------------------- backend API client --------------------------
   Data now lives on the server (Netlify Function + Blobs), scoped to the
   logged-in parent. The browser keeps only a signed session token.        */

const TOKEN_KEY = "sq-token";
let authToken = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;

function setToken(t) {
  authToken = t || null;
  try {
    if (t) window.localStorage.setItem(TOKEN_KEY, t);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
function getToken() {
  return authToken;
}

// low-level request to /api/<action>
async function apiRequest(action, body) {
  const res = await fetch(`/api/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401) {
    // session invalid/expired -> sign out everywhere
    setToken(null);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("sq-unauthorized"));
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const api = {
  async signup(username, password, familyCode) {
    const r = await apiRequest("signup", { username, password, familyCode });
    setToken(r.token);
    return r.parent;
  },
  async login(username, password) {
    const r = await apiRequest("login", { username, password });
    setToken(r.token);
    return r.parent;
  },
  logout() {
    setToken(null);
  },
  async me() {
    return apiRequest("me");
  },
  async verifyPassword(password) {
    try {
      const r = await apiRequest("verify-password", { password });
      return !!(r && r.ok);
    } catch {
      return false;
    }
  },
  async changePassword(current, next) {
    return apiRequest("change-password", { current, next });
  },
  async changeUsername(username) {
    const r = await apiRequest("change-username", { username });
    return r && r.username;
  },
  async familyInfo() {
    return apiRequest("family-info");
  },
  async familyRegenCode() {
    const r = await apiRequest("family-regen-code");
    return r && r.code;
  },
  async listKids() {
    const r = await apiRequest("kids-list");
    return (r && r.kids) || [];
  },
  async createKid(name, grade) {
    const r = await apiRequest("kid-create", { name, grade });
    return (r && r.kids) || [];
  },
  async updateKid(id, patch) {
    const r = await apiRequest("kid-update", { id, ...patch });
    return (r && r.kids) || [];
  },
  async deleteKid(id) {
    const r = await apiRequest("kid-delete", { id });
    return (r && r.kids) || [];
  },
  async generateQuestions(grade, requests) {
    const r = await apiRequest("generate", { grade, requests });
    return (r && r.questions) || {};
  },
  async getHelp(payload) {
    const r = await apiRequest("help", payload);
    return (r && r.help) || "";
  },
  // --- admin / first-run ---
  async adminStatus() {
    return apiRequest("admin-status");
  },
  async adminInit(password, setupKey) {
    const r = await apiRequest("admin-init", { password, setupKey });
    setToken(r.token);
    return r.parent;
  },
  async adminListUsers() {
    const r = await apiRequest("admin-list-users");
    return (r && r.users) || [];
  },
  async adminResetPassword(username, newPassword) {
    return apiRequest("admin-reset-password", { username, newPassword });
  },
};

/* Per-kid key/value store, now backed by the server. Keeps the same simple
   get/set interface the rest of the app already uses. Returns null/false on
   failure so callers degrade gracefully.                                   */
const store = {
  async get(key) {
    try {
      const r = await apiRequest("data", { op: "get", key });
      return r ? r.value : null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      await apiRequest("data", { op: "set", key, value });
      return true;
    } catch {
      return false;
    }
  },
};

/* ========================================================================
   QUESTION GENERATORS
   Each returns { q, a, type, accept? }  where:
     type "math"  -> exact match required
     type "text"  -> interpreted match (accept[] holds acceptable answers/keywords)
   `grade` is 1..12 and scales difficulty.
   ======================================================================== */

// Built-in categories per subject. Math categories map to procedural
// generators (answers always exact). Other subjects pass these to the AI.
const SUBJECT_CATEGORIES = {
  Math: ["Addition", "Subtraction", "Multiplication", "Division", "Fractions", "Word Problems", "Exponents & Powers", "Algebra"],
  "Reading & Writing": ["Vocabulary", "Synonyms & Antonyms", "Grammar", "Parts of Speech", "Spelling", "Literary Devices"],
  Science: ["Life Science", "Earth & Space", "Physical Science", "The Human Body", "Animals & Plants", "Weather"],
  History: ["U.S. History", "World History", "Ancient Civilizations", "Famous People", "Inventions"],
  Geography: ["Capitals", "Continents & Oceans", "Countries", "Physical Geography", "U.S. States"],
};
// Math categories that work for a given grade (keeps young kids on basics)
function mathCategoriesForGrade(grade) {
  const all = SUBJECT_CATEGORIES.Math;
  if (grade <= 2) return ["Addition", "Subtraction"];
  if (grade <= 5) return ["Addition", "Subtraction", "Multiplication", "Division", "Fractions", "Word Problems"];
  return all;
}

const MATH_GEN = {
  Addition(g) {
    const max = g <= 2 ? 12 : g <= 5 ? 200 : 9999;
    const a = rint(1, max), b = rint(1, max);
    return { type: "math", q: `${a} + ${b} = ?`, a: String(a + b) };
  },
  Subtraction(g) {
    const max = g <= 2 ? 15 : g <= 5 ? 200 : 9999;
    const a = rint(5, max), b = rint(1, a);
    return { type: "math", q: `${a} − ${b} = ?`, a: String(a - b) };
  },
  Multiplication(g) {
    const hi = g <= 5 ? 12 : 25;
    const a = rint(2, hi), b = rint(2, hi);
    return { type: "math", q: `${a} × ${b} = ?`, a: String(a * b) };
  },
  Division(g) {
    const hi = g <= 5 ? 12 : 20;
    const b = rint(2, hi), ans = rint(2, hi);
    return { type: "math", q: `${b * ans} ÷ ${b} = ?`, a: String(ans) };
  },
  Fractions(g) {
    // simplest: add fractions with the same denominator, answer as a/b (unreduced ok)
    const d = pick([2, 3, 4, 5, 6, 8, 10]);
    const a = rint(1, d - 1), b = rint(1, d - 1);
    const num = a + b;
    return {
      type: "math",
      q: `${a}/${d} + ${b}/${d} = ? (write your answer as a fraction like ${num}/${d})`,
      a: `${num}/${d}`,
      accept: [`${num}/${d}`],
    };
  },
  "Word Problems"(g) {
    const each = rint(2, g <= 5 ? 9 : 20);
    const groups = rint(2, g <= 5 ? 9 : 12);
    const names = ["Maya", "Liam", "Ava", "Noah", "Zoe", "Eli"];
    const items = ["apples", "stickers", "marbles", "cookies", "pencils", "coins"];
    return {
      type: "math",
      q: `${pick(names)} has ${groups} bags with ${each} ${pick(items)} in each bag. How many are there in total?`,
      a: String(each * groups),
    };
  },
  "Exponents & Powers"() {
    const b = rint(2, 9), e = rint(2, 3);
    return { type: "math", q: `${b}^${e} = ?`, a: String(Math.pow(b, e)) };
  },
  Algebra() {
    const x = rint(2, 20), c = rint(1, 30), m = rint(2, 9);
    return { type: "math", q: `Solve for x: ${m}x + ${c} = ${m * x + c}`, a: String(x) };
  },
};

function genMath(grade, category) {
  const g = Math.max(1, Math.min(12, grade));
  const fn = (category && MATH_GEN[category]) || null;
  if (fn) return fn(g);
  // no/unknown category -> pick any grade-appropriate one
  return MATH_GEN[pick(mathCategoriesForGrade(g))](g);
}

function genReading(grade) {
  const easy = [
    {
      q: "What is the opposite of 'happy'?",
      a: "sad",
      accept: ["sad", "unhappy", "upset", "angry"],
    },
    { q: "What do we call a person who teaches at a school?", a: "teacher", accept: ["teacher"] },
    {
      q: "Write a word that rhymes with 'cat'.",
      a: "hat / bat / mat",
      accept: ["hat", "bat", "mat", "rat", "sat", "fat", "pat", "vat"],
    },
    {
      q: "Is the word 'quickly' a noun, verb, or adverb?",
      a: "adverb",
      accept: ["adverb", "an adverb"],
    },
  ];
  const mid = [
    {
      q: "What is a synonym for 'enormous'?",
      a: "huge",
      accept: ["huge", "gigantic", "massive", "giant", "large", "big", "immense", "vast"],
    },
    {
      q: "What punctuation mark ends a question?",
      a: "question mark",
      accept: ["question mark", "?", "a question mark"],
    },
    {
      q: "Name the part of speech that describes a noun.",
      a: "adjective",
      accept: ["adjective", "an adjective"],
    },
    {
      q: "What is the past tense of 'run'?",
      a: "ran",
      accept: ["ran"],
    },
  ];
  const hard = [
    {
      q: "What literary device compares two things using 'like' or 'as'?",
      a: "simile",
      accept: ["simile", "a simile"],
    },
    {
      q: "What is the term for the main idea or message of a story?",
      a: "theme",
      accept: ["theme", "the theme"],
    },
    {
      q: "Name the literary device giving human traits to non-human things.",
      a: "personification",
      accept: ["personification"],
    },
    {
      q: "What do we call the person telling a story?",
      a: "narrator",
      accept: ["narrator", "the narrator"],
    },
  ];
  const pool = grade <= 3 ? easy : grade <= 7 ? [...easy, ...mid] : [...mid, ...hard];
  return { type: "text", ...pick(pool) };
}

function genScience(grade) {
  const easy = [
    { q: "What do plants need from the sky to make food and grow?", a: "sunlight", accept: ["sun", "sunlight", "light"] },
    { q: "How many legs does an insect have?", a: "6", accept: ["6", "six"] },
    { q: "What do we call frozen water?", a: "ice", accept: ["ice"] },
    { q: "What gas do humans breathe in to stay alive?", a: "oxygen", accept: ["oxygen", "o2"] },
  ];
  const mid = [
    { q: "What is the closest planet to the Sun?", a: "Mercury", accept: ["mercury"] },
    { q: "What is the powerhouse of the cell?", a: "mitochondria", accept: ["mitochondria", "mitochondrion"] },
    { q: "Water is made of hydrogen and which other element?", a: "oxygen", accept: ["oxygen"] },
    { q: "What force pulls objects toward the Earth?", a: "gravity", accept: ["gravity"] },
  ];
  const hard = [
    { q: "What is the chemical symbol for gold?", a: "Au", accept: ["au"] },
    { q: "What process do plants use to convert sunlight into energy?", a: "photosynthesis", accept: ["photosynthesis"] },
    { q: "What subatomic particle has a negative charge?", a: "electron", accept: ["electron", "electrons"] },
    { q: "What is Newton's unit of force called?", a: "newton", accept: ["newton", "newtons", "n"] },
  ];
  const pool = grade <= 3 ? easy : grade <= 7 ? [...easy, ...mid] : [...mid, ...hard];
  return { type: "text", ...pick(pool) };
}

function genHistory(grade) {
  const easy = [
    { q: "Who was the first President of the United States?", a: "George Washington", accept: ["washington", "george washington"] },
    { q: "On what continent is Egypt located?", a: "Africa", accept: ["africa"] },
    { q: "What do we call a person who rules a kingdom as a male monarch?", a: "king", accept: ["king", "a king"] },
    { q: "What holiday celebrates the birth of the United States?", a: "Independence Day", accept: ["independence day", "fourth of july", "4th of july", "july 4"] },
  ];
  const mid = [
    { q: "In what year did the United States declare independence?", a: "1776", accept: ["1776"] },
    { q: "Who wrote the Declaration of Independence (main author)?", a: "Thomas Jefferson", accept: ["jefferson", "thomas jefferson"] },
    { q: "What ancient civilization built the pyramids of Giza?", a: "Egyptians", accept: ["egypt", "egyptians", "ancient egypt"] },
    { q: "What ocean did Columbus cross to reach the Americas?", a: "Atlantic", accept: ["atlantic", "atlantic ocean"] },
  ];
  const hard = [
    { q: "In what year did World War II end?", a: "1945", accept: ["1945"] },
    { q: "Who was President during the American Civil War?", a: "Abraham Lincoln", accept: ["lincoln", "abraham lincoln"] },
    { q: "What document begins with 'We the People'?", a: "the Constitution", accept: ["constitution", "the constitution", "us constitution"] },
    { q: "What wall fell in 1989, symbolizing the end of the Cold War divide?", a: "Berlin Wall", accept: ["berlin wall", "the berlin wall"] },
  ];
  const pool = grade <= 3 ? easy : grade <= 7 ? [...easy, ...mid] : [...mid, ...hard];
  return { type: "text", ...pick(pool) };
}

function genGeography(grade) {
  const easy = [
    { q: "What do we call the large bodies of salt water on Earth?", a: "oceans", accept: ["ocean", "oceans", "sea", "seas"] },
    { q: "What is the capital of the United States?", a: "Washington, D.C.", accept: ["washington dc", "washington d c", "washington", "dc"] },
    { q: "Which direction does the sun rise from?", a: "east", accept: ["east", "the east"] },
    { q: "What do we call a very large area of land surrounded by ocean?", a: "continent", accept: ["continent", "a continent"] },
  ];
  const mid = [
    { q: "What is the longest river in the world?", a: "Nile", accept: ["nile", "the nile", "nile river"] },
    { q: "What is the capital of France?", a: "Paris", accept: ["paris"] },
    { q: "How many continents are there on Earth?", a: "7", accept: ["7", "seven"] },
    { q: "What is the largest ocean on Earth?", a: "Pacific", accept: ["pacific", "pacific ocean"] },
  ];
  const hard = [
    { q: "What is the smallest country in the world by area?", a: "Vatican City", accept: ["vatican", "vatican city"] },
    { q: "What mountain range separates Europe from Asia?", a: "Ural Mountains", accept: ["ural", "urals", "ural mountains"] },
    { q: "What is the capital of Japan?", a: "Tokyo", accept: ["tokyo"] },
    { q: "What desert is the largest hot desert in the world?", a: "Sahara", accept: ["sahara", "the sahara"] },
  ];
  const pool = grade <= 3 ? easy : grade <= 7 ? [...easy, ...mid] : [...mid, ...hard];
  return { type: "text", ...pick(pool) };
}

const SUBJECTS = [
  { key: "Math", gen: genMath, color: "#e8743b" },
  { key: "Reading & Writing", gen: genReading, color: "#3b7de8" },
  { key: "Science", gen: genScience, color: "#2fa84f" },
  { key: "History", gen: genHistory, color: "#9b4dca" },
  { key: "Geography", gen: genGeography, color: "#d4a017" },
];

// Resolve which categories are selected for a subject for this kid.
// Falls back to all built-in categories when nothing is chosen.
function selectedCategoriesFor(subjectKey, kid) {
  const builtIn = SUBJECT_CATEGORIES[subjectKey] || [];
  const custom = (kid && kid.categories && kid.categories.custom && kid.categories.custom[subjectKey]) || [];
  const available = subjectKey === "Math" ? builtIn : [...builtIn, ...custom];
  const sel = kid && kid.categories && kid.categories.selected && kid.categories.selected[subjectKey];
  if (Array.isArray(sel) && sel.length) {
    const filtered = sel.filter((c) => available.includes(c));
    if (filtered.length) return filtered;
  }
  // default: focus on all built-in categories (grade-limited for math)
  return subjectKey === "Math" ? mathCategoriesForGrade(kid ? kid.grade : 3) : builtIn;
}

const blankItem = (item) => ({ ...item, response: "", checked: false, correct: null, misses: 0, help: "" });

// Procedural Math: round-robin across the selected operation categories.
function buildMathList(grade, categories, count = 10) {
  const cats = categories && categories.length ? categories : mathCategoriesForGrade(grade);
  const list = [];
  const seen = new Set();
  let i = 0, guard = 0;
  while (list.length < count && guard < 600) {
    guard++;
    const cat = cats[i % cats.length];
    i++;
    const item = genMath(grade, cat);
    if (seen.has(item.q)) continue;
    seen.add(item.q);
    list.push(blankItem({ ...item, category: cat }));
  }
  while (list.length < count) list.push(blankItem(genMath(grade, cats[list.length % cats.length])));
  return list;
}

// Offline fallback for text subjects: the original curated generators.
function buildTextListFallback(subject, grade) {
  const s = SUBJECTS.find((x) => x.key === subject);
  const list = [];
  const seen = new Set();
  let guard = 0;
  while (list.length < 10 && guard < 200) {
    guard++;
    const item = s.gen(grade);
    if (seen.has(item.q)) continue;
    seen.add(item.q);
    list.push(blankItem(item));
  }
  while (list.length < 10) list.push(blankItem(s.gen(grade)));
  return list;
}

// Split a subject's selected categories into built-in vs custom.
function splitCategories(subjectKey, kid) {
  const builtIn = SUBJECT_CATEGORIES[subjectKey] || [];
  const customAll = (kid && kid.categories && kid.categories.custom && kid.categories.custom[subjectKey]) || [];
  const selected = selectedCategoriesFor(subjectKey, kid);
  return {
    builtInSel: selected.filter((c) => builtIn.includes(c)),
    customSel: selected.filter((c) => customAll.includes(c) && !builtIn.includes(c)),
  };
}

// Build a full day of questions.
//  • Math built-in categories  -> procedural (answers always exact)
//  • Math custom categories    -> AI-generated (graded by exact match)
//  • Other subjects            -> AI-generated from the selected categories
// Everything falls back to the curated/procedural generators when offline.
async function buildDay(grade, kid) {
  const out = {};
  const aiRequests = []; // {subject, categories, count}

  // ----- Math: split 10 questions between built-in (procedural) and custom (AI)
  const mathSplit = splitCategories("Math", kid);
  let mathCustomCount = 0;
  if (mathSplit.customSel.length) {
    const total = mathSplit.builtInSel.length + mathSplit.customSel.length;
    mathCustomCount = Math.round((mathSplit.customSel.length / total) * 10);
    if (mathCustomCount === 0) mathCustomCount = 1;
    if (mathSplit.builtInSel.length === 0) mathCustomCount = 10;
    mathCustomCount = Math.min(10, mathCustomCount);
  }
  const mathBuiltInCount = 10 - mathCustomCount;
  out["Math"] = mathBuiltInCount > 0 ? buildMathList(grade, mathSplit.builtInSel, mathBuiltInCount) : [];
  if (mathCustomCount > 0) {
    aiRequests.push({ subject: "Math", categories: mathSplit.customSel, count: mathCustomCount });
  }

  // ----- Text subjects: all selected categories are AI-generated
  const textSubjects = SUBJECTS.filter((s) => s.key !== "Math");
  for (const s of textSubjects) {
    aiRequests.push({ subject: s.key, categories: selectedCategoriesFor(s.key, kid), count: 10 });
  }

  // ----- one AI call for everything that needs generating
  let generated = null;
  if (aiRequests.length) {
    try {
      generated = await api.generateQuestions(grade, aiRequests);
    } catch {
      generated = null;
    }
  }

  // merge text subjects (AI, with curated fallback)
  for (const s of textSubjects) {
    const gen = generated && generated[s.key];
    if (gen && gen.length) {
      let list = gen.map((it) => blankItem({ type: "text", q: it.q, a: it.a, accept: [it.a], category: it.category || "" }));
      while (list.length < 10) list.push(blankItem(SUBJECTS.find((x) => x.key === s.key).gen(grade)));
      out[s.key] = list.slice(0, 10);
    } else {
      out[s.key] = buildTextListFallback(s.key, grade);
    }
  }

  // merge Math: procedural built-in + AI custom; backfill procedurally if AI failed
  let mathList = out["Math"].slice();
  const mathGen = generated && generated["Math"];
  if (mathGen && mathGen.length) {
    mathList = mathList.concat(
      mathGen.map((it) => blankItem({ type: "math", q: it.q, a: it.a, accept: [it.a], category: it.category || "" }))
    );
  }
  while (mathList.length < 10) {
    mathList.push(blankItem(genMath(grade, pick(mathCategoriesForGrade(grade)))));
  }
  out["Math"] = mathList.slice(0, 10);

  return out;
}

// offline / fallback grading (also used for math, always)
function gradeAnswer(item) {
  if (item.type === "math") {
    return norm(item.response) === norm(item.a);
  }
  const r = norm(item.response);
  if (!r) return false;
  const acc = (item.accept || [item.a]).map(norm);
  // accept if response equals an acceptable answer, or contains it as a whole word
  return acc.some((a) => r === a || r.split(" ").includes(a) || r.includes(a));
}

/* ---------------- AI grading via secure serverless proxy ----------------
   The browser NEVER sees the API key. It posts the questions to our own
   Netlify Function at /api/grade, which holds ANTHROPIC_API_KEY server-side,
   calls Anthropic, and returns a clean array aligned to `items`:
     [{correct, note}, ...]
   Throws on any network/parse failure so the caller can fall back to the
   offline keyword grader (gradeAnswer).                                    */
async function gradeWrittenBatch(subject, grade, items) {
  const payload = items.map((it, i) => ({
    n: i + 1,
    question: it.q,
    expected: it.a,
    student_answer: it.response || "",
  }));

  const res = await fetch("/api/grade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, grade, items: payload }),
  });
  if (!res.ok) throw new Error("grading request failed");

  const data = await res.json();
  const parsed = data && Array.isArray(data.results) ? data.results : null;
  if (!parsed) throw new Error("bad grading shape");

  // map back by item number, defensively
  return items.map((_, i) => {
    const found = parsed.find((p) => Number(p.n) === i + 1);
    return {
      correct: !!(found && found.correct),
      note: (found && typeof found.note === "string" ? found.note : "") || "",
    };
  });
}

/* ============================ DEFAULT CHORES ============================ */
/* ============================ DEFAULT CHORES ============================ */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const todayDow = () => new Date().getDay();
// a chore applies today if it has no day list (legacy = every day) or includes today
const choreAppliesToday = (c) => !Array.isArray(c.days) || c.days.length === 0 || c.days.includes(todayDow());

const DEFAULT_CHORES = [
  { title: "Make your bed", days: ALL_DAYS },
  { title: "Brush your teeth", days: ALL_DAYS },
  { title: "Tidy your room", days: ALL_DAYS },
  { title: "Feed the pet", days: ALL_DAYS },
];

/* =============================== STYLES ================================= */
const FONT_DISPLAY = "'Fredoka', system-ui, sans-serif";
const FONT_BODY = "'Nunito', system-ui, sans-serif";

const css = `
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;600;700;800&display=swap');
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
.sq-root { font-family: ${FONT_BODY}; color: #2b2438; }
.sq-h { font-family: ${FONT_DISPLAY}; }
@media print {
  .sq-noprint { display: none !important; }
  .sq-printpage { page-break-after: always; padding: 0 !important; }
  .sq-root { background: #fff !important; }
}
@keyframes pop { 0%{transform:scale(.96);opacity:0} 100%{transform:scale(1);opacity:1} }
.sq-card { animation: pop .25s ease; }

/* ---- correct-answer celebration ---- */
@keyframes sq-burst {
  0%   { transform: translate(0,0) scale(0); opacity: 1; }
  70%  { opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(1); opacity: 0; }
}
@keyframes sq-badge-pop {
  0%   { transform: scale(0) rotate(-25deg); }
  55%  { transform: scale(1.35) rotate(8deg); }
  75%  { transform: scale(.9) rotate(-4deg); }
  100% { transform: scale(1) rotate(0); }
}
@keyframes sq-wiggle {
  0%,100% { transform: rotate(0); }
  25% { transform: rotate(-12deg); }
  75% { transform: rotate(12deg); }
}
.sq-confetti-wrap { position: relative; width: 0; height: 0; }
.sq-confetti {
  position: absolute; top: 0; left: 0;
  font-size: 18px; line-height: 1;
  animation: sq-burst .9s ease-out forwards;
  pointer-events: none;
}
.sq-correct-badge {
  display: inline-flex; align-items: center; gap: 6px;
  font-weight: 900; color: #1f9d4d;
  animation: sq-badge-pop .55s cubic-bezier(.18,1.4,.4,1) both;
}
.sq-correct-badge .emoji { display:inline-block; animation: sq-wiggle .6s ease .3s 2; }

/* ---- full-subject "aced it" overlay ---- */
@keyframes sq-fade { from{opacity:0} to{opacity:1} }
@keyframes sq-zoom { 0%{transform:scale(.4);opacity:0} 60%{transform:scale(1.08)} 100%{transform:scale(1);opacity:1} }
@keyframes sq-rain {
  0% { transform: translateY(-12vh) rotate(0); opacity:1; }
  100% { transform: translateY(112vh) rotate(540deg); opacity:1; }
}
.sq-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(36,28,56,.55); backdrop-filter: blur(3px);
  display: grid; place-items: center; animation: sq-fade .25s ease;
  overflow: hidden;
}
.sq-overlay-card {
  background: #fff; border-radius: 28px; padding: 34px 40px;
  text-align: center; box-shadow: 0 24px 60px rgba(0,0,0,.3);
  animation: sq-zoom .5s cubic-bezier(.2,1.3,.4,1) both; max-width: 380px;
}
.sq-rainpiece { position: fixed; top: 0; font-size: 26px; animation: sq-rain linear forwards; pointer-events: none; z-index: 9998; }

/* gentle pulse on the celebrate emoji */
@keyframes sq-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
.sq-bob { display:inline-block; animation: sq-bob 1.2s ease-in-out infinite; }

/* ---- app update banner ---- */
@keyframes sq-slidedown { from{transform:translate(-50%,-120%);opacity:0} to{transform:translate(-50%,0);opacity:1} }
.sq-update {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  z-index: 10000; width: min(560px, calc(100% - 24px));
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px; border-radius: 16px;
  background: linear-gradient(135deg, #4a3f5e, #6a4f86);
  color: #fff; box-shadow: 0 10px 30px rgba(74,63,94,.35);
  animation: sq-slidedown .4s cubic-bezier(.2,1.1,.4,1) both;
}
.sq-update-emoji { font-size: 24px; animation: sq-bob 1.4s ease-in-out infinite; }
.sq-update-btn {
  flex-shrink: 0; padding: 10px 18px; border-radius: 12px; border: none;
  background: #fff; color: #4a3f5e; font-weight: 800; font-size: 14px;
  cursor: pointer; font-family: 'Fredoka', sans-serif;
}
.sq-update-btn:disabled { opacity: .6; cursor: wait; }

/* ---- teacher help ---- */
.sq-help-btn {
  margin-top: 8px; padding: 9px 16px; border-radius: 999px; border: none;
  background: linear-gradient(135deg, #2fa84f, #1f9d6d); color: #fff;
  font-weight: 800; font-size: 14px; cursor: pointer; font-family: 'Fredoka', sans-serif;
  box-shadow: 0 3px 10px rgba(47,168,79,.3);
}
.sq-help-btn:disabled { opacity: .65; cursor: wait; }
.sq-help-box {
  margin-top: 10px; padding: 12px 14px; border-radius: 14px;
  background: #effaf1; border: 1.5px solid #bfe6c9; color: #245c39;
  font-size: 14px; animation: pop .25s ease;
}
`;

/* =============================== APP ================================== */

export default function App() {
  const [loading, setLoading] = useState(true);

  // app self-update (PWA): detects new deploys and offers an Update button
  const { updateReady, applyUpdate } = useAppUpdate();

  // auth / session
  const [parent, setParent] = useState(null); // { username, isAdmin } when logged in
  const [parentMode, setParentMode] = useState(false);
  const [adminInitialized, setAdminInitialized] = useState(true); // assume yes until checked
  const [setupProtected, setSetupProtected] = useState(false);

  // data
  const [kids, setKids] = useState([]);
  const [activeKid, setActiveKid] = useState(null); // kid id
  const [day, setDay] = useState(null); // generated questions for active kid/today
  const [dayLoading, setDayLoading] = useState(false); // generating today's questions
  const [chores, setChores] = useState([]); // templates for active kid
  const [choreLog, setChoreLog] = useState({}); // today's chore responses

  // ui
  const [tab, setTab] = useState("study"); // study | chores | calendar
  const [calMode, setCalMode] = useState("study");
  const [showReward, setShowReward] = useState(false); // reward game modal

  const date = todayKey();

  const logout = useCallback(() => {
    api.logout();
    setParent(null);
    setKids([]);
    setActiveKid(null);
    setDay(null);
    setChores([]);
    setChoreLog({});
    setParentMode(false);
  }, []);

  /* ---------- initial load: validate existing session, then fetch kids ---------- */
  useEffect(() => {
    (async () => {
      if (!getToken()) {
        // no session: find out whether the admin account exists yet (first run)
        try {
          const s = await api.adminStatus();
          setAdminInitialized(!!s.initialized);
          setSetupProtected(!!s.setupProtected);
        } catch {
          setAdminInitialized(true); // if the check fails, fall back to normal login
        }
        setLoading(false);
        return;
      }
      try {
        const me = await api.me();
        setParent(me);
        const ks = await api.listKids();
        setKids(ks);
        if (ks.length) setActiveKid(ks[0].id);
      } catch {
        api.logout();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // if any request reports the session is invalid, sign out
  useEffect(() => {
    const onUnauth = () => logout();
    window.addEventListener("sq-unauthorized", onUnauth);
    return () => window.removeEventListener("sq-unauthorized", onUnauth);
  }, [logout]);

  // called by the login/signup screen once a token is set
  const handleAuthed = async (parentObj) => {
    setParent(parentObj);
    setLoading(true);
    try {
      const ks = await api.listKids();
      setKids(ks);
      setActiveKid(ks[0]?.id || null);
    } finally {
      setLoading(false);
    }
  };

  // refresh kids after parent edits (used by the parent panel)
  // refresh kids after parent edits. Pass a known array (e.g. the one a
  // create/update/delete call already returned) to update instantly without a
  // second fetch that could momentarily return stale data.
  const refreshKids = useCallback(async (known) => {
    const ks = Array.isArray(known) ? known : await api.listKids();
    setKids(ks);
    setActiveKid((cur) => (ks.some((k) => k.id === cur) ? cur : ks[0]?.id || null));
    return ks;
  }, []);

  /* ---------- when active kid changes: load/generate day + chores ---------- */
  const loadKidData = useCallback(
    async (kidId) => {
      if (!kidId) return;
      const kid = kids.find((x) => x.id === kidId);
      if (!kid) return;

      // daily questions — generate once per day if missing
      const dayKeyName = `daily:${kidId}:${date}`;
      let d = await store.get(dayKeyName);
      if (!d) {
        setDay(null);
        setDayLoading(true);
        try {
          d = await buildDay(kid.grade, kid);
          await store.set(dayKeyName, d);
        } finally {
          setDayLoading(false);
        }
      }
      setDay(d);

      // chores templates
      let ch = await store.get(`chores:${kidId}`);
      if (ch == null) {
        ch = DEFAULT_CHORES.map((c) => ({ id: uid(), title: c.title, days: c.days.slice() }));
        await store.set(`chores:${kidId}`, ch);
      }
      setChores(ch);

      // today's chore log
      const log = (await store.get(`chore-log:${kidId}:${date}`)) || {};
      setChoreLog(log);
    },
    [kids, date]
  );

  useEffect(() => {
    if (activeKid) loadKidData(activeKid);
  }, [activeKid, loadKidData]);

  /* ---------- per-kid persistence helpers ---------- */
  const saveDay = async (next) => {
    setDay(next);
    if (activeKid) await store.set(`daily:${activeKid}:${date}`, next);
  };
  const saveChores = async (next) => {
    setChores(next);
    if (activeKid) await store.set(`chores:${activeKid}`, next);
  };
  const saveChoreLog = async (next) => {
    setChoreLog(next);
    if (activeKid) await store.set(`chore-log:${activeKid}:${date}`, next);
  };

  /* ---------- reward game: all questions correct + all today's chores done ---------- */
  const allQuestionsCorrect =
    !!day &&
    SUBJECTS.every((s) => Array.isArray(day[s.key]) && day[s.key].length > 0 && day[s.key].every((it) => it.correct === true));

  const choresToday = chores.filter(choreAppliesToday);
  const allChoresDone = choresToday.length === 0 || choresToday.every((c) => (choreLog[c.id] || {}).completed === "yes");

  const rewardEarned = allQuestionsCorrect && allChoresDone;

  // auto-pop the game once per day per kid (guard persisted inside the day object)
  useEffect(() => {
    if (rewardEarned && day && !day.__rewardShown) {
      setShowReward(true);
      saveDay({ ...day, __rewardShown: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewardEarned]);

  if (loading)
    return (
      <div style={{ ...wrap, display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <style>{css}</style>
        {updateReady && <UpdateBanner onUpdate={applyUpdate} />}
        <div className="sq-h" style={{ fontSize: 22, color: "#7a6f8c" }}>
          Loading StudyQuest…
        </div>
      </div>
    );

  // not logged in -> show the account screen
  // not logged in -> first-run admin setup, or the normal account screen
  if (!parent) {
    const banner = updateReady ? <UpdateBanner onUpdate={applyUpdate} /> : null;
    if (!adminInitialized)
      return <AdminInitScreen setupProtected={setupProtected} onAuthed={handleAuthed} updateBanner={banner} />;
    return <AuthScreen onAuthed={handleAuthed} updateBanner={banner} />;
  }

  const kid = kids.find((x) => x.id === activeKid) || null;

  return (
    <div className="sq-root" style={wrap}>
      <style>{css}</style>
      {updateReady && <UpdateBanner onUpdate={applyUpdate} />}

      <Header
        parent={parent}
        kids={kids}
        activeKid={activeKid}
        setActiveKid={setActiveKid}
        parentMode={parentMode}
        onParent={() => setParentMode(true)}
        onExitParent={() => setParentMode(false)}
        onLogout={logout}
      />

      {parentMode ? (
        <ParentPanel
          parent={parent}
          setParent={setParent}
          kids={kids}
          refreshKids={refreshKids}
          activeKid={activeKid}
          setActiveKid={setActiveKid}
          date={date}
        />
      ) : !kid ? (
        <EmptyState onParent={() => setParentMode(true)} />
      ) : (
        <>
          <TabBar tab={tab} setTab={setTab} />
          {rewardEarned && (
            <div className="sq-noprint sq-update" style={{ position: "static", transform: "none", width: "auto", marginBottom: 16, background: "linear-gradient(135deg,#2fa84f,#1f9d6d)" }}>
              <span className="sq-update-emoji" aria-hidden="true">🎉</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontFamily: FONT_DISPLAY }}>All done — you earned a game!</div>
                <div style={{ fontSize: 13, opacity: 0.9 }}>Everything correct and all chores finished. Nice!</div>
              </div>
              <button className="sq-update-btn" onClick={() => setShowReward(true)}>Play 🎮</button>
            </div>
          )}
          {tab === "study" && <StudyView kid={kid} day={day} saveDay={saveDay} dayLoading={dayLoading} />}
          {tab === "chores" && (
            <ChoresView chores={chores} choreLog={choreLog} saveChoreLog={saveChoreLog} />
          )}
          {tab === "calendar" && (
            <CalendarView kid={kid} mode={calMode} setMode={setCalMode} date={date} />
          )}
        </>
      )}

      {showReward && kid && (
        <RewardGameModal grade={kid.grade} kidName={kid.name} onClose={() => setShowReward(false)} />
      )}

      <footer className="sq-noprint" style={{ textAlign: "center", padding: "24px 0", color: "#a99fb8", fontSize: 13 }}>
        StudyQuest · a new set of questions appears each day
      </footer>
    </div>
  );
}

/* ============================ AUTH SCREEN ============================ */
function AuthScreen({ onAuthed, updateBanner }) {
  const [mode, setMode] = useState("login"); // login | signup
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [joinFamily, setJoinFamily] = useState(false);
  const [familyCode, setFamilyCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr("");
    if (username.trim().length < 3) return setErr("Username must be at least 3 characters.");
    if (password.length < 6) return setErr("Password must be at least 6 characters.");
    if (mode === "signup" && password !== confirm) return setErr("Passwords don't match.");
    if (mode === "signup" && joinFamily && !familyCode.trim()) return setErr("Enter the family code, or uncheck the box to start a new family.");
    setBusy(true);
    try {
      const parentObj =
        mode === "signup"
          ? await api.signup(username.trim(), password, joinFamily ? familyCode.trim() : "")
          : await api.login(username.trim(), password);
      await onAuthed(parentObj);
    } catch (e) {
      setErr(e.message || "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <div className="sq-root" style={{ ...wrap, minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <style>{css}</style>
      {updateBanner}
      <div className="sq-card" style={{ ...panel, maxWidth: 440, width: "100%" }}>
        <div style={{ fontSize: 40, textAlign: "center" }}>🎓</div>
        <h1 className="sq-h" style={{ ...h1, textAlign: "center", marginTop: 4 }}>
          {mode === "signup" ? "Create a parent account" : "Welcome back"}
        </h1>
        <p style={{ color: "#7a6f8c", textAlign: "center", marginTop: -6 }}>
          {mode === "signup"
            ? "Your kids' profiles and progress are saved to your account."
            : "Log in to see your kids and their progress."}
        </p>

        <label style={lbl}>Username</label>
        <input
          style={input}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. smith_family"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <label style={lbl}>Password</label>
        <input
          style={input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your password"
          onKeyDown={(e) => mode === "login" && e.key === "Enter" && submit()}
        />
        {mode === "signup" && (
          <>
            <label style={lbl}>Confirm password</label>
            <input
              style={input}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter password"
              onKeyDown={(e) => !joinFamily && e.key === "Enter" && submit()}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, color: "#6a5f7e", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={joinFamily} onChange={(e) => setJoinFamily(e.target.checked)} style={{ width: 18, height: 18 }} />
              Join an existing family (a co-parent shared a code)
            </label>
            {joinFamily && (
              <>
                <input
                  style={{ ...input, marginTop: 8, letterSpacing: ".1em", textTransform: "uppercase" }}
                  value={familyCode}
                  onChange={(e) => setFamilyCode(e.target.value)}
                  placeholder="FAMILY CODE (e.g. ABCD-2345-WXYZ)"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                />
                <div style={{ fontSize: 12, color: "#9a8fb0", marginTop: 4 }}>
                  You'll create your own login, but see the same kids as the rest of your family.
                </div>
              </>
            )}
          </>
        )}

        {err && <div style={errBox}>{err}</div>}

        <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
          {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
        </button>

        <div style={{ textAlign: "center", marginTop: 14, color: "#7a6f8c", fontSize: 14 }}>
          {mode === "signup" ? "Already have an account? " : "New here? "}
          <button
            onClick={() => {
              setMode(mode === "signup" ? "login" : "signup");
              setErr("");
            }}
            style={{ background: "none", border: "none", color: "#4a3f5e", fontWeight: 800, cursor: "pointer", fontFamily: FONT_DISPLAY, fontSize: 14 }}
          >
            {mode === "signup" ? "Log in" : "Create one"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================== ADMIN FIRST-RUN =========================== */
function AdminInitScreen({ setupProtected, onAuthed, updateBanner }) {
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr("");
    if (p1.length < 8) return setErr("Admin password must be at least 8 characters.");
    if (p1 !== p2) return setErr("Passwords don't match.");
    if (setupProtected && !setupKey.trim()) return setErr("Enter the setup key.");
    setBusy(true);
    try {
      const parentObj = await api.adminInit(p1, setupKey.trim());
      await onAuthed(parentObj);
    } catch (e) {
      setErr(e.message || "Could not create the admin account.");
      setBusy(false);
    }
  };

  return (
    <div className="sq-root" style={{ ...wrap, minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <style>{css}</style>
      {updateBanner}
      <div className="sq-card" style={{ ...panel, maxWidth: 460, width: "100%" }}>
        <div style={{ fontSize: 40, textAlign: "center" }}>🛡️</div>
        <h1 className="sq-h" style={{ ...h1, textAlign: "center", marginTop: 4 }}>Set up the admin account</h1>
        <p style={{ color: "#7a6f8c", textAlign: "center", marginTop: -6 }}>
          This is a one-time setup. Create the password for the <strong>admin</strong> account, which can
          manage families and reset passwords. Do this now to secure your app.
        </p>

        {setupProtected && (
          <>
            <label style={lbl}>Setup key</label>
            <input style={input} type="password" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} placeholder="From your ADMIN_SETUP_KEY" />
          </>
        )}
        <label style={lbl}>Admin password</label>
        <input style={input} type="password" value={p1} onChange={(e) => setP1(e.target.value)} placeholder="At least 8 characters" />
        <label style={lbl}>Confirm password</label>
        <input style={input} type="password" value={p2} onChange={(e) => setP2(e.target.value)} placeholder="Re-enter password" onKeyDown={(e) => e.key === "Enter" && submit()} />
        {err && <div style={errBox}>{err}</div>}
        <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
          {busy ? "Creating…" : "Create admin account"}
        </button>
        <p style={{ fontSize: 12, color: "#9a8fb0", marginTop: 12, textAlign: "center" }}>
          You'll log in later with the username <strong>admin</strong> and this password.
        </p>
      </div>
    </div>
  );
}

/* =============================== HEADER ============================== */
function Header({ parent, kids, activeKid, setActiveKid, parentMode, onParent, onExitParent, onLogout }) {
  return (
    <header className="sq-noprint" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
      <div className="sq-h" style={{ fontSize: 26, fontWeight: 700, color: "#4a3f5e", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 28 }}>🎓</span> StudyQuest
      </div>
      <div style={{ flex: 1 }} />
      {!parentMode && kids.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {kids.map((k) => (
            <button
              key={k.id}
              onClick={() => setActiveKid(k.id)}
              style={{
                ...chip,
                background: k.id === activeKid ? "#4a3f5e" : "#fff",
                color: k.id === activeKid ? "#fff" : "#4a3f5e",
                borderColor: k.id === activeKid ? "#4a3f5e" : "#e3dcec",
              }}
            >
              {k.name} · G{k.grade}
            </button>
          ))}
        </div>
      )}
      {parent && (
        <span className="sq-h" style={{ color: "#9a8fb0", fontSize: 13, fontWeight: 700 }}>
          @{parent.username}{parent.isAdmin ? " 🛡️" : ""}
        </span>
      )}
      {parentMode ? (
        <button style={btnGhost} onClick={onExitParent}>← Exit parent</button>
      ) : (
        <button style={btnGhost} onClick={onParent}>🔒 Parent</button>
      )}
      <button style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }} onClick={onLogout}>
        Log out
      </button>
    </header>
  );
}

function TabBar({ tab, setTab }) {
  const tabs = [
    ["study", "📚 Questions"],
    ["chores", "🧹 Chores"],
    ["calendar", "📅 Calendar"],
  ];
  return (
    <div className="sq-noprint" style={{ display: "flex", gap: 8, marginBottom: 18 }}>
      {tabs.map(([k, label]) => (
        <button
          key={k}
          onClick={() => setTab(k)}
          style={{
            ...tabBtn,
            background: tab === k ? "#fff" : "transparent",
            boxShadow: tab === k ? "0 2px 10px rgba(74,63,94,.12)" : "none",
            color: tab === k ? "#4a3f5e" : "#8a7fa0",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ onParent }) {
  return (
    <div className="sq-card" style={{ ...panel, textAlign: "center" }}>
      <div style={{ fontSize: 40 }}>👋</div>
      <h2 className="sq-h" style={h2}>No kid profiles yet</h2>
      <p style={{ color: "#7a6f8c" }}>Open the parent panel to add a child and set their grade level.</p>
      <button style={btnPrimary} onClick={onParent}>🔒 Open parent panel</button>
    </div>
  );
}

/* ============================ STUDY VIEW ============================ */
/* ---- celebration pieces (CSS/emoji only — works offline & in APK) ---- */
const PARTICLES = ["⭐", "🎉", "✨", "🌟", "🎊", "💫", "🏆", "👏"];

function Confetti() {
  // burst of particles flying outward from the badge
  const pieces = Array.from({ length: 12 }).map((_, i) => {
    const angle = (Math.PI * 2 * i) / 12 + Math.random() * 0.4;
    const dist = 36 + Math.random() * 34;
    return {
      key: i,
      char: PARTICLES[i % PARTICLES.length],
      dx: `${Math.cos(angle) * dist}px`,
      dy: `${Math.sin(angle) * dist}px`,
      delay: `${Math.random() * 0.08}s`,
    };
  });
  return (
    <span className="sq-confetti-wrap" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.key}
          className="sq-confetti"
          style={{ ["--dx"]: p.dx, ["--dy"]: p.dy, animationDelay: p.delay }}
        >
          {p.char}
        </span>
      ))}
    </span>
  );
}

const PRAISE = ["Correct!", "Nailed it!", "Awesome!", "You got it!", "Brilliant!", "Yes!", "Great job!"];
function CorrectBadge({ seed = 0 }) {
  const word = PRAISE[seed % PRAISE.length];
  const face = ["🎯", "🌟", "🚀", "🦄", "🏅", "🎉"][seed % 6];
  return (
    <span className="sq-correct-badge">
      <Confetti />
      <span className="emoji" style={{ fontSize: 20 }}>{face}</span>
      {word}
    </span>
  );
}

function AcedOverlay({ subject, color, onClose }) {
  // celebratory raining emojis + a trophy card when a subject is 100%
  const rain = Array.from({ length: 26 }).map((_, i) => ({
    key: i,
    char: PARTICLES[i % PARTICLES.length],
    left: `${Math.random() * 100}%`,
    dur: `${1.8 + Math.random() * 1.6}s`,
    delay: `${Math.random() * 0.7}s`,
    size: `${20 + Math.random() * 18}px`,
  }));
  return (
    <div className="sq-overlay" onClick={onClose}>
      {rain.map((r) => (
        <span
          key={r.key}
          className="sq-rainpiece"
          style={{ left: r.left, animationDuration: r.dur, animationDelay: r.delay, fontSize: r.size }}
        >
          {r.char}
        </span>
      ))}
      <div className="sq-overlay-card" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 70 }} className="sq-bob">🏆</div>
        <h2 className="sq-h" style={{ fontSize: 30, color: color, margin: "6px 0 4px" }}>Perfect Score!</h2>
        <p style={{ fontSize: 18, fontWeight: 700, color: "#4a3f5e", margin: "0 0 6px" }}>
          You got every {subject} question right! 🎉
        </p>
        <p style={{ color: "#7a6f8c", margin: "0 0 18px" }}>You're a superstar. Keep it up!</p>
        <button style={{ ...btnPrimary, background: color, marginTop: 0 }} onClick={onClose}>
          Yay! Continue ✨
        </button>
      </div>
    </div>
  );
}

/* =============================== REWARD GAME ===========================
   Shown when a child has answered every question correctly AND finished all of
   today's chores. The game is chosen by grade. Games are self-contained (no
   external assets) so they work offline and inside an installed PWA.        */

const GAME_EMOJIS = ["🐶", "🐱", "🦊", "🐼", "🦁", "🐸", "🐵", "🦄", "🐙", "🦋", "🌟", "🍎", "🚀", "🎈", "⚽", "🍕"];

function RewardGameModal({ grade, kidName, onClose }) {
  const useMemory = grade <= 4; // younger kids: calm matching game; older: fast tap game
  return (
    <div className="sq-overlay" onClick={onClose}>
      <div className="sq-card" style={{ ...panel, maxWidth: 460, width: "100%", animation: "sq-zoom .5s cubic-bezier(.2,1.3,.4,1) both" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 className="sq-h" style={{ ...h2, margin: 0 }}>🎮 You earned a game!</h2>
          <button style={{ ...btnGhost, padding: "6px 12px" }} onClick={onClose}>✕</button>
        </div>
        <p style={{ color: "#7a6f8c", marginTop: 6 }}>
          Amazing work today, {kidName} — all questions correct and all chores done!
        </p>
        {useMemory ? <MemoryMatch grade={grade} /> : <StarCatcher grade={grade} />}
      </div>
    </div>
  );
}

/* ---- Memory Match (grades 1-4) ---- */
function MemoryMatch({ grade }) {
  const pairs = grade <= 2 ? 4 : 6; // 8 or 12 cards
  const cols = grade <= 2 ? 4 : 4;

  const makeDeck = () => {
    const chosen = [...GAME_EMOJIS].sort(() => Math.random() - 0.5).slice(0, pairs);
    return [...chosen, ...chosen]
      .map((e, i) => ({ id: i, emoji: e }))
      .sort(() => Math.random() - 0.5);
  };

  const [deck, setDeck] = useState(makeDeck);
  const [flipped, setFlipped] = useState([]); // indexes currently face-up (not yet matched)
  const [matched, setMatched] = useState([]); // matched indexes
  const [moves, setMoves] = useState(0);
  const [busy, setBusy] = useState(false);

  const won = matched.length === deck.length;

  const flip = (idx) => {
    if (busy || flipped.includes(idx) || matched.includes(idx)) return;
    const next = [...flipped, idx];
    setFlipped(next);
    if (next.length === 2) {
      setMoves((m) => m + 1);
      setBusy(true);
      const [a, b] = next;
      if (deck[a].emoji === deck[b].emoji) {
        setTimeout(() => {
          setMatched((m) => [...m, a, b]);
          setFlipped([]);
          setBusy(false);
        }, 450);
      } else {
        setTimeout(() => {
          setFlipped([]);
          setBusy(false);
        }, 850);
      }
    }
  };

  const reset = () => {
    setDeck(makeDeck());
    setFlipped([]);
    setMatched([]);
    setMoves(0);
    setBusy(false);
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontWeight: 800, fontFamily: FONT_DISPLAY, color: "#4a3f5e" }}>Find the matching pairs!</span>
        <span style={{ color: "#7a6f8c", fontWeight: 700 }}>Moves: {moves}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8 }}>
        {deck.map((card, idx) => {
          const show = flipped.includes(idx) || matched.includes(idx);
          return (
            <button
              key={card.id}
              onClick={() => flip(idx)}
              style={{
                aspectRatio: "1",
                fontSize: 30,
                borderRadius: 14,
                cursor: show ? "default" : "pointer",
                border: "none",
                background: matched.includes(idx) ? "#cdeccf" : show ? "#fff" : "#4a3f5e",
                boxShadow: show ? "inset 0 0 0 2px #e3dcec" : "0 3px 8px rgba(74,63,94,.2)",
                transition: "background .2s",
                display: "grid",
                placeItems: "center",
              }}
            >
              {show ? card.emoji : ""}
            </button>
          );
        })}
      </div>
      {won && (
        <div className="sq-card" style={{ textAlign: "center", marginTop: 14, background: "#eefaf0", padding: 16, borderRadius: 14 }}>
          <div style={{ fontSize: 34 }} className="sq-bob">🏆</div>
          <div style={{ fontWeight: 800, color: "#2fa84f", fontFamily: FONT_DISPLAY }}>You matched them all in {moves} moves!</div>
          <button style={{ ...btnPrimary, background: "#2fa84f" }} onClick={reset}>Play again</button>
        </div>
      )}
    </div>
  );
}

/* ---- Star Catcher (grades 5-12): tap targets before time runs out ---- */
function StarCatcher({ grade }) {
  const DURATION = 20; // seconds
  const spawnMs = grade <= 7 ? 900 : 700; // older = faster
  const lifeMs = grade <= 7 ? 1500 : 1150;

  const [phase, setPhase] = useState("ready"); // ready | playing | done
  const [score, setScore] = useState(0);
  const [time, setTime] = useState(DURATION);
  const [targets, setTargets] = useState([]); // {id, x, y, emoji}
  const idRef = React.useRef(0);

  // countdown
  useEffect(() => {
    if (phase !== "playing") return;
    if (time <= 0) {
      setPhase("done");
      setTargets([]);
      return;
    }
    const t = setTimeout(() => setTime((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, time]);

  // spawn targets
  useEffect(() => {
    if (phase !== "playing") return;
    const spawn = setInterval(() => {
      const id = ++idRef.current;
      const t = {
        id,
        x: 8 + Math.random() * 80, // %
        y: 8 + Math.random() * 78,
        emoji: pick(["⭐", "🌟", "✨", "💫", "🎈", "🍎"]),
      };
      setTargets((arr) => [...arr, t]);
      // auto-remove if not tapped
      setTimeout(() => setTargets((arr) => arr.filter((x) => x.id !== id)), lifeMs);
    }, spawnMs);
    return () => clearInterval(spawn);
  }, [phase, spawnMs, lifeMs]);

  const start = () => {
    setScore(0);
    setTime(DURATION);
    setTargets([]);
    setPhase("playing");
  };

  const tap = (id) => {
    setScore((s) => s + 1);
    setTargets((arr) => arr.filter((x) => x.id !== id));
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 800, fontFamily: FONT_DISPLAY, color: "#4a3f5e" }}>⭐ Score: {score}</span>
        <span style={{ color: "#7a6f8c", fontWeight: 700 }}>⏱ {time}s</span>
      </div>
      <div
        style={{
          position: "relative",
          height: 300,
          borderRadius: 16,
          background: "linear-gradient(160deg,#eef4fb,#f3eefb)",
          overflow: "hidden",
          border: "1.5px solid #e3dcec",
        }}
      >
        {phase !== "playing" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center", padding: 16 }}>
            {phase === "ready" ? (
              <div>
                <div style={{ fontSize: 40 }} className="sq-bob">⭐</div>
                <p style={{ color: "#4a3f5e", fontWeight: 700 }}>Tap as many stars as you can in {DURATION} seconds!</p>
                <button style={btnPrimary} onClick={start}>Start</button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 40 }} className="sq-bob">🏆</div>
                <div style={{ fontWeight: 800, color: "#2fa84f", fontFamily: FONT_DISPLAY, fontSize: 20 }}>You caught {score} stars!</div>
                <button style={{ ...btnPrimary, background: "#2fa84f" }} onClick={start}>Play again</button>
              </div>
            )}
          </div>
        )}
        {phase === "playing" &&
          targets.map((t) => (
            <button
              key={t.id}
              onClick={() => tap(t.id)}
              style={{
                position: "absolute",
                left: `${t.x}%`,
                top: `${t.y}%`,
                transform: "translate(-50%,-50%)",
                fontSize: 32,
                background: "none",
                border: "none",
                cursor: "pointer",
                animation: "sq-badge-pop .3s ease both",
                padding: 0,
                lineHeight: 1,
              }}
            >
              {t.emoji}
            </button>
          ))}
      </div>
    </div>
  );
}

function StudyView({ kid, day, saveDay, dayLoading }) {
  const [openSubject, setOpenSubject] = useState(SUBJECTS[0].key);
  const [grading, setGrading] = useState(null); // subject currently being graded
  const [banner, setBanner] = useState(null); // {subject, type, text}
  const [now, setNow] = useState(Date.now()); // live clock for countdowns
  const [aced, setAced] = useState(null); // {subject,color} -> show overlay
  const [celebrate, setCelebrate] = useState({}); // `${subject}:${i}` -> true (newly correct)
  const [helpLoading, setHelpLoading] = useState({}); // `${subject}:${i}` -> true while fetching help

  // tick every second so lock countdowns update and inputs re-enable
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (dayLoading)
    return (
      <div className="sq-card" style={{ ...panel, textAlign: "center", padding: "44px 22px" }}>
        <div className="sq-bob" style={{ fontSize: 44 }}>✏️</div>
        <h2 className="sq-h" style={{ ...h2, marginBottom: 4 }}>Getting today's questions ready…</h2>
        <p style={{ color: "#7a6f8c", margin: 0 }}>Putting together a fresh set just for {kid.name}.</p>
      </div>
    );

  if (!day) return null;

  const LOCK_MS = 30000; // 30-second cooldown after a wrong answer
  const HELP_AFTER = 3; // misses before teacher help is offered

  const subjMeta = (key) => SUBJECTS.find((s) => s.key === key);
  const lockRemaining = (it) => (it.lockUntil && it.lockUntil > now ? Math.ceil((it.lockUntil - now) / 1000) : 0);

  const update = (subject, idx, value) => {
    const it = day[subject][idx];
    if (lockRemaining(it) > 0) return; // locked: ignore edits
    const next = { ...day, [subject]: day[subject].map((x, i) => (i === idx ? { ...x, response: value } : x)) };
    saveDay(next);
  };

  // apply grading results to a subject, set 30s locks + count misses on wrong
  // answers, fire celebrations for newly-correct answers, pop overlay on 100%.
  const applyGrades = async (subject, gradedCore, color) => {
    const prev = day[subject];
    const nowTs = Date.now();
    const newlyCorrect = {};
    const graded = gradedCore.map((it, i) => {
      const wasCorrect = prev[i].correct === true;
      if (it.correct) {
        if (!wasCorrect) newlyCorrect[`${subject}:${i}`] = true;
        return { ...it, lockUntil: 0 }; // correct clears any lock
      }
      // wrong -> count the miss (only when an actual answer was given) and lock
      const answered = (it.response || "").trim().length > 0;
      const misses = (prev[i].misses || 0) + (answered ? 1 : 0);
      return { ...it, misses, lockUntil: nowTs + LOCK_MS };
    });
    await saveDay({ ...day, [subject]: graded });

    if (Object.keys(newlyCorrect).length) {
      setCelebrate((c) => ({ ...c, ...newlyCorrect }));
      setTimeout(() => {
        setCelebrate((c) => {
          const copy = { ...c };
          Object.keys(newlyCorrect).forEach((k) => delete copy[k]);
          return copy;
        });
      }, 1200);
    }
    if (graded.every((g) => g.correct === true)) {
      setAced({ subject, color });
    }
  };

  // Ask the AI teacher to explain a question the child keeps missing.
  const requestHelp = async (subject, idx) => {
    const it = day[subject][idx];
    const key = `${subject}:${idx}`;
    setHelpLoading((h) => ({ ...h, [key]: true }));
    try {
      const help = await api.getHelp({
        subject,
        grade: kid.grade,
        question: it.q,
        expected: it.a,
        attempts: [it.response].filter(Boolean),
      });
      const text = help || "Let's look at this together: think about what the question is really asking, then give it another try. You've got this!";
      await saveDay({ ...day, [subject]: day[subject].map((x, i) => (i === idx ? { ...x, help: text } : x)) });
    } catch {
      await saveDay({
        ...day,
        [subject]: day[subject].map((x, i) => (i === idx ? { ...x, help: "I couldn't reach the teacher right now. Take a breath, re-read the question, and try once more — you can do it!" } : x)),
      });
    } finally {
      setHelpLoading((h) => {
        const copy = { ...h };
        delete copy[key];
        return copy;
      });
    }
  };

  const checkSubject = async (subject) => {
    const list = day[subject];
    const color = subjMeta(subject).color;

    // Math: always graded locally — exact, instant, no internet needed.
    if (subject === "Math") {
      const core = list.map((it) => ({ ...it, checked: true, correct: gradeAnswer(it), note: "" }));
      await applyGrades(subject, core, color);
      setBanner({ subject, type: "ok", text: "Math checked — answers must match exactly." });
      return;
    }

    // Written subjects: try AI grading over the internet, fall back to local.
    setBanner(null);
    setGrading(subject);
    try {
      const results = await gradeWrittenBatch(subject, kid.grade, list);
      const core = list.map((it, i) => ({
        ...it,
        checked: true,
        correct: results[i].correct,
        note: results[i].note || "",
        gradedBy: "ai",
      }));
      await applyGrades(subject, core, color);
      setBanner({ subject, type: "ok", text: "✨ Graded by AI — synonyms and close answers count." });
    } catch (e) {
      // graceful offline fallback
      const core = list.map((it) => ({
        ...it,
        checked: true,
        correct: gradeAnswer(it),
        note: "",
        gradedBy: "offline",
      }));
      await applyGrades(subject, core, color);
      setBanner({
        subject,
        type: "warn",
        text: "No internet for AI grading — checked offline by keywords instead. Reconnect for smarter grading.",
      });
    } finally {
      setGrading(null);
    }
  };

  const subjectScore = (subject) => {
    const list = day[subject];
    const done = list.filter((i) => i.checked).length;
    const right = list.filter((i) => i.correct === true).length;
    return { done, right, total: list.length };
  };

  const printSubject = (subject) => {
    window.__printSubject = subject;
    document.body.classList.add("printing-one");
    // Render a print-only sheet then call print
    openPrintWindow(kid, subject, day[subject]);
  };

  const printAll = () => openPrintWindow(kid, null, day);

  return (
    <div>
      <div className="sq-noprint" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <h2 className="sq-h" style={{ ...h2, margin: 0 }}>Today's Questions · {kid.name}</h2>
          <div style={{ color: "#7a6f8c", fontSize: 14 }}>{fmtDate(todayKey())} · Grade {kid.grade} · answer in your own words</div>
        </div>
        <button style={btnPrimary} onClick={printAll}>🖨️ Print all (one page per subject)</button>
      </div>

      {/* subject tabs */}
      <div className="sq-noprint" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {SUBJECTS.map((s) => {
          const sc = subjectScore(s.key);
          const active = openSubject === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setOpenSubject(s.key)}
              style={{
                ...chip,
                borderColor: active ? s.color : "#e3dcec",
                background: active ? s.color : "#fff",
                color: active ? "#fff" : "#4a3f5e",
              }}
            >
              {s.key} {sc.done > 0 && <strong>· {sc.right}/{sc.total}</strong>}
            </button>
          );
        })}
      </div>

      {/* active subject card */}
      {(() => {
        const s = subjMeta(openSubject);
        const list = day[openSubject];
        const sc = subjectScore(openSubject);
        return (
          <div className="sq-card" style={{ ...panel, borderTop: `5px solid ${s.color}` }}>
            <div className="sq-noprint" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <h3 className="sq-h" style={{ margin: 0, fontSize: 22, color: s.color }}>{s.key}</h3>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ ...btnGhost, borderColor: s.color, color: s.color }} onClick={() => printSubject(s.key)}>🖨️ Print this subject</button>
                <button
                  style={{ ...btnPrimary, background: s.color, opacity: grading === s.key ? 0.6 : 1, cursor: grading === s.key ? "wait" : "pointer" }}
                  disabled={grading === s.key}
                  onClick={() => checkSubject(s.key)}
                >
                  {grading === s.key ? "⏳ Checking…" : "✓ Check my answers"}
                </button>
              </div>
            </div>

            {banner && banner.subject === s.key && (
              <div
                style={{
                  margin: "12px 0 0",
                  padding: "10px 14px",
                  borderRadius: 12,
                  fontWeight: 700,
                  fontSize: 14,
                  background: banner.type === "warn" ? "#fef3e6" : "#eef6ff",
                  color: banner.type === "warn" ? "#b8702a" : "#3b6fae",
                }}
              >
                {banner.text}
              </div>
            )}

            {sc.done > 0 && (
              <div style={{ margin: "12px 0", padding: "10px 14px", borderRadius: 12, background: "#f6f3fb", fontWeight: 700, color: "#4a3f5e" }}>
                Score: {sc.right} / {sc.total} correct
              </div>
            )}

            <ol style={{ paddingLeft: 22, margin: "14px 0 0", lineHeight: 1.5 }}>
              {list.map((it, i) => {
                const remain = lockRemaining(it);
                const locked = remain > 0;
                const justRight = celebrate[`${openSubject}:${i}`];
                return (
                  <li key={i} style={{ marginBottom: 16 }}>
                    {it.category && (
                      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: subjMeta(openSubject).color, marginBottom: 2, opacity: 0.85 }}>
                        {it.category}
                      </div>
                    )}
                    <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{it.q}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <input
                        style={{
                          ...input,
                          margin: 0,
                          maxWidth: 360,
                          borderColor: it.checked ? (it.correct ? "#2fa84f" : "#e0506b") : "#e3dcec",
                          background: locked ? "#f3eef0" : it.checked ? (it.correct ? "#eefaf0" : "#fdeef1") : "#fff",
                          color: locked ? "#9a8fb0" : "inherit",
                          cursor: locked ? "not-allowed" : "text",
                        }}
                        value={it.response}
                        onChange={(e) => update(openSubject, i, e.target.value)}
                        placeholder="Type your answer"
                        disabled={locked}
                        readOnly={locked}
                      />
                      {it.checked && it.correct && <CorrectBadge seed={i} />}
                      {it.checked && !it.correct && !locked && (
                        <span style={{ fontWeight: 800, color: "#e0506b" }}>✗ Try again</span>
                      )}
                      {locked && (
                        <span style={{ fontWeight: 800, color: "#b8702a", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          🔒 Wait {remain}s
                        </span>
                      )}
                    </div>
                    {locked && (
                      <div className="sq-noprint" style={{ fontSize: 13, color: "#b8702a", marginTop: 4, fontWeight: 600 }}>
                        Take a moment to really think about your answer — you can try again in {remain} second{remain === 1 ? "" : "s"}.
                      </div>
                    )}
                    {it.checked && it.note && !locked && (
                      <div className="sq-noprint" style={{ fontSize: 13, color: it.correct ? "#2fa84f" : "#c77", marginTop: 4, fontWeight: 600 }}>
                        {it.note}
                      </div>
                    )}

                    {/* After several misses, offer teacher help */}
                    {it.checked && !it.correct && (it.misses || 0) >= HELP_AFTER && !it.help && (
                      <button
                        className="sq-noprint sq-help-btn"
                        disabled={!!helpLoading[`${openSubject}:${i}`]}
                        onClick={() => requestHelp(openSubject, i)}
                      >
                        {helpLoading[`${openSubject}:${i}`] ? "Asking the teacher…" : "🧑‍🏫 Help me with this"}
                      </button>
                    )}

                    {/* The teacher's explanation */}
                    {it.help && (
                      <div className="sq-noprint sq-help-box">
                        <div style={{ fontWeight: 800, fontFamily: FONT_DISPLAY, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 18 }}>🧑‍🏫</span> Teacher's help
                        </div>
                        <div style={{ lineHeight: 1.5 }}>{it.help}</div>
                      </div>
                    )}

                    {it.checked && !it.correct && !it.note && !locked && (it.misses || 0) < HELP_AFTER && (
                      <div className="sq-noprint" style={{ fontSize: 13, color: "#9a8fb0", marginTop: 4 }}>
                        Give it another try! After a few tries, a teacher can help.
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })()}

      {aced && <AcedOverlay subject={aced.subject} color={aced.color} onClose={() => setAced(null)} />}
    </div>
  );
}

/* print: open a new window with one page per subject */
function openPrintWindow(kid, onlySubject, day) {
  const subjects = onlySubject ? [onlySubject] : SUBJECTS.map((s) => s.key);
  const w = window.open("", "_blank");
  if (!w) {
    alert("Please allow pop-ups to print.");
    return;
  }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const pages = subjects
    .map((subj) => {
      const meta = SUBJECTS.find((s) => s.key === subj);
      const items = day[subj]
        .map(
          (it, i) =>
            `<li><div class="q">${i + 1}. ${esc(it.q)}</div><div class="ans"></div></li>`
        )
        .join("");
      return `<section class="page">
        <header style="border-bottom:4px solid ${meta.color}">
          <h1>${esc(subj)}</h1>
          <div class="sub">${esc(kid.name)} · Grade ${kid.grade} · ${fmtDate(todayKey())}</div>
        </header>
        <ol>${items}</ol>
      </section>`;
    })
    .join("");

  w.document.write(`<!doctype html><html><head><title>${esc(kid.name)} — Questions</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;700&family=Nunito:wght@600&display=swap');
    body{font-family:'Nunito',sans-serif;margin:0;color:#2b2438}
    .page{padding:40px 48px;page-break-after:always;min-height:100vh}
    header h1{font-family:'Fredoka',sans-serif;font-size:34px;margin:0 0 4px;padding-bottom:8px}
    .sub{color:#777;margin-bottom:18px;font-size:14px}
    ol{font-size:17px;line-height:1.4}
    li{margin-bottom:26px}
    .q{font-weight:700}
    .ans{border-bottom:1.5px solid #bbb;height:34px;margin-top:10px}
    @media print{.page{min-height:auto}}
  </style></head><body>${pages}
  <script>window.onload=function(){setTimeout(function(){window.print();},400);}</script>
  </body></html>`);
  w.document.close();
}

/* ============================ CHORES VIEW ============================ */
function ChoresView({ chores, choreLog, saveChoreLog }) {
  const setField = (choreId, field, value) => {
    const entry = { ...(choreLog[choreId] || {}), [field]: value };
    saveChoreLog({ ...choreLog, [choreId]: entry });
  };

  const todays = chores.filter(choreAppliesToday);

  if (!chores.length)
    return (
      <div className="sq-card" style={panel}>
        <h2 className="sq-h" style={h2}>No chores yet</h2>
        <p style={{ color: "#7a6f8c" }}>A parent can add chores from the parent panel.</p>
      </div>
    );

  if (!todays.length)
    return (
      <div className="sq-card" style={{ ...panel, textAlign: "center" }}>
        <div style={{ fontSize: 40 }}>🎈</div>
        <h2 className="sq-h" style={h2}>No chores today!</h2>
        <p style={{ color: "#7a6f8c" }}>Enjoy your {WEEKDAYS[todayDow()]}. Check back another day.</p>
      </div>
    );

  return (
    <div>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Today's Chores</h2>
      <div style={{ color: "#7a6f8c", marginBottom: 16, fontSize: 14 }}>{fmtDate(todayKey())} · fill these in as you go</div>
      {todays.map((c) => {
        const e = choreLog[c.id] || {};
        return (
          <div className="sq-card" key={c.id} style={{ ...panel, marginBottom: 14 }}>
            <h3 className="sq-h" style={{ margin: "0 0 12px", fontSize: 20 }}>{c.title}</h3>

            <div style={{ marginBottom: 14 }}>
              <div style={qLabel}>1. Did you complete this task?</div>
              <Segmented
                value={e.completed}
                options={[["yes", "✅ Yes"], ["partly", "🟡 Partly"], ["no", "❌ Not yet"]]}
                onChange={(v) => setField(c.id, "completed", v)}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={qLabel}>2. Was there anything you were not able to do?</div>
              <textarea
                style={{ ...input, minHeight: 64, resize: "vertical" }}
                value={e.blockers || ""}
                onChange={(ev) => setField(c.id, "blockers", ev.target.value)}
                placeholder="Type here, or leave blank if all done"
              />
            </div>

            <div>
              <div style={qLabel}>3. Did you do a really good job?</div>
              <Segmented
                value={e.goodJob}
                options={[["great", "🌟 Yes, great job!"], ["ok", "🙂 It was okay"], ["next", "💪 I'll do better next time"]]}
                onChange={(v) => setField(c.id, "goodJob", v)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map(([val, label]) => (
        <button
          key={val}
          onClick={() => onChange(val)}
          style={{
            ...chip,
            background: value === val ? "#4a3f5e" : "#fff",
            color: value === val ? "#fff" : "#4a3f5e",
            borderColor: value === val ? "#4a3f5e" : "#e3dcec",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* =========================== CALENDAR VIEW =========================== */
function CalendarView({ kid, mode, setMode, date }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [data, setData] = useState({}); // dateKey -> summary

  useEffect(() => {
    (async () => {
      const days = daysInMonth(cursor.y, cursor.m);
      const map = {};
      for (let dn = 1; dn <= days; dn++) {
        const key = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(dn).padStart(2, "0")}`;
        if (mode === "study") {
          const d = await store.get(`daily:${kid.id}:${key}`);
          if (d) {
            let right = 0, total = 0, checked = 0;
            for (const subj of SUBJECTS.map((s) => s.key)) {
              (d[subj] || []).forEach((it) => {
                total++;
                if (it.checked) checked++;
                if (it.correct === true) right++;
              });
            }
            map[key] = { right, total, checked };
          }
        } else {
          const log = await store.get(`chore-log:${kid.id}:${key}`);
          if (log) {
            const vals = Object.values(log);
            const done = vals.filter((v) => v.completed === "yes").length;
            const partly = vals.filter((v) => v.completed === "partly").length;
            map[key] = { done, partly, count: vals.length };
          }
        }
      }
      setData(map);
    })();
  }, [cursor, mode, kid.id]);

  const days = daysInMonth(cursor.y, cursor.m);
  const firstDow = new Date(cursor.y, cursor.m, 1).getDay();
  const monthName = new Date(cursor.y, cursor.m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const move = (delta) => {
    let m = cursor.m + delta, y = cursor.y;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setCursor({ y, m });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <h2 className="sq-h" style={{ ...h2, margin: 0 }}>{kid.name}'s Progress</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...chip, background: mode === "study" ? "#4a3f5e" : "#fff", color: mode === "study" ? "#fff" : "#4a3f5e" }} onClick={() => setMode("study")}>📚 Questions</button>
          <button style={{ ...chip, background: mode === "chores" ? "#4a3f5e" : "#fff", color: mode === "chores" ? "#fff" : "#4a3f5e" }} onClick={() => setMode("chores")}>🧹 Chores</button>
        </div>
      </div>

      <div className="sq-card" style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <button style={btnGhost} onClick={() => move(-1)}>←</button>
          <div className="sq-h" style={{ fontSize: 20, fontWeight: 700 }}>{monthName}</div>
          <button style={btnGhost} onClick={() => move(1)}>→</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6, fontSize: 12, color: "#9a8fb0", fontWeight: 700, textAlign: "center", marginBottom: 4 }}>
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d}>{d}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6 }}>
          {Array.from({ length: firstDow }).map((_, i) => <div key={"e" + i} />)}
          {Array.from({ length: days }).map((_, i) => {
            const dn = i + 1;
            const key = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(dn).padStart(2, "0")}`;
            const info = data[key];
            const isToday = key === date;
            let bg = "#f6f3fb", label = "", ring = isToday ? "2px solid #4a3f5e" : "1px solid #ece7f3";
            if (info) {
              if (mode === "study" && info.checked > 0) {
                const pct = info.total ? info.right / info.total : 0;
                bg = pct >= 0.8 ? "#cdeccf" : pct >= 0.5 ? "#fdebc0" : "#f8d4da";
                label = `${info.right}/${info.total}`;
              } else if (mode === "study") {
                bg = "#e7e1f1"; label = "•";
              } else if (mode === "chores") {
                const pct = info.count ? info.done / info.count : 0;
                bg = pct >= 0.8 ? "#cdeccf" : pct >= 0.4 ? "#fdebc0" : "#f8d4da";
                label = `${info.done}/${info.count}`;
              }
            }
            return (
              <div key={key} style={{ aspectRatio: "1", borderRadius: 12, background: bg, border: ring, padding: 6, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#6a5f7e" }}>{dn}</div>
                {label && <div style={{ fontSize: 13, fontWeight: 800, textAlign: "center", color: "#3b3350" }}>{label}</div>}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap", fontSize: 13, color: "#7a6f8c" }}>
          <Legend c="#cdeccf" t="Great (80%+)" />
          <Legend c="#fdebc0" t="Okay (mid)" />
          <Legend c="#f8d4da" t="Needs work" />
          <Legend c="#e7e1f1" t="Started" />
        </div>
      </div>
    </div>
  );
}

function Legend({ c, t }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 14, height: 14, borderRadius: 4, background: c, display: "inline-block" }} /> {t}
    </span>
  );
}

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/* ============================ PARENT PANEL ============================ */
function ParentPanel({ parent, setParent, kids, refreshKids, activeKid, setActiveKid, date }) {
  const [unlocked, setUnlocked] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState("kids"); // kids | answers | chores | password

  const tryUnlock = async () => {
    setErr("");
    setBusy(true);
    const ok = await api.verifyPassword(pw);
    setBusy(false);
    if (ok) {
      setUnlocked(true);
      setPw("");
    } else {
      setErr("Incorrect password.");
    }
  };

  if (!unlocked) {
    return (
      <div className="sq-card" style={{ ...panel, maxWidth: 420, margin: "0 auto" }}>
        <div style={{ fontSize: 34, textAlign: "center" }}>🔒</div>
        <h2 className="sq-h" style={{ ...h2, textAlign: "center" }}>Parent Area</h2>
        <p style={{ color: "#7a6f8c", textAlign: "center", marginTop: -6 }}>
          Re-enter your account password to manage kids and view answer keys.
        </p>
        <input style={input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Account password" onKeyDown={(e) => e.key === "Enter" && tryUnlock()} />
        {err && <div style={errBox}>{err}</div>}
        <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={tryUnlock}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </div>
    );
  }

  const sections = [
    ["kids", "👧 Kids & Grades"],
    ["categories", "🎯 Categories"],
    ["chores", "🧹 Chores Setup"],
    ["answers", "🔑 Answer Keys"],
    ["family", "👨‍👩‍👧 Family"],
    ["account", "⚙️ Account"],
    ...(parent && parent.isAdmin ? [["admin", "🛡️ Admin"]] : []),
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {sections.map(([k, l]) => (
          <button key={k} onClick={() => setSection(k)} style={{ ...chip, background: section === k ? "#4a3f5e" : "#fff", color: section === k ? "#fff" : "#4a3f5e", borderColor: section === k ? "#4a3f5e" : "#e3dcec" }}>{l}</button>
        ))}
      </div>

      {section === "kids" && <KidsManager kids={kids} refreshKids={refreshKids} activeKid={activeKid} setActiveKid={setActiveKid} />}
      {section === "categories" && <CategoriesManager kids={kids} refreshKids={refreshKids} activeKid={activeKid} setActiveKid={setActiveKid} />}
      {section === "chores" && <ChoresManager kids={kids} activeKid={activeKid} setActiveKid={setActiveKid} />}
      {section === "answers" && <AnswerKey kids={kids} date={date} />}
      {section === "family" && <FamilyManager />}
      {section === "account" && <AccountManager parent={parent} setParent={setParent} />}
      {section === "admin" && parent && parent.isAdmin && <AdminPanel meUsername={parent.username} />}
    </div>
  );
}

/* ------------------------------ family manager -------------------------- */
function FamilyManager() {
  const [info, setInfo] = useState(null); // { code, members }
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setErr("");
    try {
      setInfo(await api.familyInfo());
    } catch (e) {
      setErr(e.message || "Could not load family info.");
      setInfo({ code: "", members: [] });
    }
  };
  useEffect(() => {
    load();
  }, []);

  const copy = async () => {
    if (!info || !info.code) return;
    try {
      await navigator.clipboard.writeText(info.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; the code is shown on screen anyway */
    }
  };

  const regen = async () => {
    if (!confirm("Generate a new family code? The old code will stop working, so anyone you shared it with can't use it to join anymore.")) return;
    setBusy(true);
    try {
      const code = await api.familyRegenCode();
      setInfo((i) => ({ ...(i || { members: [] }), code }));
    } catch (e) {
      setErr(e.message || "Could not regenerate code.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Your Family</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>
        Everyone in your family shares the same kids and progress. Invite another parent by sharing this code —
        they create their own login and pick "Join an existing family" when signing up.
      </p>
      {err && <div style={errBox}>{err}</div>}

      <div style={{ marginTop: 6 }}>
        <div style={lbl}>Family invite code</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <code style={{ fontSize: 20, fontWeight: 800, letterSpacing: ".08em", background: "#f6f3fb", padding: "10px 16px", borderRadius: 12, color: "#4a3f5e", fontFamily: FONT_DISPLAY }}>
            {info ? info.code || "—" : "…"}
          </code>
          <button style={btnGhost} onClick={copy} disabled={!info || !info.code}>{copied ? "✓ Copied" : "📋 Copy"}</button>
          <button style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }} onClick={regen} disabled={busy}>
            {busy ? "…" : "↻ New code"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#9a8fb0", marginTop: 6 }}>Treat this like a password — only share it with people who should see your kids.</div>
      </div>

      <h3 className="sq-h" style={{ fontSize: 18, marginTop: 22, marginBottom: 8 }}>Parents in this family</h3>
      {!info ? (
        <p style={{ color: "#7a6f8c" }}>Loading…</p>
      ) : info.members.length === 0 ? (
        <p style={{ color: "#7a6f8c" }}>Just you so far.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {info.members.map((m) => (
            <div key={m.username} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#f6f3fb", borderRadius: 10 }}>
              <span style={{ fontWeight: 800, fontFamily: FONT_DISPLAY }}>{m.username}</span>
              {m.isYou && <span style={{ fontSize: 12, color: "#2fa84f", fontWeight: 800 }}>· you</span>}
              {m.isAdmin && <span style={{ fontSize: 12, color: "#9b4dca", fontWeight: 800 }}>· admin</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ account manager ------------------------- */
function AccountManager({ parent, setParent }) {
  // username
  const [username, setUsername] = useState(parent.username);
  const [uMsg, setUMsg] = useState("");
  const [uErr, setUErr] = useState("");
  const [uBusy, setUBusy] = useState(false);
  // password
  const [cur, setCur] = useState("");
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [pMsg, setPMsg] = useState("");
  const [pErr, setPErr] = useState("");
  const [pBusy, setPBusy] = useState(false);

  const isAdmin = !!parent.isAdmin;

  const saveUsername = async () => {
    setUMsg("");
    setUErr("");
    if (username.trim() === parent.username) return setUErr("That's already your username.");
    setUBusy(true);
    try {
      const updated = await api.changeUsername(username.trim());
      setParent((p) => ({ ...p, username: updated }));
      setUMsg("Username updated.");
    } catch (e) {
      setUErr(e.message || "Could not change username.");
    } finally {
      setUBusy(false);
    }
  };

  const savePassword = async () => {
    setPMsg("");
    setPErr("");
    if (n1.length < 6) return setPErr("New password must be at least 6 characters.");
    if (n1 !== n2) return setPErr("New passwords don't match.");
    setPBusy(true);
    try {
      await api.changePassword(cur, n1);
      setPMsg("Password updated.");
      setCur("");
      setN1("");
      setN2("");
    } catch (e) {
      setPErr(e.message || "Could not change password.");
    } finally {
      setPBusy(false);
    }
  };

  return (
    <div>
      <div className="sq-card" style={{ ...panel, maxWidth: 460 }}>
        <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Username</h2>
        {isAdmin ? (
          <p style={{ color: "#7a6f8c" }}>
            You're signed in as the <strong>admin</strong> account. The admin username can't be changed.
          </p>
        ) : (
          <>
            <input style={input} value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoCorrect="off" />
            {uErr && <div style={errBox}>{uErr}</div>}
            {uMsg && <div style={{ ...errBox, background: "#eefaf0", color: "#2fa84f" }}>{uMsg}</div>}
            <button style={{ ...btnPrimary, opacity: uBusy ? 0.6 : 1 }} disabled={uBusy} onClick={saveUsername}>
              {uBusy ? "Saving…" : "Save username"}
            </button>
          </>
        )}
      </div>

      <div className="sq-card" style={{ ...panel, maxWidth: 460 }}>
        <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Change Password</h2>
        <input style={input} type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} />
        <input style={input} type="password" placeholder="New password" value={n1} onChange={(e) => setN1(e.target.value)} />
        <input style={input} type="password" placeholder="Confirm new password" value={n2} onChange={(e) => setN2(e.target.value)} />
        {pErr && <div style={errBox}>{pErr}</div>}
        {pMsg && <div style={{ ...errBox, background: "#eefaf0", color: "#2fa84f" }}>{pMsg}</div>}
        <button style={{ ...btnPrimary, opacity: pBusy ? 0.6 : 1 }} disabled={pBusy} onClick={savePassword}>
          {pBusy ? "Updating…" : "Update password"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ admin panel ----------------------------- */
function AdminPanel({ meUsername }) {
  const [users, setUsers] = useState(null);
  const [err, setErr] = useState("");
  const [resetFor, setResetFor] = useState(null); // username being reset
  const [newPw, setNewPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = async () => {
    setErr("");
    try {
      setUsers(await api.adminListUsers());
    } catch (e) {
      setErr(e.message || "Could not load accounts.");
      setUsers([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const doReset = async (username) => {
    setMsg("");
    setErr("");
    if (newPw.length < 6) return setErr("New password must be at least 6 characters.");
    setBusy(true);
    try {
      await api.adminResetPassword(username, newPw);
      setMsg(`Password reset for "${username}". Share the new password with them; they can change it after logging in.`);
      setResetFor(null);
      setNewPw("");
    } catch (e) {
      setErr(e.message || "Could not reset password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>🛡️ Admin · Accounts</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>
        Reset a parent's password if they're locked out. You can't see existing passwords — only set a new one.
      </p>
      {err && <div style={errBox}>{err}</div>}
      {msg && <div style={{ ...errBox, background: "#eefaf0", color: "#2fa84f" }}>{msg}</div>}

      {users === null ? (
        <p style={{ color: "#7a6f8c" }}>Loading accounts…</p>
      ) : users.length === 0 ? (
        <p style={{ color: "#7a6f8c" }}>No accounts yet.</p>
      ) : (
        users.map((u) => (
          <div key={u.username} style={{ padding: "12px 0", borderBottom: "1px solid #f0ecf6" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 800, fontFamily: FONT_DISPLAY }}>
                {u.username}
                {u.isAdmin && <span style={{ marginLeft: 6, fontSize: 12, color: "#9b4dca", fontWeight: 800 }}>· ADMIN</span>}
              </span>
              <span style={{ color: "#9a8fb0", fontSize: 13 }}>
                {u.kidCount} kid{u.kidCount === 1 ? "" : "s"}
              </span>
              <div style={{ flex: 1 }} />
              {resetFor === u.username ? null : (
                <button style={btnGhost} onClick={() => { setResetFor(u.username); setNewPw(""); setMsg(""); setErr(""); }}>
                  Reset password
                </button>
              )}
            </div>
            {resetFor === u.username && (
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  style={{ ...input, margin: 0, maxWidth: 240 }}
                  type="text"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="New password (min 6)"
                  onKeyDown={(e) => e.key === "Enter" && doReset(u.username)}
                  autoFocus
                />
                <button style={{ ...btnPrimary, marginTop: 0, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => doReset(u.username)}>
                  {busy ? "Saving…" : "Set password"}
                </button>
                <button style={btnGhost} onClick={() => { setResetFor(null); setNewPw(""); }}>Cancel</button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/* -------------------------- categories manager -------------------------- */
function CategoriesManager({ kids, refreshKids, activeKid, setActiveKid }) {
  const kid = kids.find((k) => k.id === activeKid) || kids[0] || null;

  // local editable copy of this kid's category prefs
  const [selected, setSelected] = useState({}); // { subject: [names] }
  const [custom, setCustom] = useState({}); // { subject: [names] }
  const [newCustom, setNewCustom] = useState({}); // { subject: "typing..." }
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const cats = (kid && kid.categories) || null;
    const sel = {};
    const cus = {};
    for (const s of SUBJECTS) {
      const builtIn = SUBJECT_CATEGORIES[s.key] || [];
      cus[s.key] = (cats && cats.custom && cats.custom[s.key]) || [];
      const stored = cats && cats.selected && cats.selected[s.key];
      // default: everything (built-in + any custom) selected
      sel[s.key] = Array.isArray(stored) ? stored.slice() : [...builtIn, ...cus[s.key]];
    }
    setSelected(sel);
    setCustom(cus);
    setSaved(false);
  }, [kid && kid.id, kid && kid.categories]);

  if (!kids.length) return <div className="sq-card" style={panel}><p style={{ color: "#7a6f8c" }}>Add a child first.</p></div>;

  const toggle = (subject, name) => {
    setSaved(false);
    setSelected((s) => {
      const cur = new Set(s[subject] || []);
      cur.has(name) ? cur.delete(name) : cur.add(name);
      return { ...s, [subject]: [...cur] };
    });
  };

  const addCustom = (subject) => {
    const name = (newCustom[subject] || "").trim().slice(0, 40);
    if (!name) return;
    if ((custom[subject] || []).includes(name) || (SUBJECT_CATEGORIES[subject] || []).includes(name)) {
      setNewCustom((n) => ({ ...n, [subject]: "" }));
      return;
    }
    setSaved(false);
    setCustom((c) => ({ ...c, [subject]: [...(c[subject] || []), name] }));
    setSelected((s) => ({ ...s, [subject]: [...(s[subject] || []), name] })); // auto-select new
    setNewCustom((n) => ({ ...n, [subject]: "" }));
  };

  const removeCustom = (subject, name) => {
    setSaved(false);
    setCustom((c) => ({ ...c, [subject]: (c[subject] || []).filter((x) => x !== name) }));
    setSelected((s) => ({ ...s, [subject]: (s[subject] || []).filter((x) => x !== name) }));
  };

  const save = async () => {
    if (!kid) return;
    setBusy(true);
    try {
      const ks = await api.updateKid(kid.id, { categories: { selected, custom } });
      await refreshKids(ks);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Question Categories</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>
        Pick which topics to include in {kid ? kid.name + "'s" : "the"} questions each day. Changes apply to the next day's set.
      </p>
      <KidPicker kids={kids} activeKid={kid ? kid.id : null} setActiveKid={setActiveKid} />

      {SUBJECTS.map((s) => {
        const builtIn = SUBJECT_CATEGORIES[s.key] || [];
        const customCats = custom[s.key] || [];
        const all = [...builtIn, ...customCats];
        const sel = new Set(selected[s.key] || []);
        const allowCustom = true; // custom topics now allowed for every subject, including Math
        return (
          <div key={s.key} style={{ padding: "14px 0", borderBottom: "1px solid #f0ecf6" }}>
            <h3 className="sq-h" style={{ margin: "0 0 10px", fontSize: 18, color: s.color }}>{s.key}</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {all.map((name) => {
                const on = sel.has(name);
                const isCustom = customCats.includes(name);
                return (
                  <span key={name} style={{ display: "inline-flex", alignItems: "center" }}>
                    <button
                      onClick={() => toggle(s.key, name)}
                      style={{
                        ...chip,
                        background: on ? s.color : "#fff",
                        color: on ? "#fff" : "#4a3f5e",
                        borderColor: on ? s.color : "#e3dcec",
                      }}
                    >
                      {on ? "✓ " : ""}{name}
                      {isCustom ? " ✦" : ""}
                    </button>
                    {isCustom && (
                      <button
                        title="Remove custom category"
                        onClick={() => removeCustom(s.key, name)}
                        style={{ marginLeft: 2, marginRight: 4, border: "none", background: "none", color: "#e0506b", cursor: "pointer", fontWeight: 800 }}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            {allowCustom ? (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input
                  style={{ ...input, margin: 0, maxWidth: 260 }}
                  value={newCustom[s.key] || ""}
                  onChange={(e) => setNewCustom((n) => ({ ...n, [s.key]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && addCustom(s.key)}
                  placeholder={`Add your own ${s.key} topic`}
                />
                <button style={{ ...btnGhost, borderColor: s.color, color: s.color }} onClick={() => addCustom(s.key)}>+ Add</button>
              </div>
            ) : null}
            {s.key === "Math" && (custom[s.key] || []).length > 0 && (
              <div style={{ fontSize: 12, color: "#9a8fb0", marginTop: 6 }}>
                Built-in Math types stay exact. Custom Math topics (✦) are written by the AI teacher.
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
        <button style={{ ...btnPrimary, marginTop: 0, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save categories"}
        </button>
        {saved && <span style={{ color: "#2fa84f", fontWeight: 700 }}>✓ Saved</span>}
      </div>
      <p style={{ fontSize: 12, color: "#9a8fb0", marginTop: 12 }}>
        ✦ Custom topics are created fresh by the AI teacher and need an internet connection. If a child has no
        categories selected for a subject, all topics are used.
      </p>
    </div>
  );
}

function KidsManager({ kids, refreshKids, activeKid, setActiveKid }) {
  const [name, setName] = useState("");
  const [grade, setGrade] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // local buffer for name edits so we only save on blur (not every keystroke)
  const [names, setNames] = useState({});

  useEffect(() => {
    const map = {};
    kids.forEach((k) => (map[k.id] = k.name));
    setNames(map);
  }, [kids]);

  const add = async () => {
    if (!name.trim()) return;
    setErr("");
    setBusy(true);
    try {
      const ks = await api.createKid(name.trim(), Number(grade));
      setName("");
      const created = ks[ks.length - 1];
      await refreshKids(ks); // use the authoritative list from the create call
      if (created) setActiveKid(created.id);
    } catch (e) {
      setErr(e.message || "Could not add child.");
    } finally {
      setBusy(false);
    }
  };

  const commitName = async (id) => {
    const newName = (names[id] || "").trim();
    const current = kids.find((k) => k.id === id);
    if (!current || !newName || newName === current.name) return;
    try {
      const ks = await api.updateKid(id, { name: newName });
      await refreshKids(ks);
    } catch {
      /* leave UI; will reset on next refresh */
    }
  };

  const updateGrade = async (id, g) => {
    try {
      const ks = await api.updateKid(id, { grade: Number(g) });
      await refreshKids(ks);
    } catch {}
  };

  const remove = async (id) => {
    if (!confirm("Remove this child and all of their saved questions and chores? This cannot be undone.")) return;
    try {
      const ks = await api.deleteKid(id);
      await refreshKids(ks);
      if (activeKid === id) setActiveKid(ks[0]?.id || null);
    } catch {}
  };

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Kids & Grade Levels</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>Grade level sets the difficulty of generated questions. Only you can see these kids.</p>

      {kids.map((k) => (
        <div key={k.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "12px 0", borderBottom: "1px solid #f0ecf6" }}>
          <input
            style={{ ...input, margin: 0, maxWidth: 200 }}
            value={names[k.id] ?? k.name}
            onChange={(e) => setNames((m) => ({ ...m, [k.id]: e.target.value }))}
            onBlur={() => commitName(k.id)}
          />
          <label style={{ color: "#7a6f8c", fontWeight: 700 }}>Grade</label>
          <select style={{ ...input, margin: 0, maxWidth: 90 }} value={k.grade} onChange={(e) => updateGrade(k.id, e.target.value)}>
            {Array.from({ length: 12 }).map((_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </select>
          <button style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }} onClick={() => remove(k.id)}>Remove</button>
        </div>
      ))}

      <div style={{ marginTop: 18, padding: 16, background: "#f6f3fb", borderRadius: 14 }}>
        <h3 className="sq-h" style={{ margin: "0 0 10px", fontSize: 18 }}>Add a child</h3>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input style={{ ...input, margin: 0, maxWidth: 220 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Child's name" onKeyDown={(e) => e.key === "Enter" && add()} />
          <label style={{ color: "#7a6f8c", fontWeight: 700 }}>Grade</label>
          <select style={{ ...input, margin: 0, maxWidth: 90 }} value={grade} onChange={(e) => setGrade(e.target.value)}>
            {Array.from({ length: 12 }).map((_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </select>
          <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={add}>{busy ? "Adding…" : "+ Add child"}</button>
        </div>
        {err && <div style={errBox}>{err}</div>}
      </div>
    </div>
  );
}

function ChoresManager({ kids, activeKid, setActiveKid }) {
  const [chores, setChores] = useState([]);
  const [title, setTitle] = useState("");

  useEffect(() => {
    (async () => {
      if (!activeKid) return;
      let ch = await store.get(`chores:${activeKid}`);
      if (ch == null) ch = DEFAULT_CHORES.map((c) => ({ id: uid(), title: c.title, days: c.days.slice() }));
      setChores(ch);
    })();
  }, [activeKid]);

  const save = async (next) => {
    setChores(next);
    await store.set(`chores:${activeKid}`, next);
  };
  const add = () => {
    if (!title.trim()) return;
    save([...chores, { id: uid(), title: title.trim(), days: ALL_DAYS.slice() }]);
    setTitle("");
  };
  const edit = (id, t) => save(chores.map((c) => (c.id === id ? { ...c, title: t } : c)));
  const remove = (id) => save(chores.filter((c) => c.id !== id));
  const toggleDay = (id, dow) =>
    save(
      chores.map((c) => {
        if (c.id !== id) return c;
        const cur = Array.isArray(c.days) ? c.days : ALL_DAYS.slice();
        const set = new Set(cur);
        set.has(dow) ? set.delete(dow) : set.add(dow);
        return { ...c, days: [...set].sort((a, b) => a - b) };
      })
    );
  const setDaysPreset = (id, preset) => save(chores.map((c) => (c.id === id ? { ...c, days: preset.slice() } : c)));

  if (!kids.length) return <div className="sq-card" style={panel}><p style={{color:"#7a6f8c"}}>Add a child first.</p></div>;

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Chores Setup</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>Pick which days each chore should appear. Kids only see a chore on its days.</p>
      <KidPicker kids={kids} activeKid={activeKid} setActiveKid={setActiveKid} />
      {chores.map((c) => {
        const days = Array.isArray(c.days) ? c.days : ALL_DAYS;
        return (
          <div key={c.id} style={{ padding: "12px 0", borderBottom: "1px solid #f0ecf6" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input style={{ ...input, margin: 0 }} value={c.title} onChange={(e) => edit(c.id, e.target.value)} />
              <button style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }} onClick={() => remove(c.id)}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              {WEEKDAYS.map((label, dow) => {
                const on = days.includes(dow);
                return (
                  <button
                    key={dow}
                    onClick={() => toggleDay(c.id, dow)}
                    title={label}
                    style={{
                      width: 38, height: 34, borderRadius: 9, cursor: "pointer", fontWeight: 800, fontSize: 12,
                      fontFamily: FONT_DISPLAY,
                      border: `1.5px solid ${on ? "#4a3f5e" : "#e3dcec"}`,
                      background: on ? "#4a3f5e" : "#fff",
                      color: on ? "#fff" : "#9a8fb0",
                    }}
                  >
                    {label[0]}
                  </button>
                );
              })}
              <span style={{ width: 8 }} />
              <button style={{ ...miniLink }} onClick={() => setDaysPreset(c.id, ALL_DAYS)}>Every day</button>
              <button style={{ ...miniLink }} onClick={() => setDaysPreset(c.id, [1, 2, 3, 4, 5])}>Weekdays</button>
              <button style={{ ...miniLink }} onClick={() => setDaysPreset(c.id, [0, 6])}>Weekend</button>
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <input style={{ ...input, margin: 0 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New chore (e.g. Take out trash)" onKeyDown={(e) => e.key === "Enter" && add()} />
        <button style={btnPrimary} onClick={add}>+ Add</button>
      </div>
    </div>
  );
}

function AnswerKey({ kids, date }) {
  const [kidId, setKidId] = useState(kids[0]?.id || null);
  const [day, setDayData] = useState(null);
  const [openSubj, setOpenSubj] = useState(SUBJECTS[0].key);

  useEffect(() => {
    (async () => {
      if (!kidId) return;
      const d = await store.get(`daily:${kidId}:${date}`);
      setDayData(d);
    })();
  }, [kidId, date]);

  if (!kids.length) return <div className="sq-card" style={panel}><p style={{color:"#7a6f8c"}}>Add a child first.</p></div>;

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>🔑 Answer Key · {fmtDate(date)}</h2>
      <KidPicker kids={kids} activeKid={kidId} setActiveKid={setKidId} />
      {!day ? (
        <p style={{ color: "#7a6f8c" }}>No questions generated for this child today yet. They'll appear once the child opens their questions.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
            {SUBJECTS.map((s) => (
              <button key={s.key} onClick={() => setOpenSubj(s.key)} style={{ ...chip, background: openSubj === s.key ? s.color : "#fff", color: openSubj === s.key ? "#fff" : "#4a3f5e", borderColor: openSubj === s.key ? s.color : "#e3dcec" }}>{s.key}</button>
            ))}
          </div>
          <ol style={{ paddingLeft: 22, lineHeight: 1.6 }}>
            {day[openSubj].map((it, i) => (
              <li key={i} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700 }}>{it.q}</div>
                <div style={{ color: "#2fa84f", fontWeight: 800 }}>Answer: {it.a}</div>
                {it.checked && (
                  <div style={{ fontSize: 13, color: it.correct ? "#2fa84f" : "#e0506b" }}>
                    Child answered: "{it.response || "—"}" {it.correct ? "✓" : "✗"}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function KidPicker({ kids, activeKid, setActiveKid }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
      {kids.map((k) => (
        <button key={k.id} onClick={() => setActiveKid(k.id)} style={{ ...chip, background: activeKid === k.id ? "#4a3f5e" : "#fff", color: activeKid === k.id ? "#fff" : "#4a3f5e", borderColor: activeKid === k.id ? "#4a3f5e" : "#e3dcec" }}>{k.name} · G{k.grade}</button>
      ))}
    </div>
  );
}

/* =============================== STYLES OBJ =========================== */
const wrap = {
  maxWidth: 820,
  margin: "0 auto",
  padding: "20px 16px 0",
  minHeight: "100vh",
  background: "linear-gradient(160deg,#fbf8ff 0%,#f3eefb 60%,#eef4fb 100%)",
};
const panel = { background: "#fff", borderRadius: 20, padding: 22, boxShadow: "0 6px 24px rgba(74,63,94,.08)", marginBottom: 16 };
const h1 = { fontSize: 28, fontWeight: 700, color: "#4a3f5e" };
const h2 = { fontSize: 22, fontWeight: 700, color: "#4a3f5e" };
const lbl = { display: "block", fontWeight: 700, color: "#6a5f7e", margin: "14px 0 6px", fontSize: 14 };
const qLabel = { fontWeight: 700, color: "#4a3f5e", marginBottom: 8 };
const input = { width: "100%", padding: "12px 14px", borderRadius: 12, border: "1.5px solid #e3dcec", fontSize: 16, fontFamily: FONT_BODY, outline: "none", margin: "0 0 4px", background: "#fff" };
const btnPrimary = { marginTop: 14, padding: "12px 20px", borderRadius: 12, border: "none", background: "#4a3f5e", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: FONT_DISPLAY };
const btnGhost = { padding: "10px 16px", borderRadius: 12, border: "1.5px solid #d9d0e6", background: "#fff", color: "#6a5f7e", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: FONT_DISPLAY };
const chip = { padding: "9px 14px", borderRadius: 999, border: "1.5px solid #e3dcec", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: FONT_DISPLAY };
const miniLink = { background: "none", border: "none", color: "#6a5f7e", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT_DISPLAY, textDecoration: "underline", padding: "4px 2px" };
const tabBtn = { flex: 1, padding: "12px 8px", borderRadius: 14, border: "none", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: FONT_DISPLAY };
const errBox = { marginTop: 10, padding: "10px 14px", borderRadius: 10, background: "#fdeef1", color: "#e0506b", fontWeight: 700, fontSize: 14 };
