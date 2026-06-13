import React, { useState, useEffect, useCallback, useRef } from "react";
import { useAppUpdate, UpdateBanner, InstallButton } from "./appUpdate.jsx";

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

// Date key (YYYY-MM-DD) for `offset` days after a given key (default: today).
const dateKeyPlus = (offset, fromKey) => {
  const base = fromKey ? fromKey.split("-").map(Number) : null;
  const d = base ? new Date(base[0], base[1] - 1, base[2]) : new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

// A stable, friendly avatar (color + emoji + initial) per kid, so a child can
// recognize "their" profile at a glance. Derived from the kid id so it never
// changes for a given child.
const KID_COLORS = ["#e8743b", "#3b7de8", "#2fa84f", "#9b4dca", "#d4a017", "#e0506b", "#1f9d9d", "#7a5cd0"];
const KID_EMOJIS = ["🦊", "🐼", "🦄", "🐯", "🐵", "🐶", "🐱", "🐨", "🦁", "🐸", "🐙", "🦉", "🐢", "🐰", "🐧", "🐝"];
function kidHash(id) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function kidAvatar(kid) {
  const h = kidHash(kid && kid.id);
  const initial = (kid && kid.name ? kid.name.trim()[0] : "?") || "?";
  return {
    // prefer the kid's chosen color/icon; fall back to a stable default
    color: (kid && kid.color) || KID_COLORS[h % KID_COLORS.length],
    emoji: (kid && kid.icon) || KID_EMOJIS[h % KID_EMOJIS.length],
    initial: initial.toUpperCase(),
  };
}

// Icon + color choices for the kid avatar picker. Emoji only (no copyrighted
// character artwork). Grouped loosely so kids can find a favorite.
const AVATAR_ICONS = [
  "🦊", "🐼", "🦄", "🐯", "🐵", "🐶", "🐱", "🐰", "🐸", "🐲", "🦖", "🦕",
  "🦁", "🐨", "🐧", "🐙", "🦉", "🐝", "🦋", "🐢", "🐠", "🐬", "🦈", "🐳",
  "🦸", "🦹", "🥷", "🧙", "🧚", "🧜", "🤖", "👾", "👽", "🤡", "🎃", "👻",
  "🚀", "🚒", "🚌", "✈️", "🚁", "🏎️", "🚂", "⛵", "🛸", "🛹", "🎮", "⚽",
  "🏀", "🏈", "⚾", "🎾", "🥎", "🏐", "🎲", "🎯", "🪀", "🎸", "🥁", "🎺",
  "⭐", "🌈", "🔥", "⚡", "❄️", "🌸", "🌺", "🌻", "🍀", "🦴", "🍕", "🍦",
];
const AVATAR_COLORS = [
  "#e8743b", "#3b7de8", "#2fa84f", "#9b4dca", "#d4a017", "#e0506b",
  "#1f9d9d", "#7a5cd0", "#e84393", "#0984e3", "#00b894", "#fdcb6e",
  "#6c5ce7", "#d63031", "#e17055", "#2d3436",
];

// Remove ?verify= / ?family= / ?invite= from the address bar after we've
// consumed them, so a refresh or shared screenshot doesn't re-trigger or leak.
const cleanUrl = () => {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const p of ["verify", "family", "invite", "reset"]) {
      if (url.searchParams.has(p)) {
        url.searchParams.delete(p);
        changed = true;
      }
    }
    if (changed) window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  } catch {}
};

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
   Data lives on the server (Netlify Function + Blobs). The browser keeps a
   signed token: either a PARENT token (full account) or a FAMILY token (the
   no-login "kids' link" — read/write kid data only).                        */

const TOKEN_KEY = "sq-token"; // parent session token
const FAMILY_TOKEN_KEY = "sq-family-token"; // kid-mode device token

const ls = (k) => {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
};
let parentToken = typeof window !== "undefined" ? ls(TOKEN_KEY) : null;
let familyToken = typeof window !== "undefined" ? ls(FAMILY_TOKEN_KEY) : null;

function setToken(t) {
  parentToken = t || null;
  try {
    if (t) window.localStorage.setItem(TOKEN_KEY, t);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
function setFamilyToken(t) {
  familyToken = t || null;
  try {
    if (t) window.localStorage.setItem(FAMILY_TOKEN_KEY, t);
    else window.localStorage.removeItem(FAMILY_TOKEN_KEY);
  } catch {}
}
function getToken() {
  return parentToken;
}
function getFamilyToken() {
  return familyToken;
}
// The active bearer token: a logged-in parent takes priority; otherwise the
// family (kid-mode) token if present.
function activeToken() {
  return parentToken || familyToken;
}

// low-level request to /api/<action>
async function apiRequest(action, body) {
  const res = await fetch(`/api/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(activeToken() ? { authorization: `Bearer ${activeToken()}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401) {
    // session invalid/expired -> sign out everywhere
    if (typeof window !== "undefined") window.dispatchEvent(new Event("sq-unauthorized"));
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data || {};
    throw err;
  }
  return data;
}

const api = {
  // Returns { pending, email, ... } — account must be verified by email.
  async signup(email, password, familyCode, familyName) {
    return apiRequest("signup", { email, password, familyCode, familyName });
  },
  // Returns the parent object on success; throws with err.data.unverified if not verified.
  async login(email, password) {
    const r = await apiRequest("login", { email, password });
    setToken(r.token);
    return r.parent;
  },
  async verifyEmail(token) {
    const r = await apiRequest("verify-email", { token });
    setToken(r.token);
    return r.parent;
  },
  async resendVerification(email) {
    return apiRequest("resend-verification", { email });
  },
  // Exchange a family code for a kid-mode token (the no-login link).
  async familyAccess(code) {
    const r = await apiRequest("family-access", { code });
    setFamilyToken(r.token);
    return true;
  },
  // Turn THIS device into the no-login kid device for the logged-in parent's
  // own family. Looks up the family code, then stores a long-lived family token
  // so future opens go straight to the family without a login.
  async enterKidModeForOwnFamily() {
    const info = await apiRequest("family-info");
    const code = info && info.code;
    if (!code) throw new Error("Could not find your family code.");
    const r = await apiRequest("family-access", { code });
    setFamilyToken(r.token);
    return true;
  },
  // Already-logged-in parent joins a family by invite code.
  async familyJoin(code) {
    return apiRequest("family-join", { code });
  },
  // Preview consequences of joining (so we can confirm before deleting old family).
  async familyJoinPreview(code) {
    return apiRequest("family-join-preview", { code });
  },
  logout() {
    setToken(null);
  },
  exitFamily() {
    setFamilyToken(null);
  },
  async me() {
    const r = await apiRequest("me");
    return r.parent;
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
  async changeEmail(email) {
    return apiRequest("change-email", { email });
  },
  async familyInfo() {
    return apiRequest("family-info");
  },
  async familyRename(name) {
    return apiRequest("family-rename", { name });
  },
  async notifySettings() {
    return apiRequest("notify-settings");
  },
  async saveNotifySettings(settings) {
    return apiRequest("notify-settings-save", settings);
  },
  async familyRegenCode() {
    const r = await apiRequest("family-regen-code");
    return r && r.code;
  },
  // Returns { kids, familyName }
  async listKids() {
    const r = await apiRequest("kids-list");
    return { kids: (r && r.kids) || [], familyName: (r && r.familyName) || "" };
  },
  async createKid(name, grade, extra) {
    const r = await apiRequest("kid-create", { name, grade, ...(extra || {}) });
    // Return both the authoritative created kid and the full list so callers
    // never have to guess which entry is the new one.
    return { kid: (r && r.kid) || null, kids: (r && r.kids) || [] };
  },
  async updateKid(id, patch) {
    const r = await apiRequest("kid-update", { id, ...patch });
    return (r && r.kids) || [];
  },
  // Kid-mode safe: change only the avatar icon/color.
  async setKidAvatar(id, icon, color) {
    const r = await apiRequest("kid-avatar", { id, icon, color });
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
  // Fire-and-forget completion email trigger (questions done / chores done).
  async notify(type, kidId, date) {
    return apiRequest("notify", { type, kidId, date });
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
  async adminResetPassword(email, newPassword) {
    return apiRequest("admin-reset-password", { email, newPassword });
  },
  async adminLogs(filters) {
    return apiRequest("admin-logs", filters || {});
  },
  async adminLogClear(olderThan) {
    return apiRequest("admin-log-clear", olderThan ? { olderThan } : {});
  },
  async adminCreateUser(email, familyId) {
    return apiRequest("admin-create-user", { email, familyId });
  },
  async adminDeleteUser(id) {
    return apiRequest("admin-delete-user", { id });
  },
  async adminSendReset(email) {
    return apiRequest("admin-send-reset", { email });
  },
  async adminCleanupFamilies() {
    return apiRequest("admin-cleanup-families");
  },
  async requestPasswordReset(email) {
    return apiRequest("request-password-reset", { email });
  },
  async resetPassword(token, newPassword) {
    const r = await apiRequest("reset-password", { token, newPassword });
    if (r && r.token) setToken(r.token);
    return r;
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
  // Batch fetch many keys in a single request. Returns { key: value|null }.
  async mget(keys) {
    try {
      const r = await apiRequest("data", { op: "mget", keys });
      return (r && r.values) || {};
    } catch {
      return {};
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
  Math: ["Addition", "Subtraction", "Multiplication", "Division", "Fractions", "Word Problems", "Exponents & Powers", "Algebra", "Geometry", "Bar Graphs", "Line Graphs", "Coordinate Plane", "Number Patterns"],
  "Reading & Writing": ["Vocabulary", "Synonyms & Antonyms", "Grammar", "Parts of Speech", "Spelling", "Literary Devices"],
  Science: ["Life Science", "Earth & Space", "Physical Science", "The Human Body", "Animals & Plants", "Weather"],
  History: ["U.S. History", "World History", "Ancient Civilizations", "Famous People", "Inventions"],
  Geography: ["Capitals", "Continents & Oceans", "Countries", "Physical Geography", "U.S. States"],
  Art: ["Color Theory", "Famous Artists", "Drawing Basics", "Art History", "Techniques"],
  Music: ["Instruments", "Rhythm & Beat", "Reading Music", "Famous Composers", "Music Theory"],
  Coding: ["Logic & Sequencing", "Loops", "Variables", "Conditionals", "Computer Basics"],
  Health: ["Nutrition", "The Human Body", "Hygiene", "Exercise & Fitness", "Safety"],
  Spanish: ["Greetings", "Colors", "Numbers", "Common Words", "Simple Phrases"],
};
// Math categories that work for a given grade (keeps young kids on basics)
function mathCategoriesForGrade(grade) {
  const all = SUBJECT_CATEGORIES.Math;
  if (grade <= 2) return ["Addition", "Subtraction", "Bar Graphs", "Number Patterns"];
  if (grade <= 5) return ["Addition", "Subtraction", "Multiplication", "Division", "Fractions", "Word Problems", "Geometry", "Bar Graphs", "Line Graphs", "Number Patterns"];
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
      q: `${a}/${d} + ${b}/${d} = ?  (write your answer as a fraction, for example 2/7)`,
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
  Geometry(g) {
    const r = rint(1, 3);
    if (r === 1) {
      // count sides of a polygon (with a drawing)
      const shapes = [
        { n: 3, name: "triangle" },
        { n: 4, name: "square" },
        { n: 5, name: "pentagon" },
        { n: 6, name: "hexagon" },
        { n: 8, name: "octagon" },
      ];
      const s = pick(g <= 3 ? shapes.slice(0, 3) : shapes);
      return { type: "math", q: `How many sides does this shape have?`, a: String(s.n), svg: svgPolygon(s.n) };
    }
    if (r === 2) {
      // rectangle area with labeled sides
      const w = rint(2, 12), hgt = rint(2, 9);
      return { type: "math", q: `What is the AREA of this rectangle? (length × width)`, a: String(w * hgt), svg: svgRectangle(w, hgt) };
    }
    // rectangle perimeter
    const w = rint(2, 12), hgt = rint(2, 9);
    return { type: "math", q: `What is the PERIMETER of this rectangle? (add all four sides)`, a: String(2 * (w + hgt)), svg: svgRectangle(w, hgt) };
  },
  "Bar Graphs"(g) {
    const labels = ["Mon", "Tue", "Wed", "Thu", "Fri"].slice(0, g <= 3 ? 4 : 5);
    const data = labels.map((l) => ({ label: l, value: rint(1, 10) }));
    const mode = pick(["read", "max", "min", "total"]);
    if (mode === "read") {
      const pickIdx = rint(0, data.length - 1);
      return { type: "math", q: `On the graph, what value is shown for ${data[pickIdx].label}?`, a: String(data[pickIdx].value), svg: svgBarChart(data) };
    }
    if (mode === "max") {
      const top = data.reduce((a, b) => (b.value > a.value ? b : a));
      return { type: "math", q: `Which day has the HIGHEST bar? (write the day)`, a: top.label, accept: [top.label, top.label.toLowerCase()], svg: svgBarChart(data) };
    }
    if (mode === "min") {
      const low = data.reduce((a, b) => (b.value < a.value ? b : a));
      return { type: "math", q: `Which day has the LOWEST bar? (write the day)`, a: low.label, accept: [low.label, low.label.toLowerCase()], svg: svgBarChart(data) };
    }
    const total = data.reduce((s, d) => s + d.value, 0);
    return { type: "math", q: `What is the TOTAL of all the bars added together?`, a: String(total), svg: svgBarChart(data) };
  },
  "Line Graphs"(g) {
    const labels = ["1", "2", "3", "4", "5"];
    const data = labels.map((l) => ({ label: l, value: rint(1, 10) }));
    const mode = pick(["read", "max"]);
    if (mode === "max") {
      const top = data.reduce((a, b) => (b.value > a.value ? b : a));
      return { type: "math", q: `At which x-value is the line the HIGHEST?`, a: top.label, svg: svgLineChart(data) };
    }
    const pickIdx = rint(0, data.length - 1);
    return { type: "math", q: `On the line graph, what is the value when x = ${data[pickIdx].label}?`, a: String(data[pickIdx].value), svg: svgLineChart(data) };
  },
  "Coordinate Plane"() {
    const x = rint(1, 5), y = rint(1, 5);
    const which = pick(["x", "y"]);
    return {
      type: "math",
      q: `What is the ${which}-coordinate of point A?`,
      a: String(which === "x" ? x : y),
      svg: svgCoordPoint(x, y),
    };
  },
  "Number Patterns"(g) {
    const start = rint(1, 9);
    const step = rint(2, g <= 3 ? 5 : 9);
    const kind = pick(["add", g <= 3 ? "add" : "mult"]);
    if (kind === "mult") {
      const seq = [start, start * step, start * step * step, start * step * step * step];
      return { type: "math", q: `What number comes next? ${seq.slice(0, 3).join(", ")}, ___`, a: String(seq[3]) };
    }
    const seq = [start, start + step, start + 2 * step, start + 3 * step, start + 4 * step];
    return { type: "math", q: `What number comes next? ${seq.slice(0, 4).join(", ")}, ___`, a: String(seq[4]) };
  },
};

/* ---- tiny SVG builders for visual math (self-contained, print-safe) ---- */
function svgWrap(inner, w = 240, h = 170) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;height:auto;background:#fff;border:1px solid #eee;border-radius:10px">${inner}</svg>`;
}
function svgPolygon(n) {
  const cx = 120, cy = 85, r = 60;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
    pts.push(`${(cx + r * Math.cos(ang)).toFixed(1)},${(cy + r * Math.sin(ang)).toFixed(1)}`);
  }
  return svgWrap(`<polygon points="${pts.join(" ")}" fill="#e8eafc" stroke="#4a3f5e" stroke-width="3"/>`);
}
function svgRectangle(w, h) {
  const scale = Math.min(150 / w, 90 / h, 18);
  const pw = w * scale, ph = h * scale, x = (240 - pw) / 2, y = (170 - ph) / 2;
  return svgWrap(
    `<rect x="${x}" y="${y}" width="${pw}" height="${ph}" fill="#e8eafc" stroke="#4a3f5e" stroke-width="3"/>` +
      `<text x="${x + pw / 2}" y="${y - 8}" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#4a3f5e" font-weight="700">${w}</text>` +
      `<text x="${x - 10}" y="${y + ph / 2 + 5}" text-anchor="end" font-family="sans-serif" font-size="16" fill="#4a3f5e" font-weight="700">${h}</text>`
  );
}
// Build "nice" y-axis tick values from 0..max (integer data 1-10).
function yTicks(max) {
  const m = Math.max(1, Math.ceil(max));
  // aim for ~5 ticks; step is 1 or 2 for small ranges
  const step = m <= 6 ? 1 : 2;
  const ticks = [];
  for (let v = 0; v <= m; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] !== m) ticks.push(m);
  return { ticks, top: m };
}

function svgBarChart(data) {
  const W = 280, H = 190, padL = 30, padR = 10, padB = 26, padT = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const { ticks, top } = yTicks(Math.max(...data.map((d) => d.value), 1));
  const yOf = (v) => padT + plotH - (plotH * v) / top;
  const bw = plotW / data.length;

  let svg = "";
  // horizontal gridlines + y-axis number labels
  ticks.forEach((t) => {
    const y = yOf(t);
    svg += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${t === 0 ? "#999" : "#e6e6e6"}" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="sans-serif" font-size="11" fill="#555">${t}</text>`;
  });
  // y-axis line
  svg += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${(padT + plotH).toFixed(1)}" stroke="#999" stroke-width="1.5"/>`;
  // bars + x labels
  data.forEach((d, i) => {
    const x = padL + i * bw + bw * 0.2;
    const w = bw * 0.6;
    const y = yOf(d.value);
    const h = padT + plotH - y;
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#3b7de8" rx="3"/>`;
    svg += `<text x="${(x + w / 2).toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555">${d.label}</text>`;
  });
  return svgWrap(svg, W, H);
}

function svgLineChart(data) {
  const W = 280, H = 190, padL = 30, padR = 10, padB = 26, padT = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const { ticks, top } = yTicks(Math.max(...data.map((d) => d.value), 1));
  const yOf = (v) => padT + plotH - (plotH * v) / top;
  const step = plotW / (data.length - 1);
  const pts = data.map((d, i) => [padL + i * step, yOf(d.value)]);

  let svg = "";
  ticks.forEach((t) => {
    const y = yOf(t);
    svg += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${t === 0 ? "#999" : "#e6e6e6"}" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="sans-serif" font-size="11" fill="#555">${t}</text>`;
  });
  svg += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${(padT + plotH).toFixed(1)}" stroke="#999" stroke-width="1.5"/>`;
  svg += `<polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="#2fa84f" stroke-width="2.5"/>`;
  pts.forEach((p, i) => {
    svg += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="#2fa84f"/>`;
    svg += `<text x="${p[0].toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555">${data[i].label}</text>`;
  });
  return svgWrap(svg, W, H);
}
function svgCoordPoint(px, py) {
  const W = 200, H = 200, pad = 24, span = 6, unit = (W - pad * 2) / span;
  const ox = pad, oy = H - pad;
  let svg = "";
  // grid
  for (let i = 0; i <= span; i++) {
    svg += `<line x1="${ox + i * unit}" y1="${pad}" x2="${ox + i * unit}" y2="${oy}" stroke="#eee" stroke-width="1"/>`;
    svg += `<line x1="${ox}" y1="${oy - i * unit}" x2="${W - pad}" y2="${oy - i * unit}" stroke="#eee" stroke-width="1"/>`;
  }
  // axes
  svg += `<line x1="${ox}" y1="${oy}" x2="${W - 6}" y2="${oy}" stroke="#555" stroke-width="1.5"/>`;
  svg += `<line x1="${ox}" y1="${oy}" x2="${ox}" y2="6" stroke="#555" stroke-width="1.5"/>`;
  // axis numbers
  for (let i = 1; i <= span; i++) {
    svg += `<text x="${ox + i * unit}" y="${oy + 14}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#777">${i}</text>`;
    svg += `<text x="${ox - 8}" y="${oy - i * unit + 4}" text-anchor="end" font-family="sans-serif" font-size="10" fill="#777">${i}</text>`;
  }
  // point A
  const ax = ox + px * unit, ay = oy - py * unit;
  svg += `<circle cx="${ax}" cy="${ay}" r="5" fill="#e8743b"/>`;
  svg += `<text x="${ax + 8}" y="${ay - 6}" font-family="sans-serif" font-size="13" font-weight="700" fill="#e8743b">A</text>`;
  return svgWrap(svg, W, H);
}

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

// Generic curated fallback generator for the optional "extra" subjects. These
// are normally AI-generated; this provides a small offline pool per subject.
function makeGen(pools) {
  return (grade) => {
    const easy = pools.easy || [];
    const mid = pools.mid || easy;
    const hard = pools.hard || mid;
    const pool = grade <= 3 ? easy : grade <= 7 ? [...easy, ...mid] : [...mid, ...hard];
    return { type: "text", ...pick(pool.length ? pool : easy) };
  };
}

const genArt = makeGen({
  easy: [
    { q: "What three colors are the primary colors?", a: "red, yellow, blue", accept: ["red yellow blue", "red, yellow, and blue", "red blue yellow"] },
    { q: "What do you get when you mix blue and yellow paint?", a: "green", accept: ["green"] },
    { q: "What tool do painters use to apply paint to a canvas?", a: "brush", accept: ["brush", "paintbrush", "a brush"] },
  ],
  mid: [
    { q: "What do you get when you mix red and blue paint?", a: "purple", accept: ["purple", "violet"] },
    { q: "Who painted the Mona Lisa?", a: "Leonardo da Vinci", accept: ["da vinci", "leonardo", "leonardo da vinci"] },
    { q: "What is a picture you make of yourself called?", a: "self-portrait", accept: ["self portrait", "self-portrait", "portrait"] },
  ],
  hard: [
    { q: "What art movement is Pablo Picasso associated with founding?", a: "Cubism", accept: ["cubism"] },
    { q: "What do we call the use of light and shadow to create depth in art?", a: "shading", accept: ["shading", "chiaroscuro", "value"] },
  ],
});
const genMusic = makeGen({
  easy: [
    { q: "How many strings does a standard guitar have?", a: "6", accept: ["6", "six"] },
    { q: "What instrument has black and white keys?", a: "piano", accept: ["piano", "keyboard"] },
    { q: "Is a drum a string, wind, or percussion instrument?", a: "percussion", accept: ["percussion"] },
  ],
  mid: [
    { q: "How many notes are in a musical octave (counting the repeat)?", a: "8", accept: ["8", "eight"] },
    { q: "What do we call how high or low a sound is?", a: "pitch", accept: ["pitch"] },
    { q: "What family does the violin belong to?", a: "string", accept: ["string", "strings", "string family"] },
  ],
  hard: [
    { q: "How many lines are on a musical staff?", a: "5", accept: ["5", "five"] },
    { q: "What Italian word means to play loudly?", a: "forte", accept: ["forte"] },
  ],
});
const genCoding = makeGen({
  easy: [
    { q: "In computers, what does a list of step-by-step instructions get called?", a: "a program", accept: ["program", "a program", "code", "algorithm"] },
    { q: "What do we call a mistake in a computer program?", a: "a bug", accept: ["bug", "a bug", "error"] },
    { q: "Does a computer do exactly what you tell it, or what you mean?", a: "exactly what you tell it", accept: ["exactly what you tell it", "what you tell it", "tell it"] },
  ],
  mid: [
    { q: "What do we call a set of steps that repeats in code?", a: "a loop", accept: ["loop", "a loop"] },
    { q: "What symbol often starts a line that the computer ignores (a comment) in many languages?", a: "//", accept: ["//", "slash slash", "#", "hashtag"] },
    { q: "What do we call a box that stores a value in a program?", a: "a variable", accept: ["variable", "a variable"] },
  ],
  hard: [
    { q: "What do we call code that runs only when a condition is true?", a: "an if statement", accept: ["if statement", "an if statement", "conditional", "if"] },
    { q: "What number system (base 2) do computers use?", a: "binary", accept: ["binary", "base 2", "base two"] },
  ],
});
const genHealth = makeGen({
  easy: [
    { q: "How many times a day should you brush your teeth?", a: "2", accept: ["2", "two", "twice"] },
    { q: "What should you do before eating to keep germs away?", a: "wash your hands", accept: ["wash your hands", "wash hands", "washing hands"] },
    { q: "Which is a healthier snack: an apple or candy?", a: "an apple", accept: ["apple", "an apple"] },
  ],
  mid: [
    { q: "How many hours of sleep does a child your age need each night (about)?", a: "9-11", accept: ["9", "10", "11", "9-11", "nine", "ten", "about 10"] },
    { q: "What food group are carrots and broccoli in?", a: "vegetables", accept: ["vegetables", "vegetable", "veggies"] },
    { q: "What part of your body pumps blood?", a: "heart", accept: ["heart", "the heart"] },
  ],
  hard: [
    { q: "What nutrient do you find a lot of in meat, beans, and eggs?", a: "protein", accept: ["protein"] },
    { q: "What vitamin does your skin make from sunlight?", a: "vitamin D", accept: ["vitamin d", "d"] },
  ],
});
const genSpanish = makeGen({
  easy: [
    { q: "How do you say 'hello' in Spanish?", a: "hola", accept: ["hola"] },
    { q: "What does 'gato' mean in English?", a: "cat", accept: ["cat", "a cat"] },
    { q: "How do you say 'thank you' in Spanish?", a: "gracias", accept: ["gracias"] },
  ],
  mid: [
    { q: "What does 'rojo' mean in English?", a: "red", accept: ["red"] },
    { q: "How do you say 'goodbye' in Spanish?", a: "adiós", accept: ["adios", "adiós"] },
    { q: "What is the English word for 'casa'?", a: "house", accept: ["house", "home"] },
  ],
  hard: [
    { q: "What does 'biblioteca' mean in English?", a: "library", accept: ["library"] },
    { q: "How do you say 'I am happy' in Spanish?", a: "estoy feliz", accept: ["estoy feliz", "soy feliz"] },
  ],
});

const SUBJECTS = [
  { key: "Math", gen: genMath, color: "#e8743b" },
  { key: "Reading & Writing", gen: genReading, color: "#3b7de8" },
  { key: "Science", gen: genScience, color: "#2fa84f" },
  { key: "History", gen: genHistory, color: "#9b4dca" },
  { key: "Geography", gen: genGeography, color: "#d4a017" },
  // optional extra subjects (off by default; parent can enable up to a max)
  { key: "Art", gen: genArt, color: "#e84393", optional: true },
  { key: "Music", gen: genMusic, color: "#0984e3", optional: true },
  { key: "Coding", gen: genCoding, color: "#1f9d9d", optional: true },
  { key: "Health", gen: genHealth, color: "#00b894", optional: true },
  { key: "Spanish", gen: genSpanish, color: "#d4a017", optional: true },
];

// All subjects can be freely chosen per kid (1 to 10). For a brand-new kid with
// no saved settings yet, these are the subjects enabled by default.
const DEFAULT_SUBJECTS = ["Math", "Reading & Writing", "Science", "History", "Geography"];
const MAX_SUBJECTS = 10; // there are 10 subjects total
const MIN_SUBJECTS = 1;  // a kid must have at least one subject

// A subject is "enabled" for a kid when it has a question count of 1+.
function subjectEnabled(subjectKey, kid) {
  return countFor(subjectKey, kid) > 0;
}
// The list of subject keys currently enabled for a kid (count >= 1). For a kid
// with no saved counts at all, falls back to the default subject set.
function enabledSubjects(kid) {
  const hasAnyCounts = kid && kid.counts && Object.keys(kid.counts).length > 0;
  if (!hasAnyCounts) return [...DEFAULT_SUBJECTS];
  return SUBJECTS.map((s) => s.key).filter((k) => countFor(k, kid) > 0);
}

// Resolve which topics are selected for a subject for this kid.
// Falls back to all built-in topics when nothing is chosen.
function selectedCategoriesFor(subjectKey, kid) {
  const builtIn = SUBJECT_CATEGORIES[subjectKey] || [];
  const custom = (kid && kid.categories && kid.categories.custom && kid.categories.custom[subjectKey]) || [];
  const available = subjectKey === "Math" ? builtIn : [...builtIn, ...custom];
  const sel = kid && kid.categories && kid.categories.selected && kid.categories.selected[subjectKey];
  if (Array.isArray(sel) && sel.length) {
    const filtered = sel.filter((c) => available.includes(c));
    if (filtered.length) return filtered;
  }
  // default: focus on all built-in topics (grade-limited for math)
  return subjectKey === "Math" ? mathCategoriesForGrade(kid ? kid.grade : 3) : builtIn;
}

const blankItem = (item) => ({ ...item, response: "", checked: false, correct: null, misses: 0, help: "" });

// How many questions to generate for a subject for this kid (parent-set, 0-20).
// A kid with no saved settings yet uses the default subjects at 10 each; every
// other subject is off (0) until the parent turns it on.
function countFor(subjectKey, kid) {
  const c = kid && kid.counts && kid.counts[subjectKey];
  if (c === 0) return 0;
  if (c == null || c === "") {
    const hasAnyCounts = kid && kid.counts && Object.keys(kid.counts).length > 0;
    if (hasAnyCounts) return 0; // counts exist but not this one -> subject is off
    return DEFAULT_SUBJECTS.includes(subjectKey) ? 10 : 0; // brand-new kid default
  }
  const n = Math.round(Number(c));
  if (Number.isFinite(n) && n >= 0 && n <= 20) return n;
  return 0;
}

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

// How much of a stored day has been worked on. `answered` counts questions
// with a non-empty response; `checked` counts ones that have been graded.
// Used to avoid regenerating a day that's already in progress (saves API calls).
function dayProgress(day) {
  if (!day || typeof day !== "object") return { total: 0, answered: 0, checked: 0, fraction: 0 };
  let total = 0, answered = 0, checked = 0;
  for (const s of SUBJECTS) {
    const list = Array.isArray(day[s.key]) ? day[s.key] : [];
    for (const it of list) {
      total++;
      if (String(it.response || "").trim().length > 0) answered++;
      if (it.checked) checked++;
    }
  }
  return { total, answered, checked, fraction: total ? answered / total : 0 };
}
// A stored day is considered a real, usable set if it has questions.
function dayHasQuestions(day) {
  return dayProgress(day).total > 0;
}

// Build a full day of questions.
//  • Math built-in categories  -> procedural (answers always exact)
//  • Math custom categories    -> AI-generated (graded by exact match)
//  • Other subjects            -> AI-generated from the selected categories
// Everything falls back to the curated/procedural generators when offline.
async function buildDay(grade, kid) {
  const out = {};
  const aiRequests = []; // {subject, categories, count}

  // ----- Math: split the kid's Math count between built-in (procedural) and custom (AI)
  const mathTotal = countFor("Math", kid);
  const mathSplit = splitCategories("Math", kid);
  let mathCustomCount = 0;
  if (mathTotal > 0 && mathSplit.customSel.length) {
    const total = mathSplit.builtInSel.length + mathSplit.customSel.length;
    mathCustomCount = Math.round((mathSplit.customSel.length / total) * mathTotal);
    if (mathCustomCount === 0) mathCustomCount = 1;
    if (mathSplit.builtInSel.length === 0) mathCustomCount = mathTotal;
    mathCustomCount = Math.min(mathTotal, mathCustomCount);
  }
  const mathBuiltInCount = mathTotal - mathCustomCount;
  out["Math"] = mathBuiltInCount > 0 ? buildMathList(grade, mathSplit.builtInSel, mathBuiltInCount) : [];
  if (mathCustomCount > 0) {
    aiRequests.push({ subject: "Math", categories: mathSplit.customSel, count: mathCustomCount });
  }

  // ----- Text subjects: AI-generated, honoring each subject's count (skip if 0)
  const textSubjects = SUBJECTS.filter((s) => s.key !== "Math");
  for (const s of textSubjects) {
    const n = countFor(s.key, kid);
    if (n > 0) aiRequests.push({ subject: s.key, categories: selectedCategoriesFor(s.key, kid), count: n });
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
    const n = countFor(s.key, kid);
    if (n === 0) {
      out[s.key] = [];
      continue;
    }
    const gen = generated && generated[s.key];
    if (gen && gen.length) {
      let list = gen.map((it) => blankItem({ type: "text", q: it.q, a: it.a, accept: [it.a], category: it.category || "" }));
      while (list.length < n) list.push(blankItem(SUBJECTS.find((x) => x.key === s.key).gen(grade)));
      out[s.key] = list.slice(0, n);
    } else {
      out[s.key] = buildTextListFallback(s.key, grade).slice(0, n);
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
  while (mathList.length < mathTotal) {
    mathList.push(blankItem(genMath(grade, pick(mathCategoriesForGrade(grade)))));
  }
  out["Math"] = mathList.slice(0, mathTotal);

  return out;
}

// Build N days of questions in as few AI calls as possible. We request
// count*N items per text subject in ONE call, then deal them out across the N
// days; Math is generated procedurally per day. Returns an array of day objects
// (index 0 = first day). Falls back gracefully per subject if the AI call fails.
async function buildDaysAhead(grade, kid, numDays) {
  const N = Math.max(1, Math.min(14, numDays));
  const days = Array.from({ length: N }, () => ({}));

  // ----- gather per-subject plans
  const textSubjects = SUBJECTS.filter((s) => s.key !== "Math");
  const aiRequests = [];

  // Math split (per-day counts are small; we generate procedurally per day)
  const mathTotal = countFor("Math", kid);
  const mathSplit = splitCategories("Math", kid);
  let mathCustomPerDay = 0;
  if (mathTotal > 0 && mathSplit.customSel.length) {
    const tot = mathSplit.builtInSel.length + mathSplit.customSel.length;
    mathCustomPerDay = Math.round((mathSplit.customSel.length / tot) * mathTotal);
    if (mathCustomPerDay === 0) mathCustomPerDay = 1;
    if (mathSplit.builtInSel.length === 0) mathCustomPerDay = mathTotal;
    mathCustomPerDay = Math.min(mathTotal, mathCustomPerDay);
  }
  const mathBuiltInPerDay = mathTotal - mathCustomPerDay;
  if (mathCustomPerDay > 0) aiRequests.push({ subject: "Math", categories: mathSplit.customSel, count: mathCustomPerDay * N });

  for (const s of textSubjects) {
    const n = countFor(s.key, kid);
    if (n > 0) aiRequests.push({ subject: s.key, categories: selectedCategoriesFor(s.key, kid), count: n * N });
  }

  // ----- one big AI call (the backend caps counts; we also cap N*count above)
  let generated = null;
  if (aiRequests.length) {
    try {
      generated = await api.generateQuestions(grade, aiRequests);
    } catch {
      generated = null;
    }
  }

  // helper: take the i-th slice of size `per` from an array (wrapping if short)
  const sliceFor = (arr, dayIdx, per) => {
    if (!arr || !arr.length || per <= 0) return [];
    const out = [];
    for (let k = 0; k < per; k++) out.push(arr[(dayIdx * per + k) % arr.length]);
    return out;
  };

  for (let i = 0; i < N; i++) {
    const dayGrade = grade;
    // text subjects
    for (const s of textSubjects) {
      const n = countFor(s.key, kid);
      if (n === 0) { days[i][s.key] = []; continue; }
      const gen = generated && generated[s.key];
      if (gen && gen.length) {
        const chunk = sliceFor(gen, i, n).map((it) => blankItem({ type: "text", q: it.q, a: it.a, accept: [it.a], category: it.category || "" }));
        while (chunk.length < n) chunk.push(blankItem(SUBJECTS.find((x) => x.key === s.key).gen(dayGrade)));
        days[i][s.key] = chunk.slice(0, n);
      } else {
        // procedural fallback, regenerated per day for variety
        const list = [];
        const seen = new Set();
        let guard = 0;
        const genFn = SUBJECTS.find((x) => x.key === s.key).gen;
        while (list.length < n && guard < 300) { guard++; const it = genFn(dayGrade); if (seen.has(it.q)) continue; seen.add(it.q); list.push(blankItem(it)); }
        while (list.length < n) list.push(blankItem(genFn(dayGrade)));
        days[i][s.key] = list;
      }
    }
    // Math: procedural built-in per day + AI custom slice
    let mathList = mathBuiltInPerDay > 0 ? buildMathList(dayGrade, mathSplit.builtInSel, mathBuiltInPerDay) : [];
    const mathGen = generated && generated["Math"];
    if (mathCustomPerDay > 0 && mathGen && mathGen.length) {
      mathList = mathList.concat(sliceFor(mathGen, i, mathCustomPerDay).map((it) => blankItem({ type: "math", q: it.q, a: it.a, accept: [it.a], category: it.category || "" })));
    }
    while (mathList.length < mathTotal) mathList.push(blankItem(genMath(dayGrade, pick(mathCategoriesForGrade(dayGrade)))));
    days[i]["Math"] = mathList.slice(0, mathTotal);
  }

  return days;
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

  const data = await apiRequest("grade", { subject, grade, items: payload });
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

/* ---- extra celebration motions (10 different pop-ups) ---- */
@keyframes sq-spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
@keyframes sq-spin-pop { 0%{transform:scale(0) rotate(-180deg);opacity:0} 60%{transform:scale(1.15) rotate(10deg)} 100%{transform:scale(1) rotate(0);opacity:1} }
@keyframes sq-boing { 0%{transform:scale(0)} 40%{transform:scale(1.3)} 60%{transform:scale(.85)} 80%{transform:scale(1.08)} 100%{transform:scale(1)} }
@keyframes sq-swing { 0%,100%{transform:rotate(-14deg)} 50%{transform:rotate(14deg)} }
@keyframes sq-pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.16)} }
@keyframes sq-shake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-7px)} 40%{transform:translateX(7px)} 60%{transform:translateX(-5px)} 80%{transform:translateX(5px)} }
@keyframes sq-floatup { 0%{transform:translateY(18px);opacity:0} 100%{transform:translateY(0);opacity:1} }
@keyframes sq-rise {
  0% { transform: translateY(112vh) rotate(0); opacity:1; }
  100% { transform: translateY(-14vh) rotate(180deg); opacity:0; }
}
@keyframes sq-driftpop { 0%{transform:scale(0);opacity:0} 50%{transform:scale(1.2);opacity:1} 100%{transform:scale(.4) translateY(-40px);opacity:0} }
.sq-anim-spin { display:inline-block; animation: sq-spin-pop .6s cubic-bezier(.2,1.3,.4,1) both, sq-spin 6s linear .6s infinite; }
.sq-anim-boing { display:inline-block; animation: sq-boing .7s cubic-bezier(.2,1.4,.4,1) both; }
.sq-anim-swing { display:inline-block; animation: sq-swing 1s ease-in-out infinite; transform-origin: 50% 0; }
.sq-anim-pulse { display:inline-block; animation: sq-pulse 1s ease-in-out infinite; }
.sq-anim-shake { display:inline-block; animation: sq-boing .6s cubic-bezier(.2,1.4,.4,1) both, sq-shake 1.2s ease .6s infinite; }
/* rising-from-bottom confetti variant */
.sq-risepiece { position: fixed; bottom: 0; font-size: 26px; animation: sq-rise linear forwards; pointer-events: none; z-index: 9998; }
/* little stars that pop around the headline */
.sq-spark { position:absolute; animation: sq-driftpop 1.4s ease-out infinite; pointer-events:none; }

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

/* ---- install (add to home screen) button ---- */
.sq-install-btn {
  padding: 10px 16px; border-radius: 12px; border: 1.5px solid #4a3f5e;
  background: #4a3f5e; color: #fff; font-weight: 800; font-size: 14px;
  cursor: pointer; font-family: 'Fredoka', sans-serif;
}
.sq-install-btn:hover { background: #5a4f70; }

/* exciting "play your game" button shown after the ribbon is closed */
@keyframes sq-playpulse {
  0%,100% { transform: scale(1); box-shadow: 0 6px 18px rgba(47,168,79,.35); }
  50% { transform: scale(1.04); box-shadow: 0 8px 26px rgba(47,168,79,.5); }
}
.sq-playbtn {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 12px 26px; border-radius: 999px; border: none; cursor: pointer;
  background: linear-gradient(135deg,#2fa84f,#1f9d6d); color: #fff;
  font-weight: 800; font-size: 16px; font-family: 'Fredoka', sans-serif;
  animation: sq-playpulse 1.8s ease-in-out infinite;
}
.sq-playbtn:hover { filter: brightness(1.05); }

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
  const [parent, setParent] = useState(null); // parent object when logged in
  const [familyMode, setFamilyMode] = useState(false); // kid-mode via family link (no login)
  const [parentMode, setParentMode] = useState(false);
  const [parentUnlocked, setParentUnlocked] = useState(false); // session unlock for parent area
  const [adminInitialized, setAdminInitialized] = useState(true); // assume yes until checked
  const [setupProtected, setSetupProtected] = useState(false);
  const [verifyState, setVerifyState] = useState(null); // {status:'working'|'error', message}
  const [inviteCode, setInviteCode] = useState(""); // co-parent invite link prefill
  const [resetToken, setResetToken] = useState(""); // password-reset link token
  const [familyName, setFamilyName] = useState(""); // shown in the header

  // data
  const [kids, setKids] = useState([]);
  const [activeKid, setActiveKid] = useState(null); // kid id
  const [day, setDay] = useState(null); // generated questions for active kid/today
  const [dayLoading, setDayLoading] = useState(false); // generating today's questions
  const [chores, setChores] = useState([]); // templates for active kid
  const [choreLog, setChoreLog] = useState({}); // today's chore responses

  // ui
  const [tab, setTab] = useState("study"); // study | chores | calendar
  const [showReward, setShowReward] = useState(false); // reward game modal
  const [showAvatarPicker, setShowAvatarPicker] = useState(false); // kid avatar customizer
  const [choreCeleb, setChoreCeleb] = useState(null); // celebration popup when all chores done
  const choreCelebRef = useRef({}); // `${kid}:${date}` shown already this session
  const lastAppCelebRef = useRef(-1); // vary the celebration shown

  const date = todayKey();

  // log out the parent session. If a family (kid) link is active, fall back to
  // kid mode instead of the login screen.
  const logout = useCallback(() => {
    api.logout();
    setParent(null);
    setParentMode(false);
    setParentUnlocked(false); // require password again next session
    if (getFamilyToken()) {
      setFamilyMode(true);
    } else {
      setKids([]);
      setActiveKid(null);
      setDay(null);
      setChores([]);
      setChoreLog({});
    }
  }, []);

  // fully leave a family device link (rare; from kid mode)
  const exitFamily = useCallback(() => {
    api.exitFamily();
    setFamilyMode(false);
    setKids([]);
    setActiveKid(null);
    setDay(null);
    setChores([]);
    setChoreLog({});
  }, []);

  const loadKidsInto = useCallback(async () => {
    const { kids: ks, familyName } = await api.listKids();
    setKids(ks);
    setFamilyName(familyName || "");
    setActiveKid((cur) => (ks.some((k) => k.id === cur) ? cur : ks[0]?.id || null));
    return ks;
  }, []);

  /* ---------- initial load: handle verify/family links, then session ---------- */
  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const verifyTok = params.get("verify");
      const familyCode = params.get("family");
      const invite = params.get("invite");
      const resetTok = params.get("reset");

      // Password-reset link: ?reset=<token> -> show the reset-password screen.
      if (resetTok) {
        setResetToken(resetTok);
        cleanUrl();
      }

      // Co-parent invite link: ?invite=<code> -> remember it and show the auth
      // screen pre-filled to join that family (they log in or sign up).
      if (invite) {
        setInviteCode(invite.trim().toUpperCase());
        cleanUrl();
        // If a parent session somehow exists already, drop it so they can choose
        // to log in / sign up as the invited co-parent.
        // (We just show the auth screen; existing token stays valid if they cancel.)
      }

      // 1) Email verification link: ?verify=<token>
      if (verifyTok) {
        setVerifyState({ status: "working" });
        try {
          const p = await api.verifyEmail(verifyTok);
          setParent(p);
          await loadKidsInto();
          cleanUrl();
          setVerifyState(null);
        } catch (e) {
          setVerifyState({ status: "error", message: e.message || "This link is invalid or expired." });
        } finally {
          setLoading(false);
        }
        return;
      }

      // 2) Kids' no-login family link: ?family=<code>
      if (familyCode) {
        try {
          await api.familyAccess(familyCode.trim().toUpperCase());
          setFamilyMode(true);
          await loadKidsInto();
        } catch (e) {
          // bad/expired link: fall through to normal screens
          setVerifyState({ status: "error", message: e.message || "That family link is no longer valid." });
        } finally {
          cleanUrl();
          setLoading(false);
        }
        return;
      }

      // 3) Existing parent session
      if (getToken()) {
        try {
          const me = await api.me();
          setParent(me);
          await loadKidsInto();
        } catch {
          api.logout();
        } finally {
          setLoading(false);
        }
        return;
      }

      // 4) Existing family (kid-mode) token on this device
      if (getFamilyToken()) {
        try {
          await loadKidsInto();
          setFamilyMode(true);
          setLoading(false);
          return;
        } catch {
          api.exitFamily();
        }
      }

      // 5) Nothing yet: check first-run admin status, then show login/signup
      try {
        const s = await api.adminStatus();
        setAdminInitialized(!!s.initialized);
        setSetupProtected(!!s.setupProtected);
      } catch {
        setAdminInitialized(true);
      }
      setLoading(false);
    })();
  }, [loadKidsInto]);

  // if any request reports the session is invalid, sign out
  useEffect(() => {
    const onUnauth = () => logout();
    window.addEventListener("sq-unauthorized", onUnauth);
    return () => window.removeEventListener("sq-unauthorized", onUnauth);
  }, [logout]);

  // called by the login screen once a parent token is set
  const handleAuthed = async (parentObj) => {
    setParent(parentObj);
    setFamilyMode(false);
    setInviteCode(""); // consume any pending invite once authed
    setLoading(true);
    try {
      await loadKidsInto();
    } finally {
      setLoading(false);
    }
  };

  // Convert this (installed) device into the no-login kid device for the
  // logged-in parent's family. After this, every open lands on the family view
  // with no login until a parent explicitly logs back in on this device.
  const enterKidMode = async () => {
    await api.enterKidModeForOwnFamily();
    // This device is now a kid device. Drop the PARENT token so future opens go
    // straight to the family (the boot logic checks the parent token first; if
    // we kept it, the app would reopen in parent mode). A parent can log back in
    // any time via the lock button to regain parent access on this device.
    api.logout(); // clears only the parent token; the family token remains
    setParentMode(false);
    setParentUnlocked(false);
    setParent(null);
    setFamilyMode(true);
    setLoading(true);
    try {
      await loadKidsInto();
    } finally {
      setLoading(false);
    }
  };

  // refresh kids after parent edits. Pass a known array (e.g. the one a
  // create/update/delete call already returned) to update instantly without a
  // second fetch that could momentarily return stale data.
  const refreshKids = useCallback(async (known) => {
    let ks;
    if (Array.isArray(known)) {
      ks = known;
    } else {
      const res = await api.listKids();
      ks = res.kids;
      setFamilyName(res.familyName || "");
    }
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

      // daily questions. We pre-generate a batch of upcoming days so we don't
      // call the API every single day. Rules preserved:
      //  - never regenerate a day that already has questions (in progress/done)
      //  - only generate NEW upcoming days if the most recent generated day was
      //    completed to at least REGEN_THRESHOLD (otherwise just ensure today
      //    exists, so the child always has work but we don't pile on more).
      const DAYS_AHEAD = 10;
      const REGEN_THRESHOLD = 0.5; // 50% of the latest day must be answered
      const dayKeyName = `daily:${kidId}:${date}`;
      let d = await store.get(dayKeyName);

      if (!dayHasQuestions(d)) {
        setDay(null);
        setDayLoading(true);
        try {
          // Look at the most recent previously-generated day (within the last
          // ~14 days) to decide whether to generate ahead.
          let gate = true; // default: allowed (first run or nothing recent)
          const recentKeys = [];
          for (let i = 1; i <= 14; i++) recentKeys.push(`daily:${kidId}:${dateKeyPlus(-i)}`);
          const recent = await store.mget(recentKeys);
          let latest = null;
          for (const k of recentKeys) { // recentKeys is newest-first
            if (dayHasQuestions(recent[k])) { latest = recent[k]; break; }
          }
          if (latest) {
            const prog = dayProgress(latest);
            gate = prog.total === 0 || prog.answered / prog.total >= REGEN_THRESHOLD;
          }

          if (gate) {
            // Generate today + the next (DAYS_AHEAD-1) days that don't exist yet.
            const futureKeys = Array.from({ length: DAYS_AHEAD }, (_, i) => `daily:${kidId}:${dateKeyPlus(i)}`);
            const existing = await store.mget(futureKeys);
            const built = await buildDaysAhead(kid.grade, kid, DAYS_AHEAD);
            await Promise.all(
              futureKeys.map((k, i) => {
                if (dayHasQuestions(existing[k])) return null; // keep any in-progress future day
                return store.set(k, built[i]);
              })
            );
            d = (await store.get(dayKeyName)) || built[0];
          } else {
            // Not enough of the last set was done — just make sure TODAY exists.
            d = await buildDay(kid.grade, kid);
            await store.set(dayKeyName, d);
          }
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

  // When a parent changes a kid's categories/counts: top up TODAY's set to match
  // the new counts (add new questions per subject, keep existing answers; trim
  // extras only from the unanswered tail), and clear untouched FUTURE pre-built
  // days so they regenerate with the new settings.
  const applySettingsChange = useCallback(async (updatedKid) => {
    if (!updatedKid || !updatedKid.id) return;
    const kidId = updatedKid.id;

    // 1) Reconcile today's day in place.
    const dayKeyName = `daily:${kidId}:${date}`;
    const today = await store.get(dayKeyName);
    if (dayHasQuestions(today)) {
      const next = { ...today };
      // Build a fresh "ideal" day to source brand-new questions from.
      const fresh = await buildDay(updatedKid.grade, updatedKid);
      for (const s of SUBJECTS) {
        const want = countFor(s.key, updatedKid);
        const cur = Array.isArray(next[s.key]) ? next[s.key].slice() : [];
        if (want === 0) { next[s.key] = []; continue; }
        if (cur.length < want) {
          // add new questions from the fresh set (skip dupes by question text)
          const have = new Set(cur.map((it) => it.q));
          const pool = (fresh[s.key] || []).filter((it) => !have.has(it.q));
          let pi = 0;
          while (cur.length < want && pi < pool.length) cur.push(pool[pi++]);
          // if still short (pool too small), generate procedurally
          const genFn = (SUBJECTS.find((x) => x.key === s.key) || {}).gen;
          let guard = 0;
          while (cur.length < want && genFn && guard < 300) {
            guard++;
            const it = blankItem(genFn(updatedKid.grade));
            if (!have.has(it.q)) { have.add(it.q); cur.push(it); }
          }
          next[s.key] = cur;
        } else if (cur.length > want) {
          // trim from the END, but never remove an answered question
          const trimmed = cur.slice();
          while (trimmed.length > want) {
            const last = trimmed[trimmed.length - 1];
            if (last && (last.response || last.checked)) break; // keep answered tail
            trimmed.pop();
          }
          next[s.key] = trimmed;
        }
      }
      await store.set(dayKeyName, next);
      if (kidId === activeKid) setDay(next);
    }

    // 2) Clear untouched future pre-generated days so they rebuild fresh.
    const futureKeys = Array.from({ length: 14 }, (_, i) => `daily:${kidId}:${dateKeyPlus(i + 1)}`);
    const future = await store.mget(futureKeys);
    await Promise.all(
      futureKeys.map((k) => {
        const fd = future[k];
        if (!fd) return null;
        const prog = dayProgress(fd);
        if (prog.answered === 0) return store.set(k, {}); // untouched -> clear so it regenerates
        return null; // leave a day they've already started
      })
    );
  }, [date, activeKid]);

  /* ---------- reward game: all questions correct + all today's chores done ---------- */
  // Only consider subjects that actually have questions today (a parent can set
  // a subject to 0). Require at least one question overall.
  const activeSubjectLists = day
    ? SUBJECTS.map((s) => day[s.key]).filter((l) => Array.isArray(l) && l.length > 0)
    : [];
  const hasAnyQuestions = activeSubjectLists.length > 0;

  const allQuestionsCorrect =
    hasAnyQuestions && activeSubjectLists.every((l) => l.every((it) => it.correct === true));

  // "Done with questions" = every question has been answered AND checked at
  // least once (regardless of right/wrong). This is the trigger for the
  // questions+answers email.
  const allQuestionsChecked =
    hasAnyQuestions && activeSubjectLists.every((l) => l.every((it) => it.checked === true));

  const choresToday = chores.filter(choreAppliesToday);
  const choresExistToday = choresToday.length > 0;
  const allChoresDone = choresToday.length === 0 || choresToday.every((c) => (choreLog[c.id] || {}).completed === "yes");

  const rewardEarned = allQuestionsCorrect && allChoresDone;
  const rewardPlays = (day && day.__rewardPlays) || 0;
  const REWARD_MAX_PLAYS = 3;
  const [rewardDismissed, setRewardDismissed] = useState(false);
  // show the ribbon only if: earned, plays remain, and not closed by the kid
  const showRibbon = rewardEarned && rewardPlays < REWARD_MAX_PLAYS && !rewardDismissed;

  // auto-pop the game ONCE per day per kid (first time it's earned)
  useEffect(() => {
    if (rewardEarned && day && !day.__rewardShown) {
      setShowReward(true);
      saveDay({ ...day, __rewardShown: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewardEarned]);

  // count a play and close the game; after REWARD_MAX_PLAYS the ribbon stops showing
  const finishReward = useCallback(() => {
    setShowReward(false);
    setDay((prev) => {
      if (!prev) return prev;
      const plays = (prev.__rewardPlays || 0) + 1;
      const next = { ...prev, __rewardPlays: plays };
      // persist (fire and forget)
      if (activeKid) store.set(`daily:${activeKid}:${date}`, next).catch(() => {});
      return next;
    });
  }, [activeKid, date]);

  /* ---------- completion emails to parents ----------
     When the child finishes questions / chores, ask the server to email the
     parents. The server validates the condition and dedupes per kid/day, so
     it's safe to call more than once. We avoid re-calling within a session
     unless the previous attempt wasn't actually sent (e.g. brief write lag). */
  const notifiedRef = useRef({});
  const maybeNotify = useCallback(
    async (type, attempt = 0) => {
      if (!activeKid) return;
      const key = `${activeKid}:${date}:${type}`;
      if (notifiedRef.current[key] === "done" || notifiedRef.current[key] === "pending") return;
      notifiedRef.current[key] = "pending";
      try {
        const r = await api.notify(type, activeKid, date);
        if (r && (r.alreadySent || r.sent > 0 || r.emailConfigured === false || r.noRecipients)) {
          notifiedRef.current[key] = "done";
        } else if (r && r.notReady && attempt < 3) {
          // data may not have propagated yet — retry shortly
          notifiedRef.current[key] = null;
          setTimeout(() => maybeNotify(type, attempt + 1), 1500);
        } else {
          notifiedRef.current[key] = null; // allow a later retry on state change
        }
      } catch {
        notifiedRef.current[key] = null;
      }
    },
    [activeKid, date]
  );

  useEffect(() => {
    if (allQuestionsChecked) maybeNotify("questions");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allQuestionsChecked, activeKid]);

  useEffect(() => {
    if (choresExistToday && allChoresDone) {
      maybeNotify("chores");
      // celebrate once per kid/day (this session)
      const k = `${activeKid}:${date}`;
      if (activeKid && !choreCelebRef.current[k]) {
        choreCelebRef.current[k] = true;
        const idx = pickCelebration(lastAppCelebRef.current);
        lastAppCelebRef.current = idx;
        setChoreCeleb({ index: idx, headline: "All your chores are done! 🧹✨" });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allChoresDone, choresExistToday, activeKid]);

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

  // Password-reset landing (?reset=...) takes priority.
  if (resetToken) {
    return (
      <ResetPasswordScreen
        token={resetToken}
        updateBanner={updateReady ? <UpdateBanner onUpdate={applyUpdate} /> : null}
        onDone={async (parentObj) => {
          setResetToken("");
          if (parentObj) {
            setParent(parentObj);
            setFamilyMode(false);
            setLoading(true);
            try { await loadKidsInto(); } finally { setLoading(false); }
          }
        }}
        onCancel={() => setResetToken("")}
      />
    );
  }

  // Email-verification landing (?verify=...) — show while working or on error.
  if (verifyState) {
    return <VerifyScreen state={verifyState} onContinue={() => setVerifyState(null)} />;
  }

  const banner = updateReady ? <UpdateBanner onUpdate={applyUpdate} /> : null;

  // Co-parent invite link active: show the auth screen pre-filled to join this
  // family, even if someone is already logged in (they can switch accounts).
  if (inviteCode) {
    if (!adminInitialized)
      return <AdminInitScreen setupProtected={setupProtected} onAuthed={handleAuthed} updateBanner={banner} />;
    return (
      <AuthScreen
        onAuthed={handleAuthed}
        updateBanner={banner}
        inviteCode={inviteCode}
        onCancelInvite={() => setInviteCode("")}
      />
    );
  }

  // Signed out AND no kid-mode link active -> first-run admin setup or login/signup.
  if (!parent && !familyMode) {
    if (!adminInitialized)
      return <AdminInitScreen setupProtected={setupProtected} onAuthed={handleAuthed} updateBanner={banner} />;
    return <AuthScreen onAuthed={handleAuthed} updateBanner={banner} />;
  }

  // In kid mode, opening the parent area requires a real parent login first.
  if (familyMode && !parent && parentMode) {
    return (
      <ParentLoginScreen
        onAuthed={handleAuthed}
        onCancel={() => setParentMode(false)}
        updateBanner={banner}
      />
    );
  }

  const kid = kids.find((x) => x.id === activeKid) || null;

  return (
    <div className="sq-root" style={wrap}>
      <style>{css}</style>
      {updateReady && <UpdateBanner onUpdate={applyUpdate} />}

      <Header
        parent={parent}
        familyMode={familyMode}
        familyName={familyName}
        kids={kids}
        activeKid={activeKid}
        setActiveKid={setActiveKid}
        parentMode={parentMode}
        onParent={() => setParentMode(true)}
        onExitParent={() => setParentMode(false)}
        onLogout={logout}
      />

      {parentMode && parent ? (
        <ParentPanel
          parent={parent}
          setParent={setParent}
          kids={kids}
          refreshKids={refreshKids}
          activeKid={activeKid}
          setActiveKid={setActiveKid}
          date={date}
          unlocked={parentUnlocked}
          setUnlocked={setParentUnlocked}
          onExitParent={() => setParentMode(false)}
          onRenamed={setFamilyName}
          onSettingsChanged={applySettingsChange}
          familyName={familyName}
          onEnterKidMode={enterKidMode}
        />
      ) : !kid ? (
        parent ? (
          <OnboardingWizard
            refreshKids={refreshKids}
            setActiveKid={setActiveKid}
            familyName={familyName}
            onRenamed={setFamilyName}
          />
        ) : (
          <EmptyState onParent={() => setParentMode(true)} familyMode={familyMode} />
        )
      ) : (
        <>
          {kid && (
            <div
              className="sq-noprint"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "#fff",
                border: `2px solid ${kidAvatar(kid).color}`,
                borderRadius: 16,
                padding: "10px 16px",
                marginBottom: 14,
                boxShadow: "0 4px 14px rgba(74,63,94,.08)",
              }}
            >
              <button
                onClick={() => setShowAvatarPicker(true)}
                title="Tap to change your icon and color"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: kidAvatar(kid).color,
                  color: "#fff",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 24,
                  flexShrink: 0,
                  border: "none",
                  cursor: "pointer",
                  position: "relative",
                }}
              >
                {kidAvatar(kid).emoji}
                <span style={{ position: "absolute", bottom: -3, right: -3, width: 18, height: 18, borderRadius: "50%", background: "#fff", border: "1px solid #e3dcec", display: "grid", placeItems: "center", fontSize: 10 }}>✏️</span>
              </button>
              <div style={{ lineHeight: 1.2 }}>
                <div style={{ fontSize: 12, color: "#9a8fb0", fontWeight: 700 }}>Now playing</div>
                <div className="sq-h" style={{ fontSize: 20, fontWeight: 800, color: kidAvatar(kid).color }}>{kid.name}</div>
                <button onClick={() => setShowAvatarPicker(true)} style={{ ...miniLink, padding: 0, color: kidAvatar(kid).color }}>✨ Change my icon</button>
              </div>
              {kids.length > 1 && (
                <div style={{ marginLeft: "auto", fontSize: 12, color: "#9a8fb0", fontWeight: 700, textAlign: "right" }}>
                  Not you?<br />Tap your face up top ☝️
                </div>
              )}
            </div>
          )}
          <TabBar tab={tab} setTab={setTab} />
          {showRibbon && (
            <div
              className="sq-noprint"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                maxWidth: 560,
                margin: "0 auto 16px",
                padding: "12px 16px",
                borderRadius: 14,
                color: "#fff",
                background: "linear-gradient(135deg,#2fa84f,#1f9d6d)",
                boxShadow: "0 6px 18px rgba(47,168,79,.25)",
              }}
            >
              <span className="sq-bob" style={{ fontSize: 24 }} aria-hidden="true">🎉</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontFamily: FONT_DISPLAY }}>All done — you earned a game!</div>
                <div style={{ fontSize: 13, opacity: 0.92 }}>
                  {REWARD_MAX_PLAYS - rewardPlays} play{REWARD_MAX_PLAYS - rewardPlays === 1 ? "" : "s"} left today
                </div>
              </div>
              <button
                onClick={() => setShowReward(true)}
                style={{ flexShrink: 0, padding: "9px 16px", borderRadius: 10, border: "none", background: "#fff", color: "#1f9d6d", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: FONT_DISPLAY }}
              >
                Play 🎮
              </button>
              <button
                onClick={() => setRewardDismissed(true)}
                aria-label="Close"
                title="Close"
                style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 8, border: "none", background: "rgba(255,255,255,.25)", color: "#fff", fontWeight: 800, fontSize: 16, cursor: "pointer", lineHeight: 1 }}
              >
                ✕
              </button>
            </div>
          )}
          {/* After the ribbon is closed, keep just an exciting button to reopen the game. */}
          {rewardEarned && rewardDismissed && rewardPlays < REWARD_MAX_PLAYS && (
            <div className="sq-noprint" style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
              <button
                className="sq-playbtn"
                onClick={() => setShowReward(true)}
                title={`${REWARD_MAX_PLAYS - rewardPlays} play${REWARD_MAX_PLAYS - rewardPlays === 1 ? "" : "s"} left today`}
              >
                <span className="sq-bob" style={{ fontSize: 20 }} aria-hidden="true">🎮</span>
                Play your reward game!
              </button>
            </div>
          )}
          {tab === "study" && <StudyView kid={kid} day={day} saveDay={saveDay} dayLoading={dayLoading} />}
          {tab === "chores" && (
            <ChoresView chores={chores} choreLog={choreLog} saveChoreLog={saveChoreLog} />
          )}
          {tab === "calendar" && (
            <CalendarView kid={kid} date={date} />
          )}
        </>
      )}

      {showReward && kid && (
        <RewardGameModal grade={kid.grade} kidName={kid.name} onClose={finishReward} />
      )}

      {showAvatarPicker && kid && (
        <AvatarPicker
          kid={kid}
          onClose={() => setShowAvatarPicker(false)}
          onSaved={(ks) => { refreshKids(ks); setShowAvatarPicker(false); }}
        />
      )}

      {choreCeleb && !showReward && (
        <CelebrationOverlay
          index={choreCeleb.index}
          headline={choreCeleb.headline}
          onClose={() => setChoreCeleb(null)}
        />
      )}

      <footer className="sq-noprint" style={{ textAlign: "center", padding: "24px 0", color: "#a99fb8", fontSize: 13 }}>
        StudyQuest · a new set of questions appears each day
      </footer>
    </div>
  );
}

/* ============================ AUTH SCREEN ============================ */
function AuthScreen({ onAuthed, updateBanner, inviteCode = "", onCancelInvite }) {
  const hasInvite = !!inviteCode;
  const [mode, setMode] = useState(hasInvite ? "signup" : "login"); // invitees usually need an account
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [joinFamily, setJoinFamily] = useState(hasInvite);
  const [familyCode, setFamilyCode] = useState(inviteCode || "");
  const [familyName, setFamilyName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // {email, devLink?, emailConfigured} after signup
  const [needsVerify, setNeedsVerify] = useState(false); // login blocked: unverified
  const [resendMsg, setResendMsg] = useState("");
  const [resetMsg, setResetMsg] = useState("");

  const isEmailish = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  const isAdminLogin = (v) => v.trim().toLowerCase() === "admin";

  const submit = async () => {
    setErr("");
    setNeedsVerify(false);
    // Signup must be a real email. Login also allows the reserved "admin" account.
    if (mode === "signup" && !isEmailish(email)) return setErr("Enter a valid email address.");
    if (mode === "login" && !isEmailish(email) && !isAdminLogin(email)) return setErr("Enter a valid email address.");
    if (password.length < 6) return setErr("Password must be at least 6 characters.");
    if (mode === "signup" && password !== confirm) return setErr("Passwords don't match.");
    if (mode === "signup" && joinFamily && !familyCode.trim()) return setErr("Enter the family code, or uncheck the box to start a new family.");
    setBusy(true);
    try {
      if (mode === "signup") {
        const r = await api.signup(email.trim(), password, joinFamily ? familyCode.trim() : "", joinFamily ? "" : familyName.trim());
        setPending({ email: email.trim(), devLink: r.devLink, emailConfigured: r.emailConfigured !== false });
        setBusy(false);
      } else {
        const parentObj = await api.login(email.trim(), password);
        // If they followed an invite link, join that family right after logging in.
        if (hasInvite) {
          try {
            const prev = await api.familyJoinPreview(inviteCode);
            if (prev && !prev.alreadyMember && prev.willDeleteOld && prev.kidsLost > 0) {
              const cur = prev.currentName ? `"${prev.currentName}"` : "your current family";
              const proceed = window.confirm(
                `Heads up: joining ${prev.targetName ? `"${prev.targetName}"` : "this family"} will remove you from ${cur} and permanently delete it, including its ${prev.kidsLost} child${prev.kidsLost === 1 ? "" : "ren"} and all their saved questions and chores.\n\nThis can't be undone. Continue?`
              );
              if (!proceed) {
                // stay logged in to their existing family
                await onAuthed(parentObj);
                return;
              }
            }
            await api.familyJoin(inviteCode);
          } catch (e) {
            // joining failed (e.g. invite expired) — continue logged in to their own family
          }
        }
        await onAuthed(parentObj);
      }
    } catch (e) {
      if (e.data && e.data.unverified) {
        setNeedsVerify(true);
        setErr("Please verify your email first — check your inbox for the link.");
      } else {
        setErr(e.message || "Something went wrong.");
      }
      setBusy(false);
    }
  };

  const resend = async () => {
    setResendMsg("");
    try {
      await api.resendVerification(email.trim());
      setResendMsg("If that email is registered, we've sent a new verification link.");
    } catch {
      setResendMsg("Could not resend right now. Try again shortly.");
    }
  };

  // After signup: ask them to check their email.
  if (pending) {
    return (
      <div className="sq-root" style={{ ...wrap, minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <style>{css}</style>
        {updateBanner}
        <div className="sq-card" style={{ ...panel, maxWidth: 460, width: "100%", textAlign: "center" }}>
          <div style={{ fontSize: 44 }}>📧</div>
          <h1 className="sq-h" style={{ ...h1, marginTop: 4 }}>Check your email</h1>
          <p style={{ color: "#7a6f8c" }}>
            We sent a verification link to <strong>{pending.email}</strong>. Click it to activate your account, and
            you'll be taken straight into your family.
          </p>
          {!pending.emailConfigured && (
            <div style={{ ...errBox, background: "#fff6e6", color: "#b8702a", textAlign: "left" }}>
              Email sending isn't configured on this deployment yet, so the message won't arrive. See the README
              (RESEND_API_KEY / FROM_EMAIL) to enable it.
            </div>
          )}
          {pending.devLink && (
            <div style={{ ...errBox, background: "#eef4fb", color: "#3b5b8e", textAlign: "left", wordBreak: "break-all" }}>
              <strong>Dev mode:</strong> <a href={pending.devLink} style={{ color: "#3b5b8e" }}>{pending.devLink}</a>
            </div>
          )}
          <button style={btnGhost} onClick={resend}>Resend the email</button>
          {resendMsg && <div style={{ color: "#2fa84f", fontWeight: 700, marginTop: 10, fontSize: 14 }}>{resendMsg}</div>}
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => { setPending(null); setMode("login"); }}
              style={{ background: "none", border: "none", color: "#4a3f5e", fontWeight: 800, cursor: "pointer", fontFamily: FONT_DISPLAY, fontSize: 14 }}
            >
              Back to log in
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sq-root" style={{ ...wrap, minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <style>{css}</style>
      {updateBanner}
      <div className="sq-card" style={{ ...panel, maxWidth: 440, width: "100%" }}>
        <div style={{ fontSize: 40, textAlign: "center" }}>🎓</div>
        <h1 className="sq-h" style={{ ...h1, textAlign: "center", marginTop: 4 }}>
          {hasInvite ? "Join your family on StudyQuest" : mode === "signup" ? "Create a parent account" : "Welcome back"}
        </h1>
        {hasInvite && (
          <div style={{ background: "#eef2fb", border: "1px solid #d3def5", borderRadius: 12, padding: "10px 12px", margin: "0 0 6px", fontSize: 14, color: "#3b5b8e", textAlign: "center" }}>
            You've been invited to help manage your family's kids. {mode === "signup" ? "Create an account" : "Log in"} and you'll join automatically.{" "}
            <button
              onClick={() => setMode(mode === "signup" ? "login" : "signup")}
              style={{ background: "none", border: "none", color: "#3b7de8", fontWeight: 800, cursor: "pointer", fontFamily: FONT_DISPLAY, fontSize: 14, padding: 0 }}
            >
              {mode === "signup" ? "Already have an account? Log in" : "Need an account? Sign up"}
            </button>
          </div>
        )}
        <p style={{ color: "#7a6f8c", textAlign: "center", marginTop: -6 }}>
          {mode === "signup"
            ? "Sign up with your email — we'll send a quick verification link."
            : "Log in to see your kids and their progress."}
        </p>

        <label style={lbl}>{mode === "login" ? "Email address" : "Email address"}</label>
        <input
          style={input}
          type={mode === "login" ? "text" : "email"}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={mode === "login" ? "you@example.com" : "you@example.com"}
          autoCapitalize="none"
          autoCorrect="off"
          onKeyDown={(e) => mode === "login" && e.key === "Enter" && submit()}
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
        {mode === "login" && (
          <div style={{ textAlign: "right", marginTop: 2 }}>
            <button
              onClick={async () => {
                setErr(""); setResetMsg("");
                if (!isEmailish(email)) { setErr("Enter your email above first, then tap “Forgot password”."); return; }
                try {
                  await api.requestPasswordReset(email.trim());
                  setResetMsg("If an account exists for that email, we've sent a reset link. Check your inbox.");
                } catch (e) {
                  setResetMsg("If an account exists for that email, we've sent a reset link. Check your inbox.");
                }
              }}
              style={{ background: "none", border: "none", color: "#3b7de8", fontWeight: 700, cursor: "pointer", fontFamily: FONT_DISPLAY, fontSize: 13, padding: "2px 0" }}
            >
              Forgot password?
            </button>
          </div>
        )}
        {resetMsg && <div style={{ ...errBox, background: "#eef4fb", color: "#3b5b8e" }}>{resetMsg}</div>}
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
            {!joinFamily && (
              <>
                <label style={lbl}>Family name <span style={{ color: "#9a8fb0", fontWeight: 600 }}>(optional)</span></label>
                <input
                  style={input}
                  value={familyName}
                  onChange={(e) => setFamilyName(e.target.value)}
                  placeholder="e.g. The Smith Family"
                  maxLength={40}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                />
                <div style={{ fontSize: 12, color: "#9a8fb0", marginTop: 4 }}>
                  Shown at the top of the app. You can change it later in the Parent area.
                </div>
              </>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, color: "#6a5f7e", fontWeight: 700, fontSize: 14, cursor: hasInvite ? "default" : "pointer" }}>
              <input type="checkbox" checked={joinFamily} onChange={(e) => !hasInvite && setJoinFamily(e.target.checked)} disabled={hasInvite} style={{ width: 18, height: 18 }} />
              {hasInvite ? "Joining your family (from your invite link)" : "Join an existing family (a co-parent shared a code)"}
            </label>
            {joinFamily && !hasInvite && (
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
        {needsVerify && (
          <div style={{ textAlign: "center", marginTop: 8 }}>
            <button style={btnGhost} onClick={resend}>Resend verification email</button>
            {resendMsg && <div style={{ color: "#2fa84f", fontWeight: 700, marginTop: 8, fontSize: 14 }}>{resendMsg}</div>}
          </div>
        )}

        <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
          {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
        </button>

        <div style={{ textAlign: "center", marginTop: 14, color: "#7a6f8c", fontSize: 14 }}>
          {mode === "signup" ? "Already have an account? " : "New here? "}
          <button
            onClick={() => {
              setMode(mode === "signup" ? "login" : "signup");
              setErr("");
              setNeedsVerify(false);
            }}
            style={{ background: "none", border: "none", color: "#4a3f5e", fontWeight: 800, cursor: "pointer", fontFamily: FONT_DISPLAY, fontSize: 14 }}
          >
            {mode === "signup" ? "Log in" : "Create one"}
          </button>
        </div>
        {hasInvite && onCancelInvite && (
          <div style={{ textAlign: "center", marginTop: 8 }}>
            <button
              onClick={onCancelInvite}
              style={{ background: "none", border: "none", color: "#9a8fb0", fontWeight: 700, cursor: "pointer", fontFamily: FONT_DISPLAY, fontSize: 13 }}
            >
              Cancel invitation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===================== EMAIL VERIFICATION LANDING ===================== */
function ResetPasswordScreen({ token, onDone, onCancel, updateBanner }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const submit = async () => {
    setErr("");
    if (pw.length < 6) return setErr("Password must be at least 6 characters.");
    if (pw !== pw2) return setErr("Passwords don't match.");
    setBusy(true);
    try {
      const r = await api.resetPassword(token, pw);
      setDone(true);
      // r.parent present -> they're now logged in
      setTimeout(() => onDone(r && r.parent ? r.parent : null), 900);
    } catch (e) {
      setErr(e.message || "This reset link is invalid or has expired.");
      setBusy(false);
    }
  };

  return (
    <div style={{ ...wrap, display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <style>{css}</style>
      {updateBanner}
      <div className="sq-card" style={{ ...panel, maxWidth: 420, width: "100%" }}>
        <div style={{ fontSize: 40, textAlign: "center" }}>🔑</div>
        <h1 className="sq-h" style={{ ...h1, textAlign: "center", marginTop: 4 }}>Choose a new password</h1>
        {done ? (
          <div style={{ ...errBox, background: "#eefaf0", color: "#2fa84f", textAlign: "center" }}>Password updated! Signing you in…</div>
        ) : (
          <>
            <p style={{ color: "#7a6f8c", textAlign: "center", marginTop: -6 }}>Enter a new password for your StudyQuest account.</p>
            <input style={input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" autoFocus />
            <input style={input} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Re-enter new password" onKeyDown={(e) => e.key === "Enter" && submit()} />
            {err && <div style={errBox}>{err}</div>}
            <button style={{ ...btnPrimary, width: "100%", opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>{busy ? "Saving…" : "Set new password"}</button>
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button onClick={onCancel} style={{ background: "none", border: "none", color: "#9a8fb0", fontWeight: 700, cursor: "pointer", fontFamily: FONT_DISPLAY, fontSize: 13 }}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function VerifyScreen({ state, onContinue }) {
  return (
    <div className="sq-root" style={{ ...wrap, minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <style>{css}</style>
      <div className="sq-card" style={{ ...panel, maxWidth: 440, width: "100%", textAlign: "center" }}>
        {state.status === "working" ? (
          <>
            <div style={{ fontSize: 44 }} className="sq-bob">✨</div>
            <h1 className="sq-h" style={{ ...h1, marginTop: 4 }}>Verifying your email…</h1>
            <p style={{ color: "#7a6f8c" }}>One moment while we activate your account.</p>
          </>
        ) : (
          <>
            <div style={{ fontSize: 44 }}>⚠️</div>
            <h1 className="sq-h" style={{ ...h1, marginTop: 4 }}>Verification problem</h1>
            <p style={{ color: "#7a6f8c" }}>{state.message}</p>
            <button style={btnPrimary} onClick={onContinue}>Back to log in</button>
          </>
        )}
      </div>
    </div>
  );
}

/* ============ PARENT LOGIN (entering parent area from kid mode) ============ */
function ParentLoginScreen({ onAuthed, onCancel, updateBanner }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr("");
    setBusy(true);
    try {
      const p = await api.login(email.trim(), password);
      await onAuthed(p);
    } catch (e) {
      setErr(e.message || "Incorrect email or password.");
      setBusy(false);
    }
  };

  return (
    <div className="sq-root" style={{ ...wrap, minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <style>{css}</style>
      {updateBanner}
      <div className="sq-card" style={{ ...panel, maxWidth: 420, width: "100%" }}>
        <div style={{ fontSize: 38, textAlign: "center" }}>🔐</div>
        <h1 className="sq-h" style={{ ...h1, textAlign: "center", marginTop: 4 }}>Parent log in</h1>
        <p style={{ color: "#7a6f8c", textAlign: "center", marginTop: -6 }}>
          Log in to manage kids, chores, and settings.
        </p>
        <label style={lbl}>Email address</label>
        <input style={input} type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoCapitalize="none" autoCorrect="off" />
        <label style={lbl}>Password</label>
        <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" onKeyDown={(e) => e.key === "Enter" && submit()} />
        {err && <div style={errBox}>{err}</div>}
        <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
          {busy ? "Please wait…" : "Log in"}
        </button>
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button onClick={onCancel} style={{ background: "none", border: "none", color: "#7a6f8c", fontWeight: 700, cursor: "pointer", fontFamily: FONT_DISPLAY, fontSize: 14 }}>
            ← Back to kid mode
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
function Header({ parent, familyMode, familyName, kids, activeKid, setActiveKid, parentMode, onParent, onExitParent, onLogout }) {
  const displayName = parent ? (parent.isAdmin ? "admin" : parent.email) : null;
  return (
    <header className="sq-noprint" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
        <div className="sq-h" style={{ fontSize: 26, fontWeight: 700, color: "#4a3f5e", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 28 }}>🎓</span> StudyQuest
        </div>
        {familyName ? (
          <div className="sq-h" style={{ fontSize: 14, fontWeight: 700, color: "#9b4dca", marginLeft: 36, marginTop: 1 }}>
            {familyName}
          </div>
        ) : null}
      </div>
      <div style={{ flex: 1 }} />
      {!parentMode && kids.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          {kids.map((k) => {
            const selected = k.id === activeKid;
            const av = kidAvatar(k);
            return (
              <button
                key={k.id}
                onClick={() => setActiveKid(k.id)}
                aria-pressed={selected}
                title={selected ? `${k.name} (playing now)` : `Switch to ${k.name}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 3,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <div
                  style={{
                    position: "relative",
                    width: selected ? 56 : 44,
                    height: selected ? 56 : 44,
                    borderRadius: "50%",
                    background: av.color,
                    color: "#fff",
                    display: "grid",
                    placeItems: "center",
                    fontFamily: FONT_DISPLAY,
                    fontWeight: 800,
                    fontSize: selected ? 24 : 19,
                    boxShadow: selected ? `0 0 0 4px #fff, 0 0 0 7px ${av.color}` : "0 2px 6px rgba(74,63,94,.2)",
                    opacity: selected ? 1 : 0.6,
                    transition: "all .15s ease",
                  }}
                >
                  {av.emoji}
                  {selected && (
                    <span
                      style={{
                        position: "absolute",
                        bottom: -2,
                        right: -2,
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        background: "#2fa84f",
                        color: "#fff",
                        fontSize: 12,
                        display: "grid",
                        placeItems: "center",
                        border: "2px solid #fff",
                      }}
                    >
                      ✓
                    </span>
                  )}
                </div>
                <span
                  className="sq-h"
                  style={{
                    fontSize: selected ? 14 : 12,
                    fontWeight: 800,
                    color: selected ? av.color : "#9a8fb0",
                    maxWidth: 72,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {k.name}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {displayName && (
        <span className="sq-h" style={{ color: "#9a8fb0", fontSize: 13, fontWeight: 700, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayName}{parent.isAdmin ? " 🛡️" : ""}
        </span>
      )}
      <InstallButton />
      {/* kid-mode (family link, no parent logged in): only offer Parent log in */}
      {familyMode && !parent ? (
        <button style={btnGhost} onClick={onParent}>🔒 Parent</button>
      ) : parentMode ? (
        <button style={btnGhost} onClick={onExitParent}>← Exit parent</button>
      ) : (
        <>
          <button style={btnGhost} onClick={onParent}>🔒 Parent</button>
          <button style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }} onClick={onLogout}>
            {familyMode ? "Switch account" : "Log out"}
          </button>
        </>
      )}
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

/* --------------------------- onboarding wizard -------------------------- */
function OnboardingWizard({ refreshKids, setActiveKid, familyName, onRenamed, startStep = 0, onDone }) {
  const [step, setStep] = useState(startStep);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // collected settings
  const [famName, setFamName] = useState(familyName || "");
  const [name, setName] = useState("");
  const [grade, setGrade] = useState(1);
  const [selected, setSelected] = useState(() => {
    // default: all built-in topics on
    const s = {};
    for (const subj of SUBJECTS) s[subj.key] = [...(SUBJECT_CATEGORIES[subj.key] || [])];
    return s;
  });
  const [counts, setCounts] = useState(() => {
    const c = {};
    for (const subj of SUBJECTS) c[subj.key] = DEFAULT_SUBJECTS.includes(subj.key) ? 10 : 0;
    return c;
  });
  const [chores, setChores] = useState(() => DEFAULT_CHORES.map((c) => ({ id: uid(), title: c.title, days: c.days.slice() })));
  const [newChore, setNewChore] = useState("");

  const toggleCat = (subj, cat) => {
    setSelected((prev) => {
      const cur = new Set(prev[subj] || []);
      cur.has(cat) ? cur.delete(cat) : cur.add(cat);
      return { ...prev, [subj]: [...cur] };
    });
  };
  const setCount = (subj, v) => {
    let n = parseInt(v, 10);
    if (!Number.isFinite(n)) n = 0;
    n = Math.max(0, Math.min(20, n));
    setCounts((c) => ({ ...c, [subj]: n }));
  };

  // Subjects are freely chosen (1–10). Enable = count 10 + all topics selected;
  // disable = count 0 (but keep at least one subject on).
  const chosenSubjectCount = () => SUBJECTS.filter((s) => (counts[s.key] ?? 0) > 0).length;
  const addOptional = (key, currentCount) => {
    if (currentCount >= MAX_SUBJECTS) return;
    setCounts((c) => ({ ...c, [key]: 10 }));
    setSelected((s) => ({ ...s, [key]: [...(SUBJECT_CATEGORIES[key] || [])] }));
  };
  const removeOptional = (key) => {
    if (chosenSubjectCount() <= MIN_SUBJECTS) return;
    setCounts((c) => ({ ...c, [key]: 0 }));
  };

  const next = () => setStep((s) => s + 1);
  const back = () => setStep((s) => Math.max(0, s - 1));

  // Final step: create the kid, save everything, generate questions.
  // Save the current child's settings. On success, remember the created id and
  // move to the "add another?" step (step 4). The hand-off to the app happens
  // only when the parent says they're done.
  const [addedCount, setAddedCount] = useState(0);
  const [firstKidId, setFirstKidId] = useState(null);
  const [lastKidName, setLastKidName] = useState("");

  const resetForNextKid = () => {
    setName("");
    setGrade(1);
    const s = {};
    for (const subj of SUBJECTS) s[subj.key] = [...(SUBJECT_CATEGORIES[subj.key] || [])];
    setSelected(s);
    const c = {};
    for (const subj of SUBJECTS) c[subj.key] = DEFAULT_SUBJECTS.includes(subj.key) ? 10 : 0;
    setCounts(c);
    setChores(DEFAULT_CHORES.map((ch) => ({ id: uid(), title: ch.title, days: ch.days.slice() })));
    setNewChore("");
    setErr("");
  };

  const saveCurrentKid = async () => {
    setErr("");
    if (!name.trim()) {
      setErr("Please enter the child's name.");
      setStep(1);
      return;
    }
    setBusy(true);
    try {
      if (famName.trim() && famName.trim() !== (familyName || "")) {
        try {
          const r = await api.familyRename(famName.trim());
          if (onRenamed) onRenamed((r && r.name) || famName.trim());
        } catch {}
      }
      // Create the child WITH categories + counts in one atomic write, then
      // save chores. This avoids a create-then-update sequence that could fail
      // on eventually-consistent storage ("Child not found").
      const { kid: created } = await api.createKid(name.trim(), Number(grade), {
        categories: { selected, custom: {} },
        counts,
      });
      if (!created || !created.id) throw new Error("Could not create the child profile.");
      await store.set(`chores:${created.id}`, chores);
      if (!firstKidId) setFirstKidId(created.id);
      setLastKidName(name.trim());
      setAddedCount((n) => n + 1);
      setBusy(false);
      setStep(4); // "add another?" screen
    } catch (e) {
      setErr(e.message || "Something went wrong setting up. Please try again.");
      setBusy(false);
    }
  };

  // Done adding kids — hand off to the app (selecting a kid generates questions),
  // or return to the caller (e.g. parent panel) if onDone was provided.
  const finishAll = async () => {
    setBusy(true);
    try {
      const ks = await refreshKids();
      if (firstKidId) setActiveKid(firstKidId);
      if (onDone) onDone(firstKidId, ks);
    } catch (e) {
      setErr(e.message || "Something went wrong. Please try again.");
      setBusy(false);
    }
  };

  const card = { ...panel, maxWidth: 600, margin: "0 auto" };

  // ---------- Step 0: Welcome ----------
  if (step === 0) {
    return (
      <div className="sq-card" style={card}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 52 }}>🎓</div>
          <h1 className="sq-h" style={{ ...h1, marginBottom: 4 }}>Welcome to StudyQuest!</h1>
          <p style={{ color: "#7a6f8c", marginTop: 0 }}>Let's set things up. Here's everything StudyQuest can do:</p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "16px 0" }}>
          {[
            ["📚", "Daily questions", "A fresh set of questions every day across Math, Reading & Writing, Science, History, and Geography — with instant, kid-friendly grading and gentle hints."],
            ["🎯", "You choose the subjects", "Pick 1–10 subjects per child and the topics within each, plus how many questions per subject. Math includes visual questions like graphs and shapes."],
            ["🎓", "Grade levels", "Set each child's grade so questions are the right difficulty."],
            ["🧹", "Chores tracker", "Add chores and choose which days they appear. Kids check them off each day."],
            ["🎮", "Reward game", "When a child gets everything right and finishes their chores, they unlock a fun mini-game — plus celebration pop-ups."],
            ["👨‍👩‍👧", "Family & multiple kids", "Add as many kids as you like. Invite another parent with a link. Each child has their own profile and progress."],
            ["📅", "Progress calendar", "See each child's questions and chores history at a glance."],
            ["📧", "Email updates", "Optionally get an email when your child finishes their questions or all their chores."],
          ].map(([emoji, title, desc]) => (
            <div key={title} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ fontSize: 24, flexShrink: 0, width: 30, textAlign: "center" }}>{emoji}</div>
              <div>
                <div className="sq-h" style={{ fontWeight: 800, color: "#4a3f5e" }}>{title}</div>
                <div style={{ fontSize: 14, color: "#7a6f8c", lineHeight: 1.4 }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <button style={{ ...btnPrimary, width: "100%", fontSize: 17, padding: "14px" }} onClick={next}>Let's get started →</button>
      </div>
    );
  }

  // ---------- Step 1: Add a kid (name + grade) ----------
  if (step === 1) {
    return (
      <div className="sq-card" style={card}>
        <WizardHeader step={1} total={4} title={addedCount > 0 ? "Add another child" : "Add your first child"} emoji="👧" />
        {familyName || addedCount > 0 ? null : (
          <>
            <label style={lbl}>Family name <span style={{ color: "#9a8fb0", fontWeight: 600 }}>(optional)</span></label>
            <input style={input} value={famName} onChange={(e) => setFamName(e.target.value)} placeholder="e.g. The Smith Family" maxLength={40} />
          </>
        )}
        <label style={lbl}>Child's name</label>
        <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ava" autoFocus onKeyDown={(e) => e.key === "Enter" && name.trim() && next()} />
        <label style={lbl}>Grade level</label>
        <p style={{ fontSize: 13, color: "#9a8fb0", margin: "0 0 6px" }}>This sets how hard the questions are.</p>
        <select style={input} value={grade} onChange={(e) => setGrade(Number(e.target.value))}>
          {Array.from({ length: 12 }).map((_, i) => <option key={i} value={i + 1}>Grade {i + 1}</option>)}
        </select>
        {err && <div style={errBox}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button style={{ ...btnGhost, flex: 1 }} onClick={() => (addedCount > 0 ? setStep(4) : (onDone ? onDone(null) : back()))}>{addedCount > 0 ? "← Back" : (onDone ? "Cancel" : "← Back")}</button>
          <button style={{ ...btnPrimary, flex: 2, marginTop: 0, opacity: name.trim() ? 1 : 0.5 }} disabled={!name.trim()} onClick={next}>Next: pick topics →</button>
        </div>
      </div>
    );
  }

  // ---------- Step 2: Subjects + topics + counts ----------
  if (step === 2) {
    const chosenCount = SUBJECTS.filter((s) => (counts[s.key] ?? 0) > 0).length;
    const renderSubject = (subj) => {
      const cats = SUBJECT_CATEGORIES[subj.key] || [];
      const sel = new Set(selected[subj.key] || []);
      const cnt = counts[subj.key] ?? 0;
      return (
        <div key={subj.key} style={{ padding: "12px 0", borderBottom: "1px solid #f0ecf6" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            <h3 className="sq-h" style={{ margin: 0, fontSize: 17, color: subj.color }}>{subj.key}</h3>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 13, color: "#7a6f8c", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
                Questions/day:
                <input type="number" min={1} max={20} value={cnt} onChange={(e) => setCount(subj.key, e.target.value)} style={{ ...input, margin: 0, width: 64, padding: "6px 8px", textAlign: "center" }} />
              </label>
              <button
                title={chosenCount <= MIN_SUBJECTS ? `Keep at least ${MIN_SUBJECTS} subject` : "Remove this subject"}
                onClick={() => removeOptional(subj.key)}
                disabled={chosenCount <= MIN_SUBJECTS}
                style={{ border: "none", background: "none", color: chosenCount <= MIN_SUBJECTS ? "#d8cfe4" : "#e0506b", cursor: chosenCount <= MIN_SUBJECTS ? "default" : "pointer", fontWeight: 800, fontSize: 16 }}
              >✕</button>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#9a8fb0", marginBottom: 6, fontWeight: 700 }}>Topics</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {cats.map((cat) => {
              const on = sel.has(cat);
              return (
                <button key={cat} onClick={() => toggleCat(subj.key, cat)} style={{ ...chip, fontSize: 13, padding: "7px 12px", background: on ? subj.color : "#fff", color: on ? "#fff" : "#6a5f7e", borderColor: on ? subj.color : "#e3dcec" }}>
                  {on ? "✓ " : ""}{cat}
                </button>
              );
            })}
          </div>
        </div>
      );
    };

    const chosen = SUBJECTS.filter((s) => (counts[s.key] ?? 0) > 0);

    return (
      <div className="sq-card" style={card}>
        <WizardHeader step={2} total={4} title={`What should ${name || "your child"} practice?`} emoji="🎯" />
        <p style={{ color: "#7a6f8c", marginTop: -6 }}>Choose {MIN_SUBJECTS}–{MAX_SUBJECTS} subjects, pick the topics in each, and set how many questions per subject. You can change all of this later.</p>

        {/* Subject chooser */}
        <div style={{ marginBottom: 6, padding: 14, background: "#faf8fd", borderRadius: 12, border: "1px solid #efeaf7" }}>
          <div className="sq-h" style={{ fontWeight: 800, color: "#4a3f5e", marginBottom: 4 }}>
            Choose subjects <span style={{ fontSize: 13, color: "#9a8fb0", fontWeight: 600 }}>({chosenCount}/{MAX_SUBJECTS})</span>
          </div>
          <p style={{ fontSize: 13, color: "#7a6f8c", margin: "0 0 8px" }}>Tap to turn a subject on or off. At least {MIN_SUBJECTS} must stay on.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {SUBJECTS.map((s) => {
              const on = (counts[s.key] ?? 0) > 0;
              const lockOff = on && chosenCount <= MIN_SUBJECTS;
              return (
                <button
                  key={s.key}
                  onClick={() => (on ? removeOptional(s.key) : addOptional(s.key, chosenCount))}
                  disabled={(!on && chosenCount >= MAX_SUBJECTS) || lockOff}
                  style={{ ...chip, fontSize: 13, padding: "8px 14px", background: on ? s.color : "#fff", color: on ? "#fff" : s.color, borderColor: s.color, opacity: (!on && chosenCount >= MAX_SUBJECTS) ? 0.4 : 1, cursor: lockOff ? "default" : "pointer" }}
                >
                  {on ? "✓ " : "+ "}{s.key}
                </button>
              );
            })}
          </div>
        </div>

        {chosen.map(renderSubject)}

        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button style={{ ...btnGhost, flex: 1 }} onClick={back}>← Back</button>
          <button style={{ ...btnPrimary, flex: 2, marginTop: 0 }} onClick={next}>Next: chores →</button>
        </div>
      </div>
    );
  }

  // ---------- Step 3: Chores ----------
  if (step === 3) {
    const addChore = () => {
      if (!newChore.trim()) return;
      setChores((c) => [...c, { id: uid(), title: newChore.trim(), days: ALL_DAYS.slice() }]);
      setNewChore("");
    };
    const removeChore = (id) => setChores((c) => c.filter((x) => x.id !== id));
    const toggleDay = (id, dow) =>
      setChores((c) =>
        c.map((ch) => {
          if (ch.id !== id) return ch;
          const set = new Set(ch.days);
          set.has(dow) ? set.delete(dow) : set.add(dow);
          return { ...ch, days: [...set].sort((a, b) => a - b) };
        })
      );
    return (
      <div className="sq-card" style={card}>
        <WizardHeader step={3} total={4} title="Set up chores" emoji="🧹" />
        <p style={{ color: "#7a6f8c", marginTop: -6 }}>We added a few common chores — edit, remove, or add your own. Tap day letters to choose which days each appears. (You can skip this and add chores later.)</p>
        {chores.map((c) => (
          <div key={c.id} style={{ padding: "10px 0", borderBottom: "1px solid #f0ecf6" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input style={{ ...input, margin: 0, flex: 1 }} value={c.title} onChange={(e) => setChores((arr) => arr.map((x) => (x.id === c.id ? { ...x, title: e.target.value } : x)))} />
              <button style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }} onClick={() => removeChore(c.id)}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 5, marginTop: 8, flexWrap: "wrap" }}>
              {WEEKDAYS.map((label, dow) => {
                const on = c.days.includes(dow);
                return (
                  <button key={dow} onClick={() => toggleDay(c.id, dow)} title={label} style={{ width: 34, height: 32, borderRadius: 8, cursor: "pointer", fontWeight: 800, fontSize: 12, fontFamily: FONT_DISPLAY, border: `1.5px solid ${on ? "#4a3f5e" : "#e3dcec"}`, background: on ? "#4a3f5e" : "#fff", color: on ? "#fff" : "#9a8fb0" }}>{label[0]}</button>
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input style={{ ...input, margin: 0 }} value={newChore} onChange={(e) => setNewChore(e.target.value)} placeholder="Add a chore…" onKeyDown={(e) => e.key === "Enter" && addChore()} />
          <button style={{ ...btnGhost }} onClick={addChore}>+ Add</button>
        </div>
        {err && <div style={errBox}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button style={{ ...btnGhost, flex: 1 }} onClick={back}>← Back</button>
          <button style={{ ...btnPrimary, flex: 2, marginTop: 0, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={saveCurrentKid}>
            {busy ? "Saving…" : `✨ Save ${name.trim() || "child"}`}
          </button>
        </div>
      </div>
    );
  }

  // ---------- Step 4: Saved — add another child? ----------
  if (step === 4) {
    return (
      <div className="sq-card" style={card}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 52 }}>🎉</div>
          <h2 className="sq-h" style={{ ...h2, marginBottom: 4 }}>{lastKidName} is all set!</h2>
          <p style={{ color: "#7a6f8c", marginTop: 0 }}>
            {addedCount === 1 ? "1 child added." : `${addedCount} children added.`} Would you like to add another child?
          </p>
        </div>
        {err && <div style={errBox}>{err}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          <button
            style={{ ...btnGhost, width: "100%", padding: "14px", fontSize: 16 }}
            disabled={busy}
            onClick={() => { resetForNextKid(); setStep(1); }}
          >
            ➕ Add another child
          </button>
          <button
            style={{ ...btnPrimary, width: "100%", marginTop: 0, padding: "14px", fontSize: 17, opacity: busy ? 0.6 : 1 }}
            disabled={busy}
            onClick={finishAll}
          >
            {busy ? "Creating questions…" : "✅ All done — start StudyQuest"}
          </button>
        </div>
        {busy && <p style={{ textAlign: "center", color: "#9a8fb0", fontSize: 13, marginTop: 10 }}>Generating the first set of questions — this can take a few seconds.</p>}
      </div>
    );
  }

  return null;
}

function WizardHeader({ step, total, title, emoji }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {Array.from({ length: total }).map((_, i) => (
          <div key={i} style={{ flex: 1, height: 6, borderRadius: 3, background: i < step ? "#4a3f5e" : "#e8e2f1" }} />
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 30 }}>{emoji}</span>
        <h2 className="sq-h" style={{ ...h2, margin: 0 }}>{title}</h2>
      </div>
      <div style={{ fontSize: 12, color: "#9a8fb0", fontWeight: 700, marginTop: 4 }}>Step {step} of {total}</div>
    </div>
  );
}

/* ----------------------------- avatar picker ---------------------------- */
function AvatarPicker({ kid, onClose, onSaved }) {
  const cur = kidAvatar(kid);
  const [icon, setIcon] = useState(cur.emoji);
  const [color, setColor] = useState(cur.color);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const ks = await api.setKidAvatar(kid.id, icon, color);
      onSaved(ks);
    } catch (e) {
      setErr(e.message || "Could not save. Try again.");
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(40,30,55,.55)", display: "grid", placeItems: "center", zIndex: 100, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="sq-card"
        style={{ background: "#fff", borderRadius: 22, padding: 22, maxWidth: 460, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 className="sq-h" style={{ ...h2, margin: 0 }}>Make it yours!</h2>
          <button onClick={onClose} aria-label="Close" style={{ width: 34, height: 34, borderRadius: 10, border: "none", background: "#f0ecf6", color: "#6a5f7e", fontSize: 18, fontWeight: 800, cursor: "pointer" }}>✕</button>
        </div>

        {/* Live preview */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
          <div style={{ width: 90, height: 90, borderRadius: "50%", background: color, display: "grid", placeItems: "center", fontSize: 50, boxShadow: `0 0 0 5px #fff, 0 0 0 9px ${color}` }}>
            {icon}
          </div>
        </div>

        <div style={{ ...lbl, marginTop: 0 }}>Pick an icon</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(46px, 1fr))", gap: 6, maxHeight: 230, overflowY: "auto", padding: 4, background: "#faf8fd", borderRadius: 12, border: "1px solid #efeaf7" }}>
          {AVATAR_ICONS.map((ic) => (
            <button
              key={ic}
              onClick={() => setIcon(ic)}
              style={{
                aspectRatio: "1",
                fontSize: 26,
                borderRadius: 10,
                cursor: "pointer",
                border: icon === ic ? `2.5px solid ${color}` : "2.5px solid transparent",
                background: icon === ic ? "#fff" : "transparent",
                boxShadow: icon === ic ? "0 2px 8px rgba(74,63,94,.15)" : "none",
              }}
            >
              {ic}
            </button>
          ))}
        </div>

        <div style={lbl}>Pick a color</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              aria-label={c}
              style={{
                width: 38,
                height: 38,
                borderRadius: "50%",
                background: c,
                cursor: "pointer",
                border: color === c ? "3px solid #2b2438" : "3px solid #fff",
                boxShadow: "0 1px 4px rgba(0,0,0,.2)",
              }}
            >
              {color === c ? <span style={{ color: "#fff", fontWeight: 900 }}>✓</span> : ""}
            </button>
          ))}
        </div>

        {err && <div style={errBox}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button style={{ ...btnGhost, flex: 1 }} onClick={onClose}>Cancel</button>
          <button style={{ ...btnPrimary, flex: 2, marginTop: 0, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={save}>
            {busy ? "Saving…" : "💾 Save my look"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onParent, familyMode }) {
  return (
    <div className="sq-card" style={{ ...panel, textAlign: "center" }}>
      <div style={{ fontSize: 40 }}>👋</div>
      <h2 className="sq-h" style={h2}>No kid profiles yet</h2>
      {familyMode ? (
        <>
          <p style={{ color: "#7a6f8c" }}>Ask a parent to log in and add a child with their grade level.</p>
          <button style={btnPrimary} onClick={onParent}>🔒 Parent log in</button>
        </>
      ) : (
        <>
          <p style={{ color: "#7a6f8c" }}>Open the parent panel to add a child and set their grade level.</p>
          <button style={btnPrimary} onClick={onParent}>🔒 Open parent panel</button>
        </>
      )}
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

/* ---- 10 different celebratory pop-ups ----
   Each has its own emoji, words, color, emoji-motion and falling-particle
   style, so kids see fun variety when they ace a subject or finish chores.   */
const CELEBRATIONS = [
  { emoji: "🏆", title: "Perfect Score!", motion: "bob", fx: "rain", color: "#e8a020", particles: ["⭐", "🏆", "✨", "🌟"] },
  { emoji: "🎉", title: "Woohoo!", motion: "boing", fx: "burst", color: "#e0506b", particles: ["🎉", "🎊", "💥", "✨"] },
  { emoji: "🚀", title: "Blast Off!", motion: "shake", fx: "rise", color: "#3b7de8", particles: ["🚀", "⭐", "💫", "✨"] },
  { emoji: "🌟", title: "Superstar!", motion: "spin", fx: "rain", color: "#d4a017", particles: ["🌟", "⭐", "✨", "💫"] },
  { emoji: "🦄", title: "Magical!", motion: "swing", fx: "burst", color: "#9b4dca", particles: ["🦄", "🌈", "✨", "💖"] },
  { emoji: "🎯", title: "Bullseye!", motion: "boing", fx: "burst", color: "#2fa84f", particles: ["🎯", "🎉", "👏", "⭐"] },
  { emoji: "👏", title: "Way to Go!", motion: "pulse", fx: "rise", color: "#e8743b", particles: ["👏", "🙌", "✨", "🎉"] },
  { emoji: "🥳", title: "Amazing Job!", motion: "boing", fx: "rain", color: "#e0506b", particles: ["🥳", "🎊", "🎉", "⭐"] },
  { emoji: "🧠", title: "Big Brain!", motion: "pulse", fx: "burst", color: "#3b7de8", particles: ["🧠", "💡", "⭐", "✨"] },
  { emoji: "🔥", title: "On Fire!", motion: "shake", fx: "rise", color: "#e8743b", particles: ["🔥", "💪", "⭐", "✨"] },
];

const CHEERS = [
  "You're a superstar — keep it up!",
  "Incredible work today!",
  "You worked so hard — be proud!",
  "Your brain is getting stronger!",
  "High five! That was awesome.",
  "You did it — fantastic job!",
];

// Pick a celebration, optionally avoiding the last one shown for variety.
function pickCelebration(avoidIndex) {
  let i = Math.floor(Math.random() * CELEBRATIONS.length);
  if (CELEBRATIONS.length > 1 && i === avoidIndex) i = (i + 1) % CELEBRATIONS.length;
  return i;
}

const motionClass = {
  bob: "sq-bob",
  boing: "sq-anim-boing",
  spin: "sq-anim-spin",
  swing: "sq-anim-swing",
  pulse: "sq-anim-pulse",
  shake: "sq-anim-shake",
};

function CelebrationOverlay({ index = 0, headline, message, onClose }) {
  const c = CELEBRATIONS[index % CELEBRATIONS.length];
  const cheer = message || CHEERS[index % CHEERS.length];

  // Falling ("rain") or rising particles across the screen.
  const showRainOrRise = c.fx === "rain" || c.fx === "rise";
  const pieces = showRainOrRise
    ? Array.from({ length: 26 }).map((_, i) => ({
        key: i,
        char: c.particles[i % c.particles.length],
        left: `${Math.random() * 100}%`,
        dur: `${1.8 + Math.random() * 1.6}s`,
        delay: `${Math.random() * 0.7}s`,
        size: `${20 + Math.random() * 18}px`,
      }))
    : [];

  return (
    <div className="sq-overlay" onClick={onClose}>
      {showRainOrRise &&
        pieces.map((r) => (
          <span
            key={r.key}
            className={c.fx === "rise" ? "sq-risepiece" : "sq-rainpiece"}
            style={{ left: r.left, animationDuration: r.dur, animationDelay: r.delay, fontSize: r.size }}
          >
            {r.char}
          </span>
        ))}
      <div className="sq-overlay-card" style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
        {/* burst variant: little sparks pop around the card */}
        {c.fx === "burst" &&
          Array.from({ length: 8 }).map((_, i) => (
            <span
              key={i}
              className="sq-spark"
              style={{
                left: `${10 + Math.random() * 80}%`,
                top: `${8 + Math.random() * 70}%`,
                fontSize: `${16 + Math.random() * 14}px`,
                animationDelay: `${Math.random() * 1.2}s`,
              }}
            >
              {c.particles[i % c.particles.length]}
            </span>
          ))}
        <div style={{ fontSize: 70 }} className={motionClass[c.motion] || "sq-bob"}>{c.emoji}</div>
        <h2 className="sq-h" style={{ fontSize: 30, color: c.color, margin: "6px 0 4px" }}>{c.title}</h2>
        <p style={{ fontSize: 18, fontWeight: 700, color: "#4a3f5e", margin: "0 0 6px" }}>{headline}</p>
        <p style={{ color: "#7a6f8c", margin: "0 0 18px" }}>{cheer}</p>
        <button style={{ ...btnPrimary, background: c.color, marginTop: 0 }} onClick={onClose}>
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
  const [aced, setAced] = useState(null); // celebration popup payload {index, headline}

  // If the open subject has no questions today (parent set it to 0), switch to
  // the first subject that does.
  useEffect(() => {
    if (!day) return;
    const hasQ = (k) => Array.isArray(day[k]) && day[k].length > 0;
    if (!hasQ(openSubject)) {
      const first = SUBJECTS.find((s) => hasQ(s.key));
      if (first && first.key !== openSubject) setOpenSubject(first.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, openSubject]);
  const [celebrate, setCelebrate] = useState({}); // `${subject}:${i}` -> true (newly correct)
  const [helpLoading, setHelpLoading] = useState({}); // `${subject}:${i}` -> true while fetching help
  const lastCelebRef = useRef(-1); // last celebration shown, so we vary them

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
      const idx = pickCelebration(lastCelebRef.current);
      lastCelebRef.current = idx;
      setAced({ index: idx, headline: `You got every ${subject} question right! 🎉` });
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

  const subjectComplete = (subject) =>
    (day[subject] || []).length > 0 && day[subject].every((it) => String(it.response || "").trim().length > 0);

  const checkSubject = async (subject) => {
    const list = day[subject];
    const color = subjMeta(subject).color;

    // Require every question to be answered before checking. This avoids
    // wasted grading calls on partially-filled subjects (and nudges kids to
    // attempt everything first).
    if (!subjectComplete(subject)) {
      const blanks = list.filter((it) => !String(it.response || "").trim()).length;
      setBanner({
        subject,
        type: "warn",
        text: `Answer all ${list.length} questions first — ${blanks} still blank.`,
      });
      return;
    }

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
      // If we were rate-limited, tell the child to slow down — don't burn the
      // attempt by grading offline.
      if (e && (e.status === 429 || (e.data && e.data.rateLimited))) {
        setBanner({
          subject,
          type: "warn",
          text: (e.data && e.data.error) || "You're checking too fast — wait a moment and try again.",
        });
        return;
      }
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
        {SUBJECTS.filter((s) => Array.isArray(day[s.key]) && day[s.key].length > 0).map((s) => {
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
        const available = SUBJECTS.filter((x) => Array.isArray(day[x.key]) && day[x.key].length > 0).map((x) => x.key);
        if (available.length === 0) {
          return (
            <div className="sq-card" style={panel}>
              <p style={{ color: "#7a6f8c", margin: 0 }}>No questions are set for today. A parent can adjust how many questions each subject has in the Parent area.</p>
            </div>
          );
        }
        const s = subjMeta(openSubject);
        const list = day[openSubject] || [];
        const sc = subjectScore(openSubject);
        return (
          <div className="sq-card" style={{ ...panel, borderTop: `5px solid ${s.color}` }}>
            <div className="sq-noprint" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <h3 className="sq-h" style={{ margin: 0, fontSize: 22, color: s.color }}>{s.key}</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {(() => {
                  const answered = list.filter((it) => String(it.response || "").trim()).length;
                  const ready = answered === list.length;
                  return (
                    <>
                      {!ready && (
                        <span className="sq-noprint" style={{ fontSize: 13, color: "#9a8fb0", fontWeight: 700 }}>
                          {answered}/{list.length} answered
                        </span>
                      )}
                      <button style={{ ...btnGhost, borderColor: s.color, color: s.color }} onClick={() => printSubject(s.key)}>🖨️ Print this subject</button>
                      <button
                        style={{ ...btnPrimary, background: s.color, opacity: grading === s.key || !ready ? 0.5 : 1, cursor: grading === s.key ? "wait" : !ready ? "not-allowed" : "pointer" }}
                        disabled={grading === s.key || !ready}
                        title={ready ? "" : "Answer every question first"}
                        onClick={() => checkSubject(s.key)}
                      >
                        {grading === s.key ? "⏳ Checking…" : "✓ Check my answers"}
                      </button>
                    </>
                  );
                })()}
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
                    {it.svg && (
                      <div
                        style={{ margin: "4px 0 10px", maxWidth: 260 }}
                        dangerouslySetInnerHTML={{ __html: it.svg }}
                      />
                    )}
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

      {aced && <CelebrationOverlay index={aced.index} headline={aced.headline} onClose={() => setAced(null)} />}
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
            `<li><div class="q">${i + 1}. ${esc(it.q)}</div>${it.svg ? `<div class="fig">${it.svg}</div>` : ""}<div class="ans"></div></li>`
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
    .fig{margin:8px 0;max-width:240px}
    .fig svg{max-width:240px;height:auto}
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
function CalendarView({ kid, date }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [data, setData] = useState({}); // dateKey -> { q?, ch? }
  const [loading, setLoading] = useState(false);
  // cache loaded months per kid so flipping back and forth is instant
  const cacheRef = useRef({}); // `${kidId}:${y}-${m}` -> map

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `${kid.id}:${cursor.y}-${cursor.m}`;

    // Show cached month immediately if we have it (still refresh in background
    // only for the current month, which can change as the kid works today).
    const cached = cacheRef.current[cacheKey];
    const isCurrentMonth = (() => {
      const now = new Date();
      return now.getFullYear() === cursor.y && now.getMonth() === cursor.m;
    })();
    if (cached) {
      setData(cached);
      if (!isCurrentMonth) return; // past months never change — no refetch
    } else {
      setLoading(true);
    }

    (async () => {
      const days = daysInMonth(cursor.y, cursor.m);
      const dayKeys = [];
      const qKeys = [];
      const chKeys = [];
      for (let dn = 1; dn <= days; dn++) {
        const key = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(dn).padStart(2, "0")}`;
        dayKeys.push(key);
        qKeys.push(`daily:${kid.id}:${key}`);
        chKeys.push(`chore-log:${kid.id}:${key}`);
      }

      // ONE request for the whole month (both questions + chores) instead of
      // dozens of sequential round-trips.
      const values = await store.mget([...qKeys, ...chKeys]);
      if (cancelled) return;

      const map = {};
      for (const key of dayKeys) {
        const d = values[`daily:${kid.id}:${key}`];
        if (d) {
          let right = 0, total = 0, checked = 0;
          for (const subj of SUBJECTS.map((s) => s.key)) {
            const list = Array.isArray(d[subj]) ? d[subj] : [];
            list.forEach((it) => {
              total++;
              if (it.checked) checked++;
              if (it.correct === true) right++;
            });
          }
          if (total > 0) map[key] = { ...(map[key] || {}), q: { right, total, checked } };
        }
        const log = values[`chore-log:${kid.id}:${key}`];
        if (log && typeof log === "object") {
          const vals = Object.values(log);
          const count = vals.length;
          if (count > 0) {
            const done = vals.filter((v) => v && v.completed === "yes").length;
            const partly = vals.filter((v) => v && v.completed === "partly").length;
            map[key] = { ...(map[key] || {}), ch: { done, partly, count } };
          }
        }
      }

      cacheRef.current[cacheKey] = map;
      if (!cancelled) {
        setData(map);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cursor, kid.id]);

  const days = daysInMonth(cursor.y, cursor.m);
  const firstDow = new Date(cursor.y, cursor.m, 1).getDay();
  const monthName = new Date(cursor.y, cursor.m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const move = (delta) => {
    let m = cursor.m + delta, y = cursor.y;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setCursor({ y, m });
  };

  const scoreColor = (right, total) => {
    const pct = total ? right / total : 0;
    return pct >= 0.8 ? "#2f7a45" : pct >= 0.5 ? "#b8702a" : "#c0455c";
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <h2 className="sq-h" style={{ ...h2, margin: 0 }}>{kid.name}'s Progress</h2>
        <div style={{ fontSize: 13, color: "#9a8fb0", fontWeight: 700 }}>📚 Questions &nbsp;·&nbsp; 🧹 Chores</div>
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
            const info = data[key] || {};
            const q = info.q;
            const ch = info.ch;
            const isToday = key === date;
            const ring = isToday ? "2px solid #4a3f5e" : "1px solid #ece7f3";

            return (
              <div key={key} style={{ minHeight: 62, borderRadius: 12, background: "#faf8fd", border: ring, padding: 5, display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#6a5f7e" }}>{dn}</div>
                {q && q.checked > 0 && (
                  <div style={{ fontSize: 12, fontWeight: 800, color: scoreColor(q.right, q.total) }}>
                    📚 {q.right}/{q.total}
                  </div>
                )}
                {q && q.checked === 0 && (
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#9a8fb0" }}>📚 •</div>
                )}
                {ch && (
                  <div style={{ fontSize: 12, fontWeight: 800, color: scoreColor(ch.done, ch.count) }}>
                    🧹 {ch.done}/{ch.count}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap", fontSize: 13, color: "#7a6f8c" }}>
          <Legend c="#2f7a45" t="Great (80%+)" />
          <Legend c="#b8702a" t="Okay" />
          <Legend c="#c0455c" t="Needs work" />
          <span style={{ color: "#9a8fb0" }}>📚 = questions · 🧹 = chores</span>
        </div>
        {loading && <div style={{ marginTop: 10, color: "#9a8fb0", fontSize: 13 }}>Loading…</div>}
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
function ParentPanel({ parent, setParent, kids, refreshKids, activeKid, setActiveKid, date, unlocked, setUnlocked, onExitParent, onRenamed, onSettingsChanged, familyName, onEnterKidMode }) {
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
          Enter your account password once to manage kids and view answer keys. You won't be asked again until you lock it or sign out.
        </p>
        <input style={input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Account password" onKeyDown={(e) => e.key === "Enter" && tryUnlock()} autoFocus />
        {err && <div style={errBox}>{err}</div>}
        <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={tryUnlock}>
          {busy ? "Checking…" : "Unlock"}
        </button>
        {onExitParent && (
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button onClick={onExitParent} style={{ background: "none", border: "none", color: "#7a6f8c", fontWeight: 700, cursor: "pointer", fontFamily: FONT_DISPLAY, fontSize: 14 }}>
              ← Back to kid view
            </button>
          </div>
        )}
      </div>
    );
  }

  const sections = [
    ["kids", "👧 Kids & Grades"],
    ["categories", "🎯 Subjects"],
    ["chores", "🧹 Chores Setup"],
    ["answers", "🔑 Answer Keys"],
    ["family", "👨‍👩‍👧 Family"],
    ["notifications", "🔔 Notifications"],
    ["account", "⚙️ Account"],
    ...(parent && parent.isAdmin ? [["admin", "🛡️ Admin"], ["logs", "📋 Logs"]] : []),
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <h2 className="sq-h" style={{ ...h2, margin: 0 }}>⚙️ Parent Area</h2>
        <div style={{ display: "flex", gap: 8 }}>
          {onExitParent && (
            <button style={btnGhost} onClick={onExitParent}>← Exit parent mode</button>
          )}
          <button
            style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }}
            onClick={() => { setUnlocked(false); if (onExitParent) onExitParent(); }}
            title="Lock the parent area (will ask for your password next time)"
          >
            🔒 Lock
          </button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {sections.map(([k, l]) => (
          <button key={k} onClick={() => setSection(k)} style={{ ...chip, background: section === k ? "#4a3f5e" : "#fff", color: section === k ? "#fff" : "#4a3f5e", borderColor: section === k ? "#4a3f5e" : "#e3dcec" }}>{l}</button>
        ))}
      </div>

      {section === "kids" && <KidsManager kids={kids} refreshKids={refreshKids} activeKid={activeKid} setActiveKid={setActiveKid} familyName={familyName} onRenamed={onRenamed} onSettingsChanged={onSettingsChanged} />}
      {section === "categories" && <CategoriesManager kids={kids} refreshKids={refreshKids} activeKid={activeKid} setActiveKid={setActiveKid} onSettingsChanged={onSettingsChanged} />}
      {section === "chores" && <ChoresManager kids={kids} activeKid={activeKid} setActiveKid={setActiveKid} />}
      {section === "answers" && <AnswerKey kids={kids} date={date} />}
      {section === "family" && <FamilyManager onRenamed={onRenamed} onEnterKidMode={onEnterKidMode} />}
      {section === "notifications" && <NotificationsManager />}
      {section === "account" && <AccountManager parent={parent} setParent={setParent} />}
      {section === "admin" && parent && parent.isAdmin && <AdminPanel meUsername={parent.username} />}
      {section === "logs" && parent && parent.isAdmin && <LogViewer />}
    </div>
  );
}

/* ------------------------------ family manager -------------------------- */
/* ------------------------- notifications manager ------------------------ */
function NotificationsManager() {
  const [questions, setQuestions] = useState(true);
  const [chores, setChores] = useState(true);
  const [emails, setEmails] = useState([]); // extra recipient emails
  const [newEmail, setNewEmail] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const s = await api.notifySettings();
        setQuestions(s.questions !== false);
        setChores(s.chores !== false);
        setEmails(Array.isArray(s.extraEmails) ? s.extraEmails : []);
      } catch (e) {
        setErr(e.message || "Could not load notification settings.");
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const isEmailish = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());

  const addEmail = () => {
    setErr("");
    const e = newEmail.trim().toLowerCase();
    if (!isEmailish(e)) { setErr("Enter a valid email address."); return; }
    if (emails.includes(e)) { setErr("That email is already on the list."); return; }
    if (emails.length >= 5) { setErr("You can add up to 5 emails."); return; }
    setEmails((arr) => [...arr, e]);
    setNewEmail("");
    setSaved(false);
  };
  const removeEmail = (e) => { setEmails((arr) => arr.filter((x) => x !== e)); setSaved(false); };

  const save = async () => {
    setBusy(true);
    setErr("");
    setSaved(false);
    try {
      await api.saveNotifySettings({ questions, chores, extraEmails: emails });
      setSaved(true);
    } catch (e) {
      setErr(e.message || "Could not save settings.");
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <div className="sq-card" style={panel}><p style={{ color: "#7a6f8c" }}>Loading…</p></div>;

  const Toggle = ({ on, set, label, desc }) => (
    <button
      onClick={() => { set(!on); setSaved(false); }}
      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", background: "#faf8fd", border: "1px solid #efeaf7", borderRadius: 12, padding: "12px 14px", cursor: "pointer", marginBottom: 10 }}
    >
      <span style={{ width: 46, height: 26, borderRadius: 999, background: on ? "#2fa84f" : "#cfc7da", position: "relative", flexShrink: 0, transition: "background .15s" }}>
        <span style={{ position: "absolute", top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,.2)" }} />
      </span>
      <span>
        <span className="sq-h" style={{ fontWeight: 800, color: "#4a3f5e", display: "block" }}>{label}</span>
        <span style={{ fontSize: 13, color: "#7a6f8c" }}>{desc}</span>
      </span>
    </button>
  );

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>🔔 Email Notifications</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>Choose which completion emails to send, and add extra people who should get them. (Email must be configured for these to send.)</p>
      {err && <div style={errBox}>{err}</div>}

      <Toggle on={questions} set={setQuestions} label="📚 Questions finished" desc="Email when a child has answered all of their questions for the day." />
      <Toggle on={chores} set={setChores} label="🧹 Chores finished" desc="Email when a child has completed all of their chores for the day." />

      <div style={{ marginTop: 18 }}>
        <div style={lbl}>Extra notification emails <span style={{ color: "#9a8fb0", fontWeight: 600 }}>(up to 5)</span></div>
        <p style={{ fontSize: 13, color: "#7a6f8c", margin: "0 0 8px" }}>
          These addresses also receive the emails you enabled above. They don't need to verify — make sure they're typed correctly. All logged-in parents in your family always receive them too.
        </p>
        {emails.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
            {emails.map((e) => (
              <div key={e} style={{ display: "flex", alignItems: "center", gap: 8, background: "#f6f3fb", borderRadius: 10, padding: "8px 12px" }}>
                <span style={{ flex: 1, wordBreak: "break-all", fontWeight: 700, color: "#4a3f5e" }}>{e}</span>
                <button style={{ ...miniLink, color: "#e0506b", textDecoration: "none" }} onClick={() => removeEmail(e)}>Remove</button>
              </div>
            ))}
          </div>
        )}
        {emails.length < 5 ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input style={{ ...input, margin: 0, maxWidth: 280 }} type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="grandma@example.com" autoCapitalize="none" onKeyDown={(e) => e.key === "Enter" && addEmail()} />
            <button style={btnGhost} onClick={addEmail}>+ Add email</button>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "#9a8fb0" }}>You've reached the limit of 5 extra emails.</p>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
        <button style={{ ...btnPrimary, marginTop: 0, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save notification settings"}</button>
        {saved && <span style={{ color: "#2fa84f", fontWeight: 700 }}>✓ Saved</span>}
      </div>
    </div>
  );
}

function FamilyManager({ onRenamed, onEnterKidMode }) {
  const [info, setInfo] = useState(null); // { code, name, members }
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [nameBusy, setNameBusy] = useState(false);
  const [kidModeBusy, setKidModeBusy] = useState(false);
  const [kidModeErr, setKidModeErr] = useState("");

  const load = async () => {
    setErr("");
    try {
      const i = await api.familyInfo();
      setInfo(i);
      setNameInput((i && i.name) || "");
    } catch (e) {
      setErr(e.message || "Could not load family info.");
      setInfo({ code: "", name: "", members: [] });
    }
  };
  useEffect(() => {
    load();
  }, []);

  const saveName = async () => {
    setNameSaved(false);
    setNameBusy(true);
    try {
      const r = await api.familyRename(nameInput.trim());
      const newName = (r && r.name) || "";
      setInfo((i) => ({ ...(i || { members: [] }), name: newName }));
      setNameInput(newName);
      setNameSaved(true);
      if (onRenamed) onRenamed(newName); // update the header live
    } catch (e) {
      setErr(e.message || "Could not save the family name.");
    } finally {
      setNameBusy(false);
    }
  };

  const kidsLink = info && info.code ? `${window.location.origin}/?family=${info.code}` : "";
  const inviteLink = info && info.code ? `${window.location.origin}/?invite=${info.code}` : "";

  const copy = async (text, which) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* clipboard may be unavailable; values are shown on screen anyway */
    }
  };

  // Native share sheet (mobile) with clipboard fallback.
  const shareInvite = async () => {
    if (!inviteLink) return;
    const shareData = {
      title: "Join our StudyQuest family",
      text: "You're invited to help manage our kids on StudyQuest. Open this link to log in or create your account — you'll join our family automatically:",
      url: inviteLink,
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* user cancelled or share failed — fall back to copy */
      }
    }
    copy(inviteLink, "invite");
  };

  const regen = async () => {
    if (!confirm("Generate a new family code? The old code AND the current kids' link will stop working — you'll need to re-share the new link and bookmark it again on your kids' tablet.")) return;
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
        Everyone in your family shares the same kids and progress.
      </p>
      {err && <div style={errBox}>{err}</div>}

      {/* Family name */}
      <div style={{ marginBottom: 16 }}>
        <div style={lbl}>🏷️ Family name</div>
        <p style={{ fontSize: 13, color: "#7a6f8c", margin: "0 0 8px" }}>Shown at the top of the app for everyone in your family.</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            style={{ ...input, margin: 0, maxWidth: 280 }}
            value={nameInput}
            onChange={(e) => { setNameInput(e.target.value); setNameSaved(false); }}
            placeholder="e.g. The Smith Family"
            maxLength={40}
            onKeyDown={(e) => e.key === "Enter" && saveName()}
          />
          <button style={{ ...btnPrimary, marginTop: 0, opacity: nameBusy ? 0.6 : 1 }} disabled={nameBusy} onClick={saveName}>
            {nameBusy ? "Saving…" : "Save name"}
          </button>
          {nameSaved && <span style={{ color: "#2fa84f", fontWeight: 700, fontSize: 14 }}>✓ Saved</span>}
        </div>
      </div>

      {/* Kids' no-login link */}
      <div style={{ marginTop: 6, padding: 14, background: "#eef7f0", borderRadius: 14, border: "1px solid #cdeccf" }}>
        <div style={{ ...lbl, marginTop: 0, color: "#2f7a45" }}>🧒 Kids' access link (no password needed)</div>
        <p style={{ fontSize: 13, color: "#4f6f58", margin: "0 0 10px" }}>
          Open this link on your kids' tablet and bookmark it / add it to the home screen. It opens StudyQuest straight
          into your family — no login — so kids never need your password.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <code style={{ flex: 1, minWidth: 200, fontSize: 13, background: "#fff", padding: "10px 12px", borderRadius: 10, color: "#2f7a45", wordBreak: "break-all", border: "1px solid #cdeccf" }}>
            {kidsLink || "…"}
          </code>
          <button style={{ ...btnGhost, borderColor: "#2fa84f", color: "#2f7a45" }} onClick={() => copy(kidsLink, "link")} disabled={!kidsLink}>
            {copied === "link" ? "✓ Copied" : "📋 Copy link"}
          </button>
        </div>
        {onEnterKidMode && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed #cdeccf" }}>
            <p style={{ fontSize: 13, color: "#4f6f58", margin: "0 0 8px" }}>
              <strong>On your child's own tablet?</strong> Tap below to turn <em>this</em> installed app into your kids' app.
              It will open straight to your family every time — no link to copy and no password. You'll log out of the
              parent account on this device (tap the 🔒 lock anytime to log back in).
            </p>
            {kidModeErr && <div style={errBox}>{kidModeErr}</div>}
            <button
              style={{ ...btnPrimary, marginTop: 0, background: "#2fa84f", opacity: kidModeBusy ? 0.6 : 1 }}
              disabled={kidModeBusy}
              onClick={async () => {
                if (!confirm("Turn this device into your kids' app? It will open straight to your family with no login, and you'll be logged out of the parent account here (you can log back in anytime with the lock button).")) return;
                setKidModeErr("");
                setKidModeBusy(true);
                try {
                  await onEnterKidMode();
                } catch (e) {
                  setKidModeErr(e.message || "Could not switch to Kids Mode.");
                  setKidModeBusy(false);
                }
              }}
            >
              {kidModeBusy ? "Switching…" : "🧒 Switch this device to Kids Mode"}
            </button>
          </div>
        )}
      </div>

      {/* Co-parent invite link */}
      <div style={{ marginTop: 18, padding: 14, background: "#eef2fb", borderRadius: 14, border: "1px solid #d3def5" }}>
        <div style={{ ...lbl, marginTop: 0, color: "#3b5b8e" }}>👨‍👩‍👧 Invite another parent</div>
        <p style={{ fontSize: 13, color: "#52688e", margin: "0 0 10px" }}>
          Send this link to another parent. When they open it, they can log in or create an account and they'll
          join your family automatically — no code to type.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button style={{ ...btnPrimary, marginTop: 0, background: "#3b7de8" }} onClick={shareInvite} disabled={!inviteLink}>
            {copied === "invite" ? "✓ Link copied" : "📤 Share invite link"}
          </button>
          <button style={{ ...btnGhost, borderColor: "#3b7de8", color: "#3b5b8e" }} onClick={() => copy(inviteLink, "invite2")} disabled={!inviteLink}>
            {copied === "invite2" ? "✓ Copied" : "📋 Copy link"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
          <code style={{ flex: 1, minWidth: 200, fontSize: 13, background: "#fff", padding: "10px 12px", borderRadius: 10, color: "#3b5b8e", wordBreak: "break-all", border: "1px solid #d3def5" }}>
            {inviteLink || "…"}
          </code>
        </div>
        <div style={{ fontSize: 12, color: "#9aa6bd", marginTop: 8 }}>
          Prefer to share a code instead? The family code is <strong>{info ? info.code || "—" : "…"}</strong>{" "}
          <button onClick={() => copy(info && info.code, "code")} disabled={!info || !info.code} style={{ ...miniLink, marginLeft: 4 }}>{copied === "code" ? "✓ copied" : "copy"}</button>.
          <button onClick={regen} disabled={busy} style={{ ...miniLink, marginLeft: 8, color: "#e0506b" }}>{busy ? "…" : "↻ new code (revokes old link)"}</button>
        </div>
        <div style={{ fontSize: 12, color: "#9aa6bd", marginTop: 6 }}>Treat the link like a password — only share it with people who should see your kids.</div>
      </div>

      <h3 className="sq-h" style={{ fontSize: 18, marginTop: 22, marginBottom: 8 }}>Parents in this family</h3>
      {!info ? (
        <p style={{ color: "#7a6f8c" }}>Loading…</p>
      ) : info.members.length === 0 ? (
        <p style={{ color: "#7a6f8c" }}>Just you so far.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {info.members.map((m) => (
            <div key={m.email} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#f6f3fb", borderRadius: 10 }}>
              <span style={{ fontWeight: 800, fontFamily: FONT_DISPLAY, wordBreak: "break-all" }}>{m.email}</span>
              {m.isYou && <span style={{ fontSize: 12, color: "#2fa84f", fontWeight: 800 }}>· you</span>}
              {m.isAdmin && <span style={{ fontSize: 12, color: "#9b4dca", fontWeight: 800 }}>· admin</span>}
              {!m.verified && !m.isAdmin && <span style={{ fontSize: 12, color: "#b8702a", fontWeight: 800 }}>· unverified</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ account manager ------------------------- */
function AccountManager({ parent, setParent }) {
  // email
  const [email, setEmail] = useState(parent.email || "");
  const [eMsg, setEMsg] = useState("");
  const [eErr, setEErr] = useState("");
  const [eBusy, setEBusy] = useState(false);
  const [reverify, setReverify] = useState(false);
  // password
  const [cur, setCur] = useState("");
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [pMsg, setPMsg] = useState("");
  const [pErr, setPErr] = useState("");
  const [pBusy, setPBusy] = useState(false);

  const isAdmin = !!parent.isAdmin;
  const isEmailish = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

  const saveEmail = async () => {
    setEMsg("");
    setEErr("");
    if (!isEmailish(email)) return setEErr("Enter a valid email address.");
    if (email.trim().toLowerCase() === (parent.email || "").toLowerCase()) return setEErr("That's already your email.");
    if (!confirm("Change your email? You'll need to verify the new address from a link we email you, and you'll be signed out until you do.")) return;
    setEBusy(true);
    try {
      await api.changeEmail(email.trim());
      setReverify(true);
      // changing email makes the account unverified -> sign out after a moment
      setTimeout(() => {
        api.logout();
        window.dispatchEvent(new Event("sq-unauthorized"));
      }, 3500);
    } catch (e) {
      setEErr(e.message || "Could not change email.");
    } finally {
      setEBusy(false);
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
        <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Email</h2>
        {isAdmin ? (
          <p style={{ color: "#7a6f8c" }}>
            You're signed in as the <strong>admin</strong> account. Its email can't be changed.
          </p>
        ) : reverify ? (
          <div style={{ ...errBox, background: "#eef4fb", color: "#3b5b8e" }}>
            We've sent a verification link to <strong>{email.trim()}</strong>. Click it to confirm your new email.
            Signing you out now…
          </div>
        ) : (
          <>
            <input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder="you@example.com" />
            <div style={{ fontSize: 12, color: "#9a8fb0", marginTop: 4 }}>Changing your email requires verifying the new address.</div>
            {eErr && <div style={errBox}>{eErr}</div>}
            {eMsg && <div style={{ ...errBox, background: "#eefaf0", color: "#2fa84f" }}>{eMsg}</div>}
            <button style={{ ...btnPrimary, opacity: eBusy ? 0.6 : 1 }} disabled={eBusy} onClick={saveEmail}>
              {eBusy ? "Saving…" : "Save email"}
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
  const [data, setData] = useState(null); // { users, families }
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [addFor, setAddFor] = useState(null); // familyId we're adding a user to
  const [addEmail, setAddEmail] = useState("");

  const load = async () => {
    setErr("");
    try {
      const r = await api.adminListUsers();
      // adminListUsers returns the array for back-compat; fetch raw for families
      const raw = await apiRequest("admin-list-users");
      setData({ users: (raw && raw.users) || r || [], families: (raw && raw.families) || [] });
    } catch (e) {
      setErr(e.message || "Could not load accounts.");
      setData({ users: [], families: [] });
    }
  };
  useEffect(() => { load(); }, []);

  const sendReset = async (email) => {
    setMsg(""); setErr(""); setBusy("reset:" + email);
    try {
      const r = await api.adminSendReset(email);
      setMsg(r && r.emailConfigured === false
        ? `Email isn't configured, so no message was sent. (Set RESEND_API_KEY / FROM_EMAIL.)`
        : `Sent a password-reset link to ${email}.`);
    } catch (e) {
      setErr(e.message || "Could not send reset email.");
    } finally { setBusy(""); }
  };

  const del = async (u) => {
    if (!confirm(`Delete ${u.email}? This removes their login. If they're the last parent in their family, that family and its kids will also be deleted. This can't be undone.`)) return;
    setMsg(""); setErr(""); setBusy("del:" + u.id);
    try {
      await api.adminDeleteUser(u.id);
      setMsg(`Deleted ${u.email}.`);
      await load();
    } catch (e) {
      setErr(e.message || "Could not delete user.");
    } finally { setBusy(""); }
  };

  const addUser = async (familyId) => {
    setMsg(""); setErr("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addEmail.trim())) { setErr("Enter a valid email address."); return; }
    setBusy("add:" + familyId);
    try {
      const r = await api.adminCreateUser(addEmail.trim(), familyId);
      setMsg(r && r.emailConfigured === false
        ? `Created ${addEmail.trim()}. Email isn't configured, so they couldn't be emailed a set-password link.`
        : `Created ${addEmail.trim()} and emailed them a link to set their password.`);
      setAddEmail(""); setAddFor(null);
      await load();
    } catch (e) {
      setErr(e.message || "Could not add user.");
    } finally { setBusy(""); }
  };

  const cleanup = async () => {
    setMsg(""); setErr(""); setBusy("cleanup");
    try {
      const r = await api.adminCleanupFamilies();
      const n = (r && r.removed) || 0;
      setMsg(n > 0 ? `Removed ${n} orphaned famil${n === 1 ? "y" : "ies"} with no parents.` : "No orphaned families found — everything's clean.");
      await load();
    } catch (e) {
      setErr(e.message || "Could not clean up families.");
    } finally { setBusy(""); }
  };

  if (data === null) return <div className="sq-card" style={panel}><p style={{ color: "#7a6f8c" }}>Loading accounts…</p></div>;

  // group users by family
  const byFamily = {};
  for (const u of data.users) {
    const key = u.isAdmin ? "__admin__" : (u.familyId || "__none__");
    (byFamily[key] = byFamily[key] || []).push(u);
  }
  const familyOrder = data.families.slice().sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  const UserRow = (u) => (
    <div key={u.id || u.email} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0", borderBottom: "1px solid #f5f1fa" }}>
      <span style={{ fontWeight: 700, wordBreak: "break-all" }}>
        {u.email}
        {u.isAdmin && <span style={{ marginLeft: 6, fontSize: 11, color: "#9b4dca", fontWeight: 800 }}>ADMIN</span>}
        {!u.isAdmin && !u.verified && <span style={{ marginLeft: 6, fontSize: 11, color: "#b8702a", fontWeight: 800 }}>unverified</span>}
      </span>
      <div style={{ flex: 1 }} />
      {!u.isAdmin && (
        <>
          <button style={{ ...miniLink, color: "#3b7de8", textDecoration: "none" }} disabled={!!busy} onClick={() => sendReset(u.email)}>
            {busy === "reset:" + u.email ? "Sending…" : "✉️ Send reset link"}
          </button>
          <button style={{ ...miniLink, color: "#e0506b", textDecoration: "none" }} disabled={!!busy} onClick={() => del(u)}>
            {busy === "del:" + u.id ? "Deleting…" : "🗑️ Delete"}
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>🛡️ Admin · Users by Family</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>
        Add or remove parents per family. For security, you can't set passwords directly — use “Send reset link” (or adding a user emails them a set-password link). Passwords are only ever set by the user from their emailed link.
      </p>
      <div style={{ marginBottom: 12 }}>
        <button style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }} disabled={!!busy} onClick={cleanup}>
          {busy === "cleanup" ? "Cleaning…" : "🧹 Clean up orphaned families"}
        </button>
        <span style={{ fontSize: 12, color: "#9a8fb0", marginLeft: 8 }}>Families with no parents are also removed automatically.</span>
      </div>
      {err && <div style={errBox}>{err}</div>}
      {msg && <div style={{ ...errBox, background: "#eefaf0", color: "#2fa84f" }}>{msg}</div>}

      {/* Admin account */}
      {byFamily["__admin__"] && (
        <div style={{ marginTop: 8, marginBottom: 16 }}>
          <div style={{ ...lbl, marginTop: 0, color: "#9b4dca" }}>🛡️ Admin account</div>
          {byFamily["__admin__"].map(UserRow)}
        </div>
      )}

      {/* Each family */}
      {familyOrder.length === 0 && <p style={{ color: "#9a8fb0" }}>No families yet.</p>}
      {familyOrder.map((fam) => {
        const members = byFamily[fam.id] || [];
        return (
          <div key={fam.id} style={{ marginBottom: 18, padding: 14, background: "#faf8fd", borderRadius: 14, border: "1px solid #efeaf7" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div className="sq-h" style={{ fontWeight: 800, color: "#4a3f5e" }}>
                {fam.name || "(unnamed family)"} <span style={{ fontSize: 12, color: "#9a8fb0", fontWeight: 700 }}>· {members.length} parent{members.length === 1 ? "" : "s"}</span>
              </div>
              <code style={{ fontSize: 12, color: "#7a6f8c", background: "#fff", padding: "3px 8px", borderRadius: 6 }}>{fam.code}</code>
            </div>
            {members.length === 0 ? (
              <p style={{ color: "#c0455c", fontSize: 13, margin: "8px 0 0" }}>No parents (orphaned family).</p>
            ) : (
              <div style={{ marginTop: 6 }}>{members.map(UserRow)}</div>
            )}
            {addFor === fam.id ? (
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input style={{ ...input, margin: 0, maxWidth: 240 }} type="email" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="parent@example.com" autoFocus autoCapitalize="none" onKeyDown={(e) => e.key === "Enter" && addUser(fam.id)} />
                <button style={{ ...btnPrimary, marginTop: 0, opacity: busy ? 0.6 : 1 }} disabled={!!busy} onClick={() => addUser(fam.id)}>{busy === "add:" + fam.id ? "Adding…" : "Add & email link"}</button>
                <button style={btnGhost} onClick={() => { setAddFor(null); setAddEmail(""); }}>Cancel</button>
              </div>
            ) : (
              <button style={{ ...btnGhost, marginTop: 10 }} onClick={() => { setAddFor(fam.id); setAddEmail(""); setMsg(""); setErr(""); }}>+ Add parent to this family</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------- log viewer ------------------------------ */
const LOG_LEVEL_META = {
  error: { color: "#c0455c", bg: "#fdecef", label: "ERROR" },
  warn: { color: "#b8702a", bg: "#fdf3e7", label: "WARN" },
  info: { color: "#3b5b8e", bg: "#eef2fb", label: "INFO" },
  verbose: { color: "#2f7a45", bg: "#eef7f0", label: "VERBOSE" },
  debug: { color: "#6a5f7e", bg: "#f3eefb", label: "DEBUG" },
};

function LogViewer() {
  const todayKeyLocal = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [level, setLevel] = useState("debug"); // include this and more severe
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [username, setUsername] = useState("");
  const [family, setFamily] = useState("");
  const [text, setText] = useState("");
  const [entries, setEntries] = useState(null);
  const [meta, setMeta] = useState({ scanned: 0, activeLevel: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState({}); // ts -> bool

  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.adminLogs({ level, from, to, username, family, text, limit: 300 });
      setEntries((r && r.entries) || []);
      setMeta({ scanned: (r && r.scanned) || 0, activeLevel: (r && r.activeLevel) || "" });
    } catch (e) {
      setErr(e.message || "Could not load logs.");
      setEntries([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearOld = async () => {
    const cutoff = prompt("Delete logs OLDER THAN which date? (YYYY-MM-DD). Leave blank and press OK to delete ALL logs.", "");
    if (cutoff === null) return; // cancelled
    if (cutoff && !/^\d{4}-\d{2}-\d{2}$/.test(cutoff.trim())) {
      alert("Please use YYYY-MM-DD format.");
      return;
    }
    if (!cutoff && !confirm("Delete ALL logs? This cannot be undone.")) return;
    setBusy(true);
    try {
      const r = await api.adminLogClear(cutoff.trim() || undefined);
      alert(`Removed ${r && r.removed != null ? r.removed : 0} log entries.`);
      await run();
    } catch (e) {
      setErr(e.message || "Could not clear logs.");
    } finally {
      setBusy(false);
    }
  };

  const fmtTime = (iso) => {
    try {
      return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return iso;
    }
  };

  const setQuick = (days) => {
    const end = todayKeyLocal();
    const d = new Date();
    d.setDate(d.getDate() - days);
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setFrom(start);
    setTo(end);
  };

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>📋 Event Logs</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>
        Troubleshoot issues and workflows. Filter by level, date, family, or username. Currently persisting level: <strong>{meta.activeLevel || "info"}</strong> and above.
      </p>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <label style={{ fontSize: 13, color: "#6a5f7e", fontWeight: 700 }}>
          Level (and worse)
          <select style={{ ...input, margin: "4px 0 0", maxWidth: 150 }} value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="error">Error</option>
            <option value="warn">Warn & up</option>
            <option value="info">Info & up</option>
            <option value="verbose">Verbose & up</option>
            <option value="debug">Debug (all)</option>
          </select>
        </label>
        <label style={{ fontSize: 13, color: "#6a5f7e", fontWeight: 700 }}>
          From
          <input type="date" style={{ ...input, margin: "4px 0 0", maxWidth: 160 }} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: 13, color: "#6a5f7e", fontWeight: 700 }}>
          To
          <input type="date" style={{ ...input, margin: "4px 0 0", maxWidth: 160 }} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label style={{ fontSize: 13, color: "#6a5f7e", fontWeight: 700 }}>
          Username / email
          <input style={{ ...input, margin: "4px 0 0", maxWidth: 200 }} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="contains…" autoCapitalize="none" />
        </label>
        <label style={{ fontSize: 13, color: "#6a5f7e", fontWeight: 700 }}>
          Family (id or name)
          <input style={{ ...input, margin: "4px 0 0", maxWidth: 180 }} value={family} onChange={(e) => setFamily(e.target.value)} placeholder="contains…" />
        </label>
        <label style={{ fontSize: 13, color: "#6a5f7e", fontWeight: 700 }}>
          Text
          <input style={{ ...input, margin: "4px 0 0", maxWidth: 180 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="message contains…" />
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <button style={{ ...btnPrimary, marginTop: 0, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={run}>{busy ? "Loading…" : "🔍 Search"}</button>
        <button style={btnGhost} onClick={() => setQuick(0)}>Today</button>
        <button style={btnGhost} onClick={() => setQuick(7)}>Last 7 days</button>
        <button style={btnGhost} onClick={() => { setFrom(""); setTo(""); setUsername(""); setFamily(""); setText(""); setLevel("debug"); }}>Clear filters</button>
        <div style={{ flex: 1 }} />
        <button style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }} onClick={clearOld} disabled={busy}>🗑️ Clear logs…</button>
      </div>

      {err && <div style={errBox}>{err}</div>}

      {entries === null ? (
        <p style={{ color: "#9a8fb0" }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: "#9a8fb0" }}>No log entries match these filters.</p>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "#9a8fb0", marginBottom: 8 }}>
            Showing {entries.length} {entries.length === 1 ? "entry" : "entries"} (scanned {meta.scanned}). Newest first.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {entries.map((e, i) => {
              const m = LOG_LEVEL_META[e.level] || LOG_LEVEL_META.info;
              const hasDetails = e.details && Object.keys(e.details).length > 0;
              const key = `${e.ts}-${i}`;
              const open = expanded[key];
              return (
                <div key={key} style={{ border: "1px solid #f0ecf6", borderRadius: 10, padding: "8px 10px", background: "#fff" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: m.color, background: m.bg, padding: "2px 7px", borderRadius: 6, minWidth: 54, textAlign: "center" }}>{m.label}</span>
                    <span style={{ fontSize: 12, color: "#9a8fb0", fontFamily: "monospace" }}>{fmtTime(e.iso)}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#6a5f7e" }}>{e.event}</span>
                    <span style={{ flex: 1, minWidth: 120, fontSize: 13, color: "#3b3350", wordBreak: "break-word" }}>{e.message}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12, marginTop: 4, flexWrap: "wrap", fontSize: 11, color: "#9a8fb0" }}>
                    {e.username && <span>👤 {e.username}</span>}
                    {e.fid && <span>👨‍👩‍👧 {e.fid}</span>}
                    {e.status != null && <span>HTTP {e.status}</span>}
                    {e.requestId && <span>req {e.requestId}</span>}
                    {hasDetails && (
                      <button onClick={() => setExpanded((x) => ({ ...x, [key]: !open }))} style={{ ...miniLink }}>
                        {open ? "hide details" : "details"}
                      </button>
                    )}
                  </div>
                  {open && hasDetails && (
                    <pre style={{ margin: "8px 0 0", padding: 8, background: "#f6f3fb", borderRadius: 8, fontSize: 11, color: "#4a3f5e", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {JSON.stringify(e.details, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------- categories manager -------------------------- */
function CategoriesManager({ kids, refreshKids, activeKid, setActiveKid, onSettingsChanged }) {
  const kid = kids.find((k) => k.id === activeKid) || kids[0] || null;

  // local editable copy of THIS kid's category prefs
  const [selected, setSelected] = useState({}); // { subject: [names] }
  const [custom, setCustom] = useState({}); // { subject: [names] }
  const [counts, setCounts] = useState({}); // { subject: number (0-20) }
  const [newCustom, setNewCustom] = useState({}); // { subject: "typing..." }
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadedForRef = useRef(null); // which kid id the local state currently reflects

  // Load a kid's stored prefs into local state. Defaults to everything selected.
  // Runs only when the SELECTED KID changes (by id), so editing/saving one kid
  // never disturbs another, and a save doesn't surprise-reset your view.
  useEffect(() => {
    const id = kid && kid.id;
    if (!id || loadedForRef.current === id) return;
    loadedForRef.current = id;
    const cats = (kid && kid.categories) || null;
    const kidCounts = (kid && kid.counts) || null;
    const sel = {};
    const cus = {};
    const cnt = {};
    for (const s of SUBJECTS) {
      const builtIn = SUBJECT_CATEGORIES[s.key] || [];
      cus[s.key] = (cats && cats.custom && cats.custom[s.key]) ? cats.custom[s.key].slice() : [];
      const stored = cats && cats.selected && cats.selected[s.key];
      // default: everything (built-in + this kid's custom) selected
      sel[s.key] = Array.isArray(stored) ? stored.slice() : [...builtIn, ...cus[s.key]];
      const c = kidCounts && kidCounts[s.key];
      // null/undefined/"" means "not set". For a brand-new kid (no saved counts
      // at all), default subjects start at 10 and the rest at 0; once any counts
      // are saved, an unset subject is off (0). An explicit number is used as-is.
      const hasAnyCounts = kidCounts && Object.keys(kidCounts).length > 0;
      const dflt = hasAnyCounts ? 0 : (DEFAULT_SUBJECTS.includes(s.key) ? 10 : 0);
      cnt[s.key] = c == null || c === "" ? dflt : Math.max(0, Math.min(20, Math.round(Number(c)) || 0));
    }
    setSelected(sel);
    setCustom(cus);
    setCounts(cnt);
    setSaved(false);
  }, [kid && kid.id]);

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

  const setCount = (subject, val) => {
    setSaved(false);
    let n = parseInt(val, 10);
    if (!Number.isFinite(n)) n = 0;
    n = Math.max(0, Math.min(20, n));
    setCounts((c) => ({ ...c, [subject]: n }));
  };

  // Subjects are freely chosen (1–10). A subject is "on" when its count >= 1.
  const chosenCount = () => SUBJECTS.filter((s) => (counts[s.key] ?? 0) > 0).length;
  const enableSubject = (key) => {
    if (chosenCount() >= MAX_SUBJECTS) return;
    setSaved(false);
    setCounts((c) => ({ ...c, [key]: 10 }));
    // make sure topics are selected (default to all built-in for this subject)
    setSelected((s) => ({ ...s, [key]: s[key] && s[key].length ? s[key] : [...(SUBJECT_CATEGORIES[key] || [])] }));
  };
  const disableSubject = (key) => {
    if (chosenCount() <= MIN_SUBJECTS) return; // keep at least one subject on
    setSaved(false);
    setCounts((c) => ({ ...c, [key]: 0 }));
  };

  const save = async () => {
    if (!kid) return;
    setBusy(true);
    try {
      const ks = await api.updateKid(kid.id, { categories: { selected, custom }, counts });
      await refreshKids(ks);
      // Apply the new settings to questions: top up today's set if counts grew
      // (keeping existing answers), and clear untouched future days so they
      // regenerate with the new categories/counts.
      const updatedKid = ks.find((k) => k.id === kid.id) || { ...kid, categories: { selected, custom }, counts };
      if (onSettingsChanged) await onSettingsChanged(updatedKid);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Subjects</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>
        Choose between {MIN_SUBJECTS} and {MAX_SUBJECTS} subjects for {kid ? kid.name : "this child"}, pick the topics within each, and set how many questions each subject gets per day (1–20). Changes apply to the next day's set.
      </p>
      <KidPicker kids={kids} activeKid={kid ? kid.id : null} setActiveKid={setActiveKid} />

      {/* Subject chooser: turn any of the subjects on/off (1–10). */}
      <div style={{ marginTop: 6, marginBottom: 6, padding: 14, background: "#faf8fd", borderRadius: 12, border: "1px solid #efeaf7" }}>
        <div className="sq-h" style={{ fontWeight: 800, color: "#4a3f5e", marginBottom: 4 }}>
          Choose subjects <span style={{ fontSize: 13, color: "#9a8fb0", fontWeight: 600 }}>({chosenCount()}/{MAX_SUBJECTS})</span>
        </div>
        <p style={{ fontSize: 13, color: "#7a6f8c", margin: "0 0 8px" }}>Tap to turn a subject on or off. At least {MIN_SUBJECTS} must stay on.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {SUBJECTS.map((s) => {
            const on = (counts[s.key] ?? 0) > 0;
            const lockOff = on && chosenCount() <= MIN_SUBJECTS; // can't turn off the last one
            return (
              <button
                key={s.key}
                onClick={() => (on ? disableSubject(s.key) : enableSubject(s.key))}
                disabled={(!on && chosenCount() >= MAX_SUBJECTS) || lockOff}
                title={lockOff ? `Keep at least ${MIN_SUBJECTS} subject` : on ? `Turn off ${s.key}` : `Turn on ${s.key}`}
                style={{
                  ...chip,
                  fontSize: 13,
                  padding: "8px 14px",
                  background: on ? s.color : "#fff",
                  color: on ? "#fff" : s.color,
                  borderColor: s.color,
                  opacity: (!on && chosenCount() >= MAX_SUBJECTS) ? 0.4 : 1,
                  cursor: lockOff ? "default" : "pointer",
                }}
              >
                {on ? "✓ " : "+ "}{s.key}
              </button>
            );
          })}
        </div>
      </div>

      {/* Per-subject topics + question count, for the chosen subjects only. */}
      {SUBJECTS.filter((s) => (counts[s.key] ?? 0) > 0).map((s) => {
        const builtIn = SUBJECT_CATEGORIES[s.key] || [];
        const customCats = custom[s.key] || [];
        const all = [...builtIn, ...customCats];
        const sel = new Set(selected[s.key] || []);
        const allowCustom = true; // custom topics now allowed for every subject, including Math
        return (
          <div key={s.key} style={{ padding: "14px 0", borderBottom: "1px solid #f0ecf6" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <h3 className="sq-h" style={{ margin: 0, fontSize: 18, color: s.color }}>{s.key}</h3>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#7a6f8c", fontWeight: 700 }}>
                  Questions/day:
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={counts[s.key] ?? 10}
                    onChange={(e) => setCount(s.key, e.target.value)}
                    style={{ ...input, margin: 0, width: 64, padding: "6px 8px", textAlign: "center" }}
                  />
                </label>
                <button
                  title={chosenCount() <= MIN_SUBJECTS ? `Keep at least ${MIN_SUBJECTS} subject` : `Remove ${s.key}`}
                  onClick={() => disableSubject(s.key)}
                  disabled={chosenCount() <= MIN_SUBJECTS}
                  style={{ border: "none", background: "none", color: chosenCount() <= MIN_SUBJECTS ? "#d8cfe4" : "#e0506b", cursor: chosenCount() <= MIN_SUBJECTS ? "default" : "pointer", fontWeight: 800, fontSize: 16 }}
                >
                  ✕
                </button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "#9a8fb0", marginBottom: 6, fontWeight: 700 }}>Topics</div>
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
                        title="Remove custom topic"
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
          {busy ? "Saving…" : "Save subjects"}
        </button>
        {saved && <span style={{ color: "#2fa84f", fontWeight: 700 }}>✓ Saved</span>}
      </div>
      <p style={{ fontSize: 12, color: "#9a8fb0", marginTop: 12 }}>
        ✦ Custom topics are created fresh by the AI teacher and need an internet connection. If a child has no
        topics selected for a subject, all topics are used.
      </p>
    </div>
  );
}

function KidsManager({ kids, refreshKids, activeKid, setActiveKid, familyName, onRenamed, onSettingsChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false); // show the add-a-kid wizard
  // Local authoritative copy of the list. We update it DIRECTLY from each API
  // response so the visible list changes the instant the server replies,
  // independent of parent re-render timing. Also kept in sync if props change.
  const [rows, setRows] = useState(kids);
  const [names, setNames] = useState({}); // name edit buffer (save on blur)

  useEffect(() => {
    setRows(kids);
    const map = {};
    kids.forEach((k) => (map[k.id] = k.name));
    setNames(map);
  }, [kids]);

  // apply a server-returned array everywhere: local list + name buffer + app
  const applyList = (ks) => {
    setRows(ks);
    const map = {};
    ks.forEach((k) => (map[k.id] = k.name));
    setNames(map);
    refreshKids(ks); // propagate to header switcher + the rest of the app
  };

  const commitName = async (id) => {
    const newName = (names[id] || "").trim();
    const current = rows.find((k) => k.id === id);
    if (!current || !newName || newName === current.name) return;
    setErr("");
    try {
      const ks = await api.updateKid(id, { name: newName });
      applyList(ks);
    } catch (e) {
      setErr(e.message || "Could not rename child.");
    }
  };

  const updateGrade = async (id, g) => {
    setErr("");
    try {
      const ks = await api.updateKid(id, { grade: Number(g) });
      applyList(ks);
    } catch (e) {
      setErr(e.message || "Could not update grade.");
    }
  };

  const remove = async (id) => {
    if (!confirm("Remove this child and all of their saved questions and chores? This cannot be undone.")) return;
    setErr("");
    try {
      const ks = await api.deleteKid(id);
      applyList(ks);
      if (activeKid === id) setActiveKid(ks[0]?.id || null);
    } catch (e) {
      setErr(e.message || "Could not remove child.");
    }
  };

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Kids & Grade Levels</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>Grade level sets the difficulty of generated questions. Everyone in your family sees these kids.</p>
      {err && <div style={errBox}>{err}</div>}

      {rows.length === 0 && <p style={{ color: "#9a8fb0" }}>No kids yet — add one below.</p>}

      {rows.map((k) => (
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

      <div style={{ marginTop: 18 }}>
        {adding ? (
          <div style={{ padding: 4 }}>
            <OnboardingWizard
              startStep={1}
              refreshKids={refreshKids}
              setActiveKid={setActiveKid}
              familyName={familyName}
              onRenamed={onRenamed}
              onDone={(newKidId, ks) => {
                setAdding(false);
                if (Array.isArray(ks)) applyList(ks);
                if (newKidId) setActiveKid(newKidId);
              }}
            />
          </div>
        ) : (
          <div style={{ padding: 16, background: "#f6f3fb", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div>
              <h3 className="sq-h" style={{ margin: "0 0 4px", fontSize: 18 }}>Add a child</h3>
              <p style={{ color: "#7a6f8c", margin: 0, fontSize: 14 }}>Set their grade, topics, question counts, and chores — then their questions are created.</p>
            </div>
            <button style={{ ...btnPrimary, marginTop: 0 }} onClick={() => { setErr(""); setAdding(true); }}>+ Add a child</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChoresManager({ kids, activeKid, setActiveKid }) {
  const [chores, setChores] = useState([]);
  const [title, setTitle] = useState("");
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

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

  // Move a chore from one position to another (used by both drag and arrows).
  const move = (from, to) => {
    if (from === to || from < 0 || to < 0 || from >= chores.length || to >= chores.length) return;
    const next = chores.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    save(next);
  };

  const onDrop = (to) => {
    if (dragIndex != null) move(dragIndex, to);
    setDragIndex(null);
    setOverIndex(null);
  };

  if (!kids.length) return <div className="sq-card" style={panel}><p style={{color:"#7a6f8c"}}>Add a child first.</p></div>;

  return (
    <div className="sq-card" style={panel}>
      <h2 className="sq-h" style={{ ...h2, marginTop: 0 }}>Chores Setup</h2>
      <p style={{ color: "#7a6f8c", marginTop: -8 }}>Pick which days each chore should appear. Drag the ⠿ handle (or use the ↑ ↓ arrows) to reorder. Kids only see a chore on its days.</p>
      <KidPicker kids={kids} activeKid={activeKid} setActiveKid={setActiveKid} />
      {chores.map((c, idx) => {
        const days = Array.isArray(c.days) ? c.days : ALL_DAYS;
        const isOver = overIndex === idx && dragIndex !== null && dragIndex !== idx;
        return (
          <div
            key={c.id}
            onDragOver={(e) => { e.preventDefault(); if (overIndex !== idx) setOverIndex(idx); }}
            onDrop={() => onDrop(idx)}
            style={{
              padding: "12px 0",
              borderBottom: "1px solid #f0ecf6",
              borderTop: isOver ? "2px solid #4a3f5e" : "2px solid transparent",
              opacity: dragIndex === idx ? 0.5 : 1,
              background: isOver ? "#f6f3fb" : "transparent",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span
                draggable
                onDragStart={() => setDragIndex(idx)}
                onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                title="Drag to reorder"
                style={{ cursor: "grab", color: "#bcb2cf", fontSize: 18, padding: "0 4px", userSelect: "none", touchAction: "none" }}
              >
                ⠿
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <button
                  onClick={() => move(idx, idx - 1)}
                  disabled={idx === 0}
                  title="Move up"
                  style={{ border: "none", background: "none", cursor: idx === 0 ? "default" : "pointer", color: idx === 0 ? "#d8d0e6" : "#7a6f8c", fontSize: 12, lineHeight: 1, padding: 0 }}
                >
                  ▲
                </button>
                <button
                  onClick={() => move(idx, idx + 1)}
                  disabled={idx === chores.length - 1}
                  title="Move down"
                  style={{ border: "none", background: "none", cursor: idx === chores.length - 1 ? "default" : "pointer", color: idx === chores.length - 1 ? "#d8d0e6" : "#7a6f8c", fontSize: 12, lineHeight: 1, padding: 0 }}
                >
                  ▼
                </button>
              </div>
              <input style={{ ...input, margin: 0, flex: 1 }} value={c.title} onChange={(e) => edit(c.id, e.target.value)} />
              <button style={{ ...btnGhost, borderColor: "#e0506b", color: "#e0506b" }} onClick={() => remove(c.id)}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center", paddingLeft: 30 }}>
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
