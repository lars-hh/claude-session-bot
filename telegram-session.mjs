#!/usr/bin/env node
// Session-Bot v8 (LXC 112) — steuert Claude-Code-Sessions per Telegram.
// Abgeleitet von AlphaGenX/claude-telegram-session-bot v6.1 (MIT), mit sechs Korrekturen:
//   1. MODI.standard: "default" existiert nicht mehr -> "manual"
//   2. CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT statt MCP_TOOL_TIMEOUT (der echte Killer)
//   3. is_error wird geprüft — claude -p liefert bei API-Fehlern Exit 0 UND subtype:"success"
//   4. BOT_TOKEN/CHAT_ID werden aus der Claude-Subprozess-Env gestrippt
//   5. Permission-Relay über Dateien statt direktem Telegram-Call im MCP (Token bleibt hier)
//   6. Pfade auf User claude statt root
// v8 (2026-09-05) — Ausbaustufen 1 und 2 aus dem Grill vom 2026-09-04:
//   B1 /neu <repo> klont, registriert und startet in einem Zug; unscharfe Namenssuche
//   B2 Branch + PR als Default für jedes Projekt, /direkt als Ausnahme pro Session
//   B5 Warteschlange persistent, beim Start Rückfrage mit Ein-Klick-Wiederaufnahme
//   B6 Timeout 30 Min -> 2 h, Abbruch wird als Zwischenstand gemeldet
//   B7 Capability-Ping an healthchecks.io (nur bei is_error: false)
//   dazu /compact (verifiziert: komprimiert per --resume wirklich)
// Befehle: /neu [repo|projekt|/pfad] [Auftrag], /projekte [add|scan], /direkt, /compact,
//          /modus, /modell, /sessions, /wechsel N, /status, /clear, /ende
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = Number(process.env.CHAT_ID);
if (!TOKEN || !CHAT_ID) { console.error("BOT_TOKEN und CHAT_ID müssen gesetzt sein"); process.exit(1); }
const API = `https://api.telegram.org/bot${TOKEN}`;

const HOME = "/home/claude";
const REG = `${HOME}/.claude-sessions.json`;
const PROJ = `${HOME}/.config/claude-projekte.json`;
const REPOS = `${HOME}/.config/claude-repos.json`;
const PERM_DIR = `${HOME}/.perm`;
const DEFAULT_CWD = `${HOME}/work`;
const DEFAULT_MODE = "bypassPermissions"; // Lars-Entscheidung 2026-09-04, Blast-Radius akzeptiert
const WORK_ROOT = `${HOME}/work`;         // hier entstehen Projekte; /projekte findet sie selbst
const CLAUDE = "/usr/bin/claude";
const HOST = "192.168.1.139";
const GH_USER = "lars-hh";
// B6: 30 Min reichen für ein echtes Refactoring nicht. Ein Abbruch ist ein Zwischenstand,
// kein Totalverlust — der Branch bleibt, der PR wird trotzdem geöffnet.
const RUN_TIMEOUT = 7200000;              // 2 h
const REPO_CACHE_TTL = 6 * 3600 * 1000;   // 6 h
// B7: Capability-Ping. Leer = unscharf; das wird laut protokolliert, nicht still verschluckt
// (Muster aus dem Dead-Man-Switch-Runbook des Proxmox-Hosts).
const HC_URL = (process.env.HC_URL || "").trim();
const HC_INTERVAL = 30 * 60 * 1000;

// Korrektur 4: Token und Chat-ID NICHT an den Claude-Subprozess weiterreichen.
// Sonst kann ein per Prompt Injection gekaperter Agent den Bot-Token lesen und an
// beliebige chat_id senden — mit Firewall-Regeln nicht zu verhindern.
const { BOT_TOKEN: _t, CHAT_ID: _c, HC_URL: _h, ...SAFE_ENV } = process.env;
const ENV = {
  ...SAFE_ENV,
  HOME,
  PERM_DIR,
  // Korrektur 2: MCP_TOOL_TIMEOUT ist der Startup-Timeout. Der Killer bei langen
  // Freigabe-Wartezeiten ist der Idle-Timeout (Default 1800s bei stdio-Servern).
  CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "1800000",
  PATH: `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
};

// Korrektur 1: "default" ist als permission-mode nicht mehr gültig.
// Gültig: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan
const MODI = { standard: "manual", edits: "acceptEdits", plan: "plan", auto: "auto", voll: "bypassPermissions" };
const modusName = (wert) => (Object.entries(MODI).find(([, v]) => v === (wert || DEFAULT_MODE)) || ["voll"])[0];

const MODELLE = { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };
const modellName = (wert) => (Object.entries(MODELLE).find(([, v]) => v === wert) || ["standard"])[0];

const LEER = { sessions: [], aktiv: null, naechstesCwd: null, naechsterModus: null, naechstesModell: null, naechsterDirekt: false, warteschlange: [], laufend: null };
const load = () => { try { return { ...LEER, ...JSON.parse(readFileSync(REG, "utf8")) }; } catch { return { ...LEER }; } };
const save = (r) => writeFileSync(REG, JSON.stringify(r, null, 2), { mode: 0o600 });
// Immer frisch laden, ändern, schreiben. pump() und die Nachrichtenschleife laufen
// nebenläufig — ein festgehaltenes reg-Objekt würde die Warteschlange überschreiben.
const mutate = (fn) => { const r = load(); const res = fn(r); save(r); return res; };
const loadProj = () => { try { return JSON.parse(readFileSync(PROJ, "utf8")); } catch { return { work: DEFAULT_CWD }; } };
const saveProj = (p) => writeFileSync(PROJ, JSON.stringify(p, null, 2), { mode: 0o600 });
const kurz = (cwd) => {
  const c = cwd || DEFAULT_CWD;
  const hit = Object.entries(loadProj()).find(([, v]) => v === c);
  return hit ? hit[0] : c.split("/").filter(Boolean).pop();
};
const wann = (t) => new Date(t).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const DAUER = "Antwort kommt meist unter einer Minute, größere Aufträge brauchen länger.";
const log = (...a) => console.log(new Date().toISOString(), ...a);
const fehler = (...a) => console.error(new Date().toISOString(), ...a);

async function tg(method, body) {
  try {
    const r = await fetch(`${API}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { fehler("TG:", (e && e.message) || e); return null; }
}

// ---------------------------------------------------------------------------
// Markdown -> Telegram-HTML. Claude antwortet in Markdown; ohne parse_mode stehen
// **Sternchen** und ## Rauten roh im Chat. HTML statt MarkdownV2, weil MarkdownV2
// ein Dutzend Zeichen escapen verlangt und bei einem einzigen unbalancierten
// Zeichen die ganze Nachricht ablehnt.
// ---------------------------------------------------------------------------
const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function mdZuHtml(s) {
  const halde = [];
  // Platzhalter mit NUL geklammert, nicht mit Leerzeichen: sonst würde beim
  // Zurücksetzen auch normaler Text wie "in 5 Minuten" als Platzhalter gelesen.
  const parken = (html) => { halde.push(html); return `\u0000${halde.length - 1}\u0000`; };
  // Code zuerst herausnehmen, damit darin kein Markdown angewendet wird
  s = String(s).replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (m, code) => parken(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (m, code) => parken(`<code>${esc(code)}</code>`));
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1<i>$2</i>");
  // Überschriften nach dem Fettdruck, sonst entsteht <b> in <b>
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/gm, (m, t) => `<b>${t.replace(/<\/?b>/g, "").trim()}</b>`);
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => halde[Number(i)]);
}

// Ein halbes Tag am Stückende lässt Telegram die ganze Nachricht ablehnen.
const ausgewogen = (h) => ["b", "i", "code", "pre", "a", "s", "u"].every((t) =>
  (h.match(new RegExp(`<${t}(?:\\s[^>]*)?>`, "g")) || []).length === (h.match(new RegExp(`</${t}>`, "g")) || []).length);

// An Zeilengrenzen teilen, damit Formatierung möglichst selten zerschnitten wird.
function teilen(s, max) {
  const raus = [];
  let jetzt = "";
  for (const zeile of String(s).split("\n")) {
    if (zeile.length > max) {
      if (jetzt) { raus.push(jetzt); jetzt = ""; }
      for (let i = 0; i < zeile.length; i += max) raus.push(zeile.slice(i, i + max));
      continue;
    }
    if (jetzt && (jetzt.length + 1 + zeile.length) > max) { raus.push(jetzt); jetzt = zeile; }
    else jetzt = jetzt ? jetzt + "\n" + zeile : zeile;
  }
  if (jetzt) raus.push(jetzt);
  return raus.length ? raus : [""];
}

async function send(text, extra) {
  let s = String(text ?? "").trim() || "(leere Antwort)";
  if (s.length > 15200) s = s.slice(0, 15200) + "\n[gekürzt]";
  const stuecke = teilen(s, 3500);
  let letzte = null;
  for (let i = 0; i < stuecke.length; i++) {
    const zusatz = i === stuecke.length - 1 ? extra || {} : {};
    const html = mdZuHtml(stuecke[i]);
    if (ausgewogen(html)) {
      letzte = await tg("sendMessage", { chat_id: CHAT_ID, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...zusatz });
      if (letzte?.ok) continue;
      fehler("HTML abgelehnt, sende roh:", (letzte && letzte.description) || "");
    }
    // Fallback: lieber unformatiert ankommen als formatiert verschwinden
    letzte = await tg("sendMessage", { chat_id: CHAT_ID, text: stuecke[i], ...zusatz });
  }
  return letzte;
}

// ---------------------------------------------------------------------------
// Kleine Prozess-Helfer
// ---------------------------------------------------------------------------
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: opts.cwd, env: ENV,
      timeout: opts.timeout ?? 120000,
      maxBuffer: 8 * 1024 * 1024,
    }, (e, out, err) => resolve({
      ok: !e,
      out: String(out || "").trim(),
      err: String(err || "").trim() || String((e && e.message) || ""),
    }));
  });
}
const git = (cwd, ...args) => sh("git", ["-C", cwd, ...args]);
const istGit = (cwd) => { try { return existsSync(`${cwd}/.git`); } catch { return false; } };
const kurzId = () => randomBytes(3).toString("hex");

// ---------------------------------------------------------------------------
// Wartende Entscheidungen (Buttons). Ein Mechanismus für drei Fälle:
// mehrdeutiger Repo-Name, schmutziger Klon, verlorene Warteschlange.
// ---------------------------------------------------------------------------
const wartend = new Map(); // id -> { typ, ...daten, ts }
function frage(daten) {
  const id = kurzId();
  wartend.set(id, { ...daten, ts: Date.now() });
  for (const [k, v] of wartend) if (Date.now() - v.ts > 24 * 3600 * 1000) wartend.delete(k);
  return id;
}
const knopf = (text, id, wahl) => ({ text, callback_data: `act:${id}:${wahl}` });

// ---------------------------------------------------------------------------
// Korrektur 5: Permission-Relay. Der MCP legt <id>.req ab und kennt keinen Token.
// Dieser Watcher verschickt die Anfrage und schreibt die Antwort als <id> zurück.
// ---------------------------------------------------------------------------
const permMsg = new Map(); // id -> message_id
async function permWatch() {
  try {
    mkdirSync(PERM_DIR, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(PERM_DIR)) {
      if (f.endsWith(".req.expired")) {
        const id = f.slice(0, -".req.expired".length);
        const mid = permMsg.get(id);
        if (mid) {
          await tg("editMessageText", { chat_id: CHAT_ID, message_id: mid, text: "ABGELAUFEN - keine Antwort in der Frist, automatisch abgelehnt." });
          permMsg.delete(id);
        }
        try { unlinkSync(`${PERM_DIR}/${f}`); unlinkSync(`${PERM_DIR}/${id}.req`); } catch {}
        continue;
      }
      if (!f.endsWith(".req")) continue;
      const id = f.slice(0, -4);
      if (permMsg.has(id)) continue; // schon verschickt
      let req; try { req = JSON.parse(readFileSync(`${PERM_DIR}/${f}`, "utf8")); } catch { continue; }
      const r = await tg("sendMessage", {
        chat_id: CHAT_ID,
        text: `Claude bittet um Erlaubnis:\n${req.tool}\n${req.detail}`,
        reply_markup: { inline_keyboard: [[
          { text: "Erlauben", callback_data: `perm:${id}:ja` },
          { text: "Ablehnen", callback_data: `perm:${id}:nein` },
        ]] },
      });
      const mid = r?.result?.message_id;
      permMsg.set(id, mid ?? null);
    }
  } catch (e) { fehler("PermWatch:", (e && e.message) || e); }
}
setInterval(permWatch, 1000);

// ---------------------------------------------------------------------------
// B1: Repo-Katalog und unscharfe Namenssuche
// ---------------------------------------------------------------------------
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 100 = exakt, >=75 = sicherer Treffer, >=50 = Vorschlag, 0 = kein Treffer.
function punkte(anfrage, name) {
  const q = norm(anfrage), n = norm(name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  if (n.startsWith(q)) return Math.max(78, 92 - (n.length - q.length));
  if (n.includes(q)) return q.length >= 4 ? 76 : 62;
  if (q.includes(n)) return 70;
  const d = lev(q, n);
  const grenze = Math.max(2, Math.floor(Math.max(q.length, n.length) * 0.34));
  if (d <= grenze) return Math.max(45, 68 - d * 6);
  return 0;
}

async function repoKatalog(erzwingen = false) {
  let cache = null;
  try { cache = JSON.parse(readFileSync(REPOS, "utf8")); } catch {}
  if (!erzwingen && cache?.repos?.length && Date.now() - (cache.stand || 0) < REPO_CACHE_TTL) return cache.repos;
  const r = await sh("gh", ["repo", "list", GH_USER, "--limit", "300", "--json", "name,description,isArchived"], { cwd: HOME, timeout: 60000 });
  if (!r.ok) {
    fehler("gh repo list:", r.err.slice(0, 200));
    return cache?.repos || [];  // lieber ein alter Katalog als gar keiner
  }
  let repos = [];
  try { repos = JSON.parse(r.out).filter((x) => !x.isArchived); } catch { return cache?.repos || []; }
  try { writeFileSync(REPOS, JSON.stringify({ stand: Date.now(), repos }, null, 2), { mode: 0o600 }); } catch {}
  return repos;
}

// Sucht über registrierte Projekte UND eigene GitHub-Repos.
// Ergebnis: { art: "treffer"|"mehrdeutig"|"nichts", ... }
async function zielFinden(anfrage) {
  const projekte = loadProj();
  const kandidaten = new Map(); // schlüssel -> { name, punkte, quelle, pfad? }
  const merke = (name, p, quelle, pfad) => {
    const alt = kandidaten.get(norm(name));
    if (!alt || alt.punkte < p) kandidaten.set(norm(name), { name, punkte: p, quelle, pfad });
  };
  for (const [name, pfad] of Object.entries(projekte)) {
    const p = punkte(anfrage, name);
    if (p) merke(name, Math.min(100, p + 4), "projekt", pfad); // registriert schlägt ungeklont
  }
  for (const repo of await repoKatalog()) {
    const p = punkte(anfrage, repo.name);
    if (p) merke(repo.name, p, "repo");
  }
  const liste = [...kandidaten.values()].sort((a, b) => b.punkte - a.punkte);
  if (!liste.length) return { art: "nichts", liste: [] };
  const [erst, zweit] = liste;
  if (erst.punkte >= 100 || (erst.punkte >= 75 && (!zweit || erst.punkte - zweit.punkte >= 12))) {
    return { art: "treffer", ziel: erst, liste };
  }
  const nah = liste.filter((x) => x.punkte >= 50).slice(0, 5);
  if (nah.length) return { art: "mehrdeutig", liste: nah };
  return { art: "nichts", liste: liste.slice(0, 5) };
}

// Klont bei Bedarf und liefert den Pfad. Registriert das Projekt gleich mit.
async function zielBereitstellen(ziel) {
  const name = ziel.name.toLowerCase();
  let pfad = ziel.pfad || `${WORK_ROOT}/${ziel.name}`;
  if (!existsSync(pfad) && existsSync(`${WORK_ROOT}/${name}`)) pfad = `${WORK_ROOT}/${name}`;
  if (!existsSync(pfad)) {
    await send(`Klone ${GH_USER}/${ziel.name} nach ${pfad} ...`);
    const r = await sh("gh", ["repo", "clone", `${GH_USER}/${ziel.name}`, pfad], { cwd: HOME, timeout: 600000 });
    if (!r.ok || !existsSync(pfad)) return { ok: false, meldung: `Klonen von ${GH_USER}/${ziel.name} fehlgeschlagen:\n${(r.err || "unbekannter Fehler").slice(0, 500)}` };
  }
  const p = loadProj();
  if (p[name] !== pfad) { p[name] = pfad; saveProj(p); }
  return { ok: true, pfad, name };
}

// Prüft den vorhandenen Klon. Meldet handlungsfähig statt nur zu berichten.
async function klonPruefen(pfad) {
  if (!istGit(pfad)) return { art: "ok", hinweis: "" };
  const st = await git(pfad, "status", "--porcelain");
  const schmutzig = st.out ? st.out.split("\n").filter(Boolean) : [];
  if (schmutzig.length) {
    return { art: "schmutzig", dateien: schmutzig };
  }
  const upstream = await git(pfad, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (!upstream.ok) return { art: "ok", hinweis: "" };   // rein lokaler Branch, nichts zu ziehen
  await git(pfad, "fetch", "--quiet", "--all");
  const pull = await git(pfad, "pull", "--ff-only");
  if (!pull.ok) return { art: "ok", hinweis: `Hinweis: git pull --ff-only ging nicht durch (${(pull.err || "").split("\n")[0].slice(0, 160)}). Der Klon bleibt auf dem lokalen Stand.` };
  return { art: "ok", hinweis: "" };
}

// ---------------------------------------------------------------------------
// B2: Branch + PR als Default. /direkt ist die Ausnahme pro Session.
// ---------------------------------------------------------------------------
const slug = (s) => String(s || "").toLowerCase()
  .replace(/[äàáâ]/g, "a").replace(/[öòóô]/g, "o").replace(/[üùúû]/g, "u").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "") || "auftrag";

const stempel = () => {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
};

const branchHinweis = (bi) => `[Bot-Hinweis] Du arbeitest im Git-Branch "${bi.branch}" (Basis "${bi.base}"). `
  + `Committe alle Änderungen in diesem Branch mit aussagekräftigen Nachrichten. Wechsle den Branch nicht, `
  + `mache kein git push und erstelle keinen Pull Request — das übernimmt der Bot nach deinem Lauf.\n\nAuftrag:\n`;

// Legt den Branch an bzw. stellt sicher, dass wir noch auf dem der Session sind.
async function branchVorbereiten(cwd, vorhanden, auftrag) {
  if (!istGit(cwd)) return { branch: null, meldung: "" };
  if (vorhanden?.branch) {
    const jetzt = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).out;
    if (jetzt === vorhanden.branch) return { branch: vorhanden.branch, base: vorhanden.base, meldung: "" };
    const co = await git(cwd, "checkout", vorhanden.branch);
    if (co.ok) return { branch: vorhanden.branch, base: vorhanden.base, meldung: "" };
    return { branch: null, meldung: `Konnte nicht auf Branch ${vorhanden.branch} zurück (${(co.err || "").split("\n")[0].slice(0, 140)}). Der Auftrag läuft auf ${jetzt}.` };
  }
  const base = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).out || "main";
  const branch = `claude/${slug(auftrag)}-${stempel()}`;
  const co = await git(cwd, "checkout", "-b", branch);
  if (!co.ok) return { branch: null, meldung: `Branch ${branch} konnte nicht angelegt werden (${(co.err || "").split("\n")[0].slice(0, 140)}). Der Auftrag läuft direkt auf ${base}.` };
  return { branch, base, meldung: "" };
}

// In einem Fork zielt "gh pr create" ohne --repo auf das UPSTREAM-Repo und scheitert
// mit "No commits between ...". Am 2026-09-05 im Selbsttest an diesem Repo reproduziert.
// Deshalb wird das Ziel-Repo immer aus der origin-URL abgeleitet und explizit gesetzt.
function repoAusRemote(url) {
  const m = String(url || "").match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Nach dem Lauf: pushen und PR öffnen, wenn es Commits gibt. Läuft auch nach
// einem Abbruch — genau dann ist der PR der Zwischenstand.
async function prAbschluss(cwd, bi, titel, auftrag) {
  if (!bi?.branch || !istGit(cwd)) return null;
  const zaehl = await git(cwd, "rev-list", "--count", `${bi.base}..HEAD`);
  const anzahl = parseInt(zaehl.out, 10) || 0;
  if (!anzahl) {
    const st = await git(cwd, "status", "--porcelain");
    const n = st.out ? st.out.split("\n").filter(Boolean).length : 0;
    if (n) return { text: `Kein Commit im Branch ${bi.branch}, aber ${n === 1 ? "eine geaenderte Datei liegt" : `${n} geaenderte Dateien liegen`} dort. Mit einem neuen Auftrag in derselben Session fortsetzen.` };
    // Nichts ist passiert — dann bleibt auch kein Branch stehen. Eine reine Frage
    // ("was sind die nächsten Schritte?") soll das Repo nicht mit einem leeren
    // Branch belasten, der ihren Wortlaut im Namen trägt.
    if (bi.base) {
      const zurueck = await git(cwd, "checkout", bi.base);
      if (zurueck.ok) { await git(cwd, "branch", "-D", bi.branch); return { verworfen: true }; }
    }
    return null;
  }
  const commits = anzahl === 1 ? "1 Commit" : `${anzahl} Commits`;
  const remote = await git(cwd, "remote", "get-url", "origin");
  if (!remote.ok) return { text: `${commits} im Branch ${bi.branch} — kein origin-Remote, die Arbeit bleibt lokal auf dem Server.` };
  const push = await git(cwd, "push", "-u", "origin", bi.branch);
  if (!push.ok) return { text: `${commits} im Branch ${bi.branch}, aber der Push scheiterte:\n${(push.err || "").slice(-400)}` };
  if (bi.prUrl) return { text: `${commits} gepusht. PR aktualisiert: ${bi.prUrl}`, prUrl: bi.prUrl };
  const ziel = repoAusRemote(remote.out);
  const repoArg = ziel ? ["--repo", ziel] : [];
  const koerper = `Erstellt vom Session-Bot auf LXC 112.\n\nAuftrag:\n${String(auftrag).slice(0, 2000)}`;
  const pr = await sh("gh", ["pr", "create", ...repoArg, "--head", bi.branch, "--base", bi.base, "--title", String(titel).slice(0, 70), "--body", koerper], { cwd, timeout: 120000 });
  if (!pr.ok) {
    const vorhanden = await sh("gh", ["pr", "view", bi.branch, ...repoArg, "--json", "url", "-q", ".url"], { cwd, timeout: 60000 });
    if (vorhanden.ok && vorhanden.out.startsWith("http")) return { text: `${commits} gepusht. PR: ${vorhanden.out}`, prUrl: vorhanden.out };
    return { text: `${commits} nach ${bi.branch} gepusht, aber gh pr create scheiterte:\n${(pr.err || "").slice(-400)}` };
  }
  const url = (pr.out.match(/https:\/\/\S+/) || [pr.out])[0];
  return { text: `${commits} gepusht.\nPull Request: ${url}`, prUrl: url };
}

// ---------------------------------------------------------------------------
// Remote Control: eine interaktive Sitzung auf dieser Maschine aufmachen und die
// claude.ai-Adresse zurückgeben. Damit schließt sich die Lücke aus dem Grill —
// "wenn kein Cloud offen ist mit Remote Control, komme ich gar nicht mehr ran":
// Telegram erreicht man immer, und der Bot drückt den Knopf.
//
// --remote-control ist ausdrücklich *interaktiv* und braucht ein echtes Terminal,
// deshalb tmux. Wer die Ausgabe umleitet (Pipe, tee, Logdatei), nimmt Claude das
// TTY weg, es fällt auf --print zurück und stirbt mit "Input must be provided" —
// genau die Ursache, die den alten claude-telegram.service in 23.457 Neustarts trieb.
// ---------------------------------------------------------------------------
const RC_ADRESSE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;
const rcName = (cwd) => "rc-" + slug(String(cwd).split("/").filter(Boolean).pop() || "work");
const tmux = (...args) => sh("tmux", args, { cwd: HOME, timeout: 30000 });
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const rcLaeuft = async (name) => (await tmux("has-session", "-t", name)).ok;
const rcFenster = async (name) => { const r = await tmux("capture-pane", "-p", "-t", name); return r.ok ? r.out : ""; };
const rcTaste = async (name, taste) => { await tmux("send-keys", "-t", name, taste); await warte(400); await tmux("send-keys", "-t", name, "Enter"); };

async function rcStarten(cwd, name) {
  if (await rcLaeuft(name)) {
    const adresse = (await rcFenster(name)).match(RC_ADRESSE);
    if (adresse) return { ok: true, url: adresse[0], schonDa: true };
    await tmux("kill-session", "-t", name); // leere Hülle, neu aufsetzen
  }
  const start = await tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "50",
    `cd ${JSON.stringify(cwd)} && ${CLAUDE} --remote-control ${name}; echo "[beendet]"; exec bash`);
  if (!start.ok) return { ok: false, fehler: `tmux konnte die Sitzung nicht starten: ${(start.err || "").slice(0, 300)}` };
  // Die zwei Startdialoge beantworten und auf die Adresse warten.
  for (let i = 0; i < 40; i++) {
    await warte(3000);
    const fenster = await rcFenster(name);
    const adresse = fenster.match(RC_ADRESSE);
    if (adresse) return { ok: true, url: adresse[0] };
    if (/trust this folder|Is this a project you created/i.test(fenster)) { await rcTaste(name, "Down"); continue; }
    if (/fullscreen renderer/i.test(fenster)) { await rcTaste(name, "2"); continue; }
    if (!(await rcLaeuft(name))) return { ok: false, fehler: "Die Sitzung war sofort wieder beendet:\n" + fenster.slice(-500) };
  }
  return { ok: false, fehler: "Nach zwei Minuten kam keine Remote-Control-Adresse. Stand im Fenster:\n" + (await rcFenster(name)).slice(-500) };
}

async function rcListe() {
  const r = await tmux("list-sessions", "-F", "#{session_name}");
  return r.ok ? r.out.split("\n").filter((z) => z.startsWith("rc-")) : [];
}

// ---------------------------------------------------------------------------
// Claude ausführen
// ---------------------------------------------------------------------------
function runClaude(auftrag, resumeId, cwd, modus, modell) {
  return new Promise((resolve) => {
    const args = ["-p", auftrag, "--output-format", "json", "--permission-mode", modus || DEFAULT_MODE,
      "--allowedTools", "WebSearch,WebFetch",
      "--permission-prompt-tool", "mcp__perm__approve",
      "--mcp-config", `${HOME}/bin/perm-mcp.json`];
    if (modell) args.push("--model", modell);
    if (resumeId) args.push("--resume", resumeId);
    const kind = execFile(CLAUDE, args, { cwd: cwd || DEFAULT_CWD, env: ENV, timeout: RUN_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
      // B6: Abbruch zuerst erkennen — sonst landet die Teilausgabe im JSON-Parser
      // und der Nutzer liest "Antwort nicht lesbar" statt "abgebrochen".
      if (e && (e.killed || e.signal)) {
        return resolve({ ok: false, abbruch: true, error: `Auftrag nach ${Math.round(RUN_TIMEOUT / 60000)} Minuten abgebrochen.` });
      }
      if (e && !out) return resolve({ ok: false, error: String((e && e.message) || e).slice(-400) });
      let j;
      try { j = JSON.parse(out); }
      catch { return resolve({ ok: false, error: "Antwort nicht lesbar: " + String(out).slice(0, 300) }); }
      // Korrektur 3: claude -p meldet API-Fehler mit Exit 0 UND subtype:"success".
      // Nur is_error ist verlässlich — sonst landet z.B. "OAuth session expired"
      // als vermeintliche Claude-Antwort im Chat und der Bot wirkt monatelang gesund.
      if (j.is_error === true) {
        const grund = j.result || j.api_error_status || j.terminal_reason || "unbekannter API-Fehler";
        return resolve({ ok: false, error: `Claude meldet einen Fehler: ${String(grund).slice(0, 400)}`, sid: j.session_id || resumeId || null });
      }
      resolve({ ok: true, result: j.result || "(kein Ergebnis)", sid: j.session_id || resumeId || null });
    });
    kind.stdin.end(); // sonst wartet Claude 3 Sekunden auf stdin
  });
}

// ---------------------------------------------------------------------------
// B5: persistente Warteschlange
// ---------------------------------------------------------------------------
const queue = [];
let busy = false;

function qPush(item) {
  queue.push(item);
  mutate((r) => { r.warteschlange = [...(r.warteschlange || []), item]; });
  return queue.length;
}
function qShift() {
  const item = queue.shift();
  mutate((r) => { r.warteschlange = (r.warteschlange || []).filter((x) => x.qid !== item.qid); r.laufend = item; });
  return item;
}
const qFertig = () => mutate((r) => { r.laufend = null; });

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const item = qShift();
      try { await auftragAusfuehren(item); }
      catch (e) { fehler("Auftrag:", (e && e.stack) || e); await send("Interner Fehler beim Auftrag: " + String((e && e.message) || e).slice(0, 300)); }
      qFertig();
    }
  } finally { busy = false; qFertig(); }
}

async function auftragAusfuehren(item) {
  const reg = load();
  const cur = reg.sessions.find((s) => s.id === reg.aktiv) || null;
  const cwd = cur ? (cur.cwd || DEFAULT_CWD) : (item.cwd || reg.naechstesCwd || DEFAULT_CWD);
  const modus = cur ? (cur.modus || DEFAULT_MODE) : (reg.naechsterModus || DEFAULT_MODE);
  const modell = cur ? (cur.modell || null) : (reg.naechstesModell || null);
  const direkt = cur ? !!cur.direkt : !!reg.naechsterDirekt;

  // B2: Branch anlegen, bevor Claude läuft — dann kann main auch dann nicht
  // getroffen werden, wenn Claude den Hinweis im Prompt ignoriert.
  let bi = { branch: null, base: null, prUrl: cur?.prUrl || null };
  if (!direkt) {
    const vor = await branchVorbereiten(cwd, cur, item.text);
    if (vor.meldung) await send(vor.meldung);
    bi = { branch: vor.branch, base: vor.base || cur?.base || null, prUrl: cur?.prUrl || null };
  }

  const prompt = bi.branch ? branchHinweis(bi) + item.text : item.text;
  const r = await runClaude(prompt, cur ? cur.id : null, cwd, modus, modell);

  // Session festhalten — auch wenn der Lauf schiefging, solange eine ID bekannt ist.
  const sid = r.sid || (cur ? cur.id : null);
  mutate((reg2) => {
    if (cur) {
      const s = reg2.sessions.find((x) => x.id === cur.id);
      if (s) {
        s.id = sid || s.id; s.zuletzt = Date.now();
        if (bi.branch) { s.branch = bi.branch; s.base = bi.base; }
      }
      if (reg2.aktiv === cur.id) reg2.aktiv = sid || cur.id;
    } else if (sid && !reg2.sessions.some((x) => x.id === sid)) {
      reg2.sessions.push({ id: sid, titel: item.text.slice(0, 48), cwd, modus, modell, direkt, base: bi.base, branch: bi.branch, prUrl: null, erstellt: Date.now(), zuletzt: Date.now() });
      if (reg2.sessions.length > 15) reg2.sessions = reg2.sessions.slice(-15);
      if (!reg2.aktiv) reg2.aktiv = sid;
      reg2.naechstesCwd = null; reg2.naechsterModus = null; reg2.naechstesModell = null; reg2.naechsterDirekt = false;
    }
  });

  if (r.ok) await send(r.result);
  else if (r.abbruch) await send(`${r.error}\nDas ist ein Zwischenstand, kein Totalverlust: die Arbeit liegt in ${cwd}${bi.branch ? ` im Branch ${bi.branch}` : ""}. Mit einem neuen Auftrag im selben Projekt geht es weiter.`);
  else await send("Fehlgeschlagen: " + r.error);

  // B6: der PR-Abschluss läuft auch nach Abbruch und Fehler — genau dann ist er wertvoll.
  try {
    const pr = await prAbschluss(cwd, bi, item.text, item.text);
    if (pr?.verworfen) {
      mutate((reg3) => { const s = reg3.sessions.find((x) => x.id === (sid || reg3.aktiv)); if (s) { s.branch = null; s.base = null; } });
    } else if (pr) {
      await send(pr.text);
      if (pr.prUrl) mutate((reg3) => { const s = reg3.sessions.find((x) => x.id === (sid || reg3.aktiv)); if (s) s.prUrl = pr.prUrl; });
    }
  } catch (e) { fehler("PR:", (e && e.message) || e); }
}

// ---------------------------------------------------------------------------
// B7: Capability-Ping. Die Fähigkeit pingen, nicht die Existenz — der Dienst
// lief am 2026-09-04 monatelang, während nur der Login tot war.
// ---------------------------------------------------------------------------
const hc = { letzterOk: null, letzterVersuch: null, letzterFehler: null, unscharfGemeldet: false };

async function hcPing(pfad) {
  if (!HC_URL) return;
  try { await fetch(HC_URL + (pfad || ""), { method: "GET", signal: AbortSignal.timeout(15000) }); }
  catch (e) { fehler("HC-Ping:", (e && e.message) || e); }
}

async function capabilityPing() {
  hc.letzterVersuch = Date.now();
  if (!HC_URL && !hc.unscharfGemeldet) {
    fehler("Capability-Ping UNSCHARF: HC_URL ist nicht gesetzt. Ein Ausfall des Bots wird nicht extern gemeldet.");
    hc.unscharfGemeldet = true;
  }
  const r = await new Promise((resolve) => {
    execFile(CLAUDE, ["-p", "Antworte nur mit OK.", "--output-format", "json", "--model", MODELLE.haiku, "--permission-mode", "plan"],
      { cwd: DEFAULT_CWD, env: ENV, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
        if (e && !out) return resolve({ ok: false, grund: String((e && e.message) || e).slice(0, 200) });
        try {
          const j = JSON.parse(out);
          if (j.is_error === true) return resolve({ ok: false, grund: String(j.result || j.terminal_reason || "is_error").slice(0, 200) });
          return resolve({ ok: true });
        } catch { return resolve({ ok: false, grund: "Antwort nicht lesbar" }); }
      });
  });
  if (r.ok) { hc.letzterOk = Date.now(); hc.letzterFehler = null; await hcPing(""); log("Capability-Ping: ok"); }
  else { hc.letzterFehler = r.grund; await hcPing("/fail"); fehler("Capability-Ping FEHLGESCHLAGEN:", r.grund); }
}
setTimeout(capabilityPing, 20000);
setInterval(capabilityPing, HC_INTERVAL);

// ---------------------------------------------------------------------------
// /compact — verifiziert am 2026-09-05: komprimiert per --resume wirklich.
// num_turns: 0 und leeres result sind die normale Signatur eines Slash-Commands
// im -p-Modus, kein Nichtstun. Beleg ist der compact_boundary im Transkript.
// ---------------------------------------------------------------------------
const transkriptPfad = (cwd, sid) => `${HOME}/.claude/projects/${String(cwd).replace(/[^a-zA-Z0-9]/g, "-")}/${sid}.jsonl`;
function grenzen(pfad) {
  try { return (readFileSync(pfad, "utf8").match(/compact_boundary/g) || []).length; } catch { return -1; }
}

// ---------------------------------------------------------------------------
// Auftrag einreihen (gemeinsamer Weg für /neu und freie Nachrichten)
// ---------------------------------------------------------------------------
async function einreihen(text, cwd, meldungWennFrei) {
  const pos = qPush({ qid: kurzId(), text, cwd: cwd || null, ts: Date.now() });
  await send(busy ? `Eingereiht, Position ${pos}.` : meldungWennFrei);
  pump();
}

// Laeuft bewusst ohne await aus der Nachrichtenschleife heraus: der Start kann bis
// zu zwei Minuten dauern, und solange soll der Bot weiter auf Nachrichten hoeren.
async function rcOeffnen(cwd, hinweis) {
  const name = rcName(cwd);
  await send(`${hinweis ? hinweis + "\n" : ""}Öffne eine Remote-Control-Sitzung in ${kurz(cwd)} … das kann bis zu einer Minute dauern.`);
  const r = await rcStarten(cwd, name);
  if (!r.ok) { await send("Hat nicht geklappt: " + r.fehler); return; }
  await send(`${r.schonDa ? "Läuft bereits" : "Sitzung offen"} — ${kurz(cwd)} auf LXC 112:\n${r.url}\n\n`
    + `Das ist die volle Claude-Code-Oberfläche mit Rückfragen und Dateiansicht, nicht der Ein-Auftrag-Weg dieses Bots. `
    + `Sie läuft weiter, bis du sie beendest: /rc stop ${kurz(cwd)}`);
}

async function neuStarten(pfad, name, auftrag, hinweis) {
  mutate((r) => { r.aktiv = null; r.naechstesCwd = pfad; });
  const reg = load();
  const wie = reg.naechsterDirekt ? "direkt auf dem Hauptbranch" : "auf einem eigenen Branch mit PR";
  const kopf = (hinweis ? hinweis + "\n" : "") + `Neue Session in ${name} (${pfad}), ${wie}.`;
  if (auftrag) await einreihen(auftrag, pfad, `${kopf} Auftrag läuft. ${DAUER}`);
  else await send(`${kopf}\nDeine nächste Nachricht eröffnet sie.`);
}

// Der gemeinsame Weg von "/neu <name>" bis zum laufenden Auftrag.
async function zielOeffnen(ziel, auftrag, vorHinweis) {
  const b = await zielBereitstellen(ziel);
  if (!b.ok) { await send(b.meldung); return; }
  const pruef = await klonPruefen(b.pfad);
  if (pruef.art === "schmutzig") {
    const id = frage({ typ: "dirty", pfad: b.pfad, name: b.name, auftrag: auftrag || "", vorHinweis: vorHinweis || "" });
    const liste = pruef.dateien.slice(0, 8).map((z) => "  " + z).join("\n");
    await send(
      `${b.name} hat ${pruef.dateien.length} ungespeicherte Änderung(en) im Klon auf dem Server:\n${liste}${pruef.dateien.length > 8 ? "\n  ..." : ""}\n\n`
      + `Ich habe deshalb nicht gepullt. Wie weiter?`,
      { reply_markup: { inline_keyboard: [
        [knopf("Änderungen behalten und weiter", id, "weiter")],
        [knopf("Wegstashen und frisch ziehen", id, "stash")],
        [knopf("Verwerfen und frisch ziehen", id, "reset")],
        [knopf("Abbrechen", id, "abbruch")],
      ] } });
    return;
  }
  await neuStarten(b.pfad, b.name, auftrag, [vorHinweis, pruef.hinweis].filter(Boolean).join("\n"));
}

// ---------------------------------------------------------------------------
// Start: verlorene Warteschlange sichtbar machen (B5)
// ---------------------------------------------------------------------------
async function verloreneAuftraege() {
  const r = load();
  const offen = [...(r.laufend ? [r.laufend] : []), ...(r.warteschlange || [])];
  if (!offen.length) return;
  mutate((x) => { x.warteschlange = []; x.laufend = null; });
  const id = frage({ typ: "queue", items: offen });
  const liste = offen.map((x, i) => `${i + 1}. ${String(x.text).slice(0, 90)}`).join("\n");
  await send(
    `Beim letzten Stopp waren ${offen.length} Aufträge offen — sie wurden nicht ausgeführt:\n${liste}\n\n`
    + `${r.laufend ? "Der erste lief bereits, seine Arbeit kann teilweise auf der Platte liegen.\n" : ""}Was soll damit passieren?`,
    { reply_markup: { inline_keyboard: [
      [knopf("Alle erneut einreihen", id, "alle")],
      [knopf("Verwerfen", id, "weg")],
    ] } });
}

// ---------------------------------------------------------------------------
// Hauptschleife
// ---------------------------------------------------------------------------
// Das Befehlsmenü im Chat (blauer Knopf links neben der Eingabe) kommt nicht von
// allein — Telegram zeigt es erst, wenn der Bot seine Befehle einmal angemeldet hat.
const BEFEHLE = [
  { command: "neu", description: "Projekt öffnen: klont, registriert und startet in einem Zug" },
  { command: "rc", description: "Remote-Control-Sitzung öffnen: volle Oberfläche im Browser" },
  { command: "status", description: "Stand, Verzeichnis, Branch, PR, Außenwache" },
  { command: "sessions", description: "Alle Sessions mit Projekt und Branch" },
  { command: "wechsel", description: "Session wechseln (/wechsel 2)" },
  { command: "direkt", description: "Direkt auf dem Hauptbranch statt Branch + PR" },
  { command: "compact", description: "Kontext der aktiven Session verdichten" },
  { command: "clear", description: "Kontext leeren, Projekt behalten" },
  { command: "ende", description: "Aktive Session ablegen" },
  { command: "projekte", description: "Verzeichnisse zeigen, registrieren, Repo-Liste neu einlesen" },
  { command: "modus", description: "Berechtigungsmodus (standard, edits, plan, auto, voll)" },
  { command: "modell", description: "Sprachmodell (opus, sonnet, haiku, standard)" },
  { command: "start", description: "Hilfe anzeigen" },
];

let offset = 0;
log(`Session-Bot v8 gestartet (LXC 112, User claude). Capability-Ping: ${HC_URL ? "scharf" : "UNSCHARF (HC_URL fehlt)"}`);
const menue = await tg("setMyCommands", { commands: BEFEHLE });
if (!menue?.ok) fehler("Befehlsmenü konnte nicht gesetzt werden:", (menue && menue.description) || "");
await verloreneAuftraege();

const HILFE = "Session-Bot bereit (LXC 112). Jede Nachricht ist ein Auftrag an die aktive Claude-Session.\n\n"
  + "/neu <repo|projekt|/pfad> [Auftrag] - klont bei Bedarf, registriert und startet in einem Zug; der Name darf unscharf sein\n"
  + "/projekte - Verzeichnisse zeigen, mit add registrieren, mit scan übernehmen\n"
  + "/rc [projekt] - Remote-Control-Sitzung öffnen (volle Claude-Code-Oberfläche im Browser), /rc stop beendet sie\n"
  + "/direkt [aus] - für diese Session direkt auf dem Hauptbranch statt Branch+PR\n"
  + "/compact - Kontext der aktiven Session verdichten\n"
  + "/modus [standard|edits|plan|auto|voll] - Berechtigungsmodus\n"
  + "/modell [opus|sonnet|haiku|standard] - Sprachmodell\n"
  + "/sessions - alle Sessions\n"
  + "/wechsel N - Session wechseln\n"
  + "/status - Stand plus SSH-Befehl zum Fortsetzen\n"
  + "/clear - Kontext leeren\n"
  + "/ende - aktive Session ablegen\n\n"
  + "Standard ist Branch + Pull Request: der Bot legt vor dem Lauf einen Branch an und öffnet danach den PR. "
  + "Web-Suche ist erlaubt. Braucht Claude weitere Rechte, kommt eine Freigabe-Anfrage mit Buttons. " + DAUER;

while (true) {
  try {
    const res = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`);
    const data = await res.json();
    for (const u of data.result ?? []) {
      offset = u.update_id + 1;

      if (u.callback_query) {
        const cq = u.callback_query;
        let note = "Unbekannte Aktion";
        if (cq.from.id === CHAT_ID && cq.data && cq.data.startsWith("perm:")) {
          const teile = cq.data.split(":");
          const id = teile[1] || "", antwort = teile[2] === "ja" ? "ja" : "nein";
          if (/^[a-z0-9]+$/i.test(id)) {
            try {
              mkdirSync(PERM_DIR, { recursive: true, mode: 0o700 });
              writeFileSync(`${PERM_DIR}/${id}`, antwort, { mode: 0o600 });
              note = antwort === "ja" ? "Erlaubt" : "Abgelehnt";
              permMsg.delete(id);
              if (cq.message) {
                const orig = cq.message.text || "Berechtigungsanfrage";
                await tg("editMessageText", { chat_id: CHAT_ID, message_id: cq.message.message_id,
                  text: ((antwort === "ja" ? "ERLAUBT - Claude führt aus:\n" : "ABGELEHNT - Claude überspringt:\n") + orig).slice(0, 4000) });
              }
            } catch (e) { fehler("Perm:", (e && e.message) || e); note = "Fehler"; }
          }
        } else if (cq.from.id === CHAT_ID && cq.data && cq.data.startsWith("act:")) {
          const [, id, wahl] = cq.data.split(":");
          const akt = wartend.get(id);
          if (!akt) note = "Die Frage ist nicht mehr aktuell";
          else {
            wartend.delete(id);
            note = "Verstanden";
            if (cq.message) await tg("editMessageReplyMarkup", { chat_id: CHAT_ID, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
            if (akt.typ === "queue") {
              if (wahl === "alle") {
                for (const it of akt.items) qPush({ ...it, qid: kurzId() });
                await send(`${akt.items.length} Aufträge wieder eingereiht.`);
                pump();
              } else await send("Verworfen.");
            } else if (akt.typ === "wahl") {
              const ziel = akt.liste[parseInt(wahl, 10)];
              if (!ziel) await send("Auswahl nicht mehr gültig.");
              else await zielOeffnen(ziel, akt.auftrag, `Gewählt: ${ziel.name}.`);
            } else if (akt.typ === "rc") {
              const ziel = akt.liste[parseInt(wahl, 10)];
              if (!ziel) await send("Auswahl nicht mehr gültig.");
              else {
                const b = await zielBereitstellen(ziel);
                if (!b.ok) await send(b.meldung);
                else rcOeffnen(b.pfad, `Gewählt: ${ziel.name}.`);
              }
            } else if (akt.typ === "dirty") {
              if (wahl === "abbruch") { await send("Abgebrochen. Der Klon bleibt unverändert."); }
              else {
                let hinweis = akt.vorHinweis || "";
                if (wahl === "stash") {
                  const s = await git(akt.pfad, "stash", "push", "-u", "-m", `bot ${new Date().toISOString()}`);
                  hinweis += (hinweis ? "\n" : "") + (s.ok ? "Änderungen gestasht (git stash list zeigt sie)." : `Stash fehlgeschlagen: ${(s.err || "").split("\n")[0].slice(0, 140)}`);
                  if (s.ok) { const p = await klonPruefen(akt.pfad); if (p.hinweis) hinweis += "\n" + p.hinweis; }
                } else if (wahl === "reset") {
                  await git(akt.pfad, "reset", "--hard");
                  await git(akt.pfad, "clean", "-fd");
                  hinweis += (hinweis ? "\n" : "") + "Lokale Änderungen verworfen.";
                  const p = await klonPruefen(akt.pfad); if (p.hinweis) hinweis += "\n" + p.hinweis;
                } else {
                  hinweis += (hinweis ? "\n" : "") + "Die lokalen Änderungen bleiben stehen, es wurde nicht gepullt.";
                }
                await neuStarten(akt.pfad, akt.name, akt.auftrag, hinweis);
              }
            }
          }
        }
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: note });
        continue;
      }

      const msg = u.message;
      if (!msg?.text || msg.chat.id !== CHAT_ID) continue;
      const text = msg.text.trim();
      const reg = load();
      const cur = reg.sessions.find((s) => s.id === reg.aktiv) || null;

      if (text === "/start" || text === "/hilfe") { await send(HILFE); continue; }

      if (text === "/direkt" || text.startsWith("/direkt ")) {
        const aus = text.slice(7).trim().toLowerCase() === "aus";
        if (cur) {
          if (!aus && cur.branch) {
            await send(`Diese Session arbeitet bereits im Branch ${cur.branch}. /direkt gilt ab der nächsten neuen Session — sonst wäre der halbfertige Branch verwaist.`);
            continue;
          }
          mutate((r) => { const s = r.sessions.find((x) => x.id === cur.id); if (s) s.direkt = !aus; });
          await send(aus ? `"${cur.titel}" arbeitet wieder mit Branch + PR.` : `"${cur.titel}" arbeitet ab jetzt direkt auf dem Hauptbranch. Kein PR, kein Diff zum Gegenlesen.`);
        } else {
          mutate((r) => { r.naechsterDirekt = !aus; });
          await send(aus ? "Nächste Session: Branch + PR (Standard)." : "Nächste Session: direkt auf dem Hauptbranch. Kein PR, kein Diff zum Gegenlesen.");
        }
        continue;
      }

      if (text === "/compact") {
        if (!cur) { await send("Keine aktive Session zum Verdichten."); continue; }
        const pfad = transkriptPfad(cur.cwd || DEFAULT_CWD, cur.id);
        const vorher = grenzen(pfad);
        await send("Verdichte den Kontext ...");
        const r = await runClaude("/compact", cur.id, cur.cwd || DEFAULT_CWD, cur.modus || DEFAULT_MODE, cur.modell || null);
        if (!r.ok) { await send("Verdichten fehlgeschlagen: " + r.error); continue; }
        const nachher = grenzen(pfad);
        mutate((x) => { const s = x.sessions.find((y) => y.id === cur.id); if (s) s.zuletzt = Date.now(); });
        if (vorher >= 0 && nachher > vorher) await send(`Kontext verdichtet. Die Session läuft unter derselben ID weiter, das Wissen aus den früheren Nachrichten bleibt als Zusammenfassung erhalten.`);
        else if (vorher >= 0 && nachher === vorher) await send("Claude hat den Befehl angenommen, im Transkript ist aber keine neue Verdichtung entstanden — vermutlich war der Kontext dafür noch zu klein.");
        else await send("Verdichtung ausgeführt. (Transkript nicht auffindbar, deshalb ohne Gegenprobe.)");
        continue;
      }

      if (text === "/modus" || text.startsWith("/modus ")) {
        const arg = text.slice(6).trim().toLowerCase();
        if (!arg) {
          await send(`Aktueller Modus${cur ? ` der Session "${cur.titel}"` : " fuer die naechste Session"}: ${cur ? modusName(cur.modus) : modusName(reg.naechsterModus)}\n\nVerfügbar:\nstandard - fragt per Button an, auch bei Dateiänderungen\nedits - Dateiänderungen automatisch, Rest per Button\nplan - nur lesen und planen\nauto - Claude entscheidet selbst\nvoll - keine Nachfragen (STANDARD auf dieser Maschine)\n\nHinweis: "edits" genehmigt auch rm, mv, cp und sed im Arbeitsverzeichnis automatisch.`);
        } else if (!MODI[arg]) {
          await send("Unbekannter Modus. Verfügbar: standard, edits, plan, auto, voll");
        } else {
          const warn = arg === "voll" ? "\nVorsicht: Claude fragt in dieser Session nichts mehr an."
                     : arg === "edits" ? "\nHinweis: genehmigt auch rm/mv/cp/sed im Arbeitsverzeichnis." : "";
          if (cur) {
            mutate((r) => { const s = r.sessions.find((x) => x.id === cur.id); if (s) s.modus = MODI[arg]; });
            await send(`Modus für "${cur.titel}": ${arg}${warn}`);
          } else {
            mutate((r) => { r.naechsterModus = MODI[arg]; });
            await send(`Modus für die nächste Session: ${arg}${warn}`);
          }
        }
        continue;
      }
      if (text === "/modell" || text.startsWith("/modell ")) {
        const arg = text.slice(7).trim().toLowerCase();
        if (!arg) {
          await send(`Aktuelles Modell${cur ? ` der Session "${cur.titel}"` : " fuer die naechste Session"}: ${cur ? modellName(cur.modell) : modellName(reg.naechstesModell)}\n\nVerfügbar: opus, sonnet, haiku, standard`);
        } else if (arg !== "standard" && !MODELLE[arg]) {
          await send("Unbekanntes Modell. Verfügbar: opus, sonnet, haiku, standard");
        } else {
          const wert = arg === "standard" ? null : MODELLE[arg];
          if (cur) {
            mutate((r) => { const s = r.sessions.find((x) => x.id === cur.id); if (s) s.modell = wert; });
            await send(`Modell für "${cur.titel}": ${arg}`);
          } else { mutate((r) => { r.naechstesModell = wert; }); await send(`Modell für die nächste Session: ${arg}`); }
        }
        continue;
      }
      if (text === "/projekte" || text.startsWith("/projekte ")) {
        const teile = text.split(/\s+/);
        // Verzeichnisse unter WORK_ROOT, die noch nicht registriert sind
        const unregistriert = () => {
          const p = loadProj();
          const bekannt = new Set(Object.values(p));
          try {
            return readdirSync(WORK_ROOT, { withFileTypes: true })
              .filter((d) => d.isDirectory() && !d.name.startsWith("."))
              .map((d) => `${WORK_ROOT}/${d.name}`)
              .filter((pf) => !bekannt.has(pf));
          } catch { return []; }
        };

        if (teile[1] === "add" && teile[2]) {
          // Pfad ist optional: ohne Pfad wird WORK_ROOT/<name> angenommen
          const name = teile[2].toLowerCase();
          const pfad = teile[3] || `${WORK_ROOT}/${teile[2]}`;
          if (!existsSync(pfad)) { await send(`Verzeichnis ${pfad} existiert nicht auf dem Server.`); continue; }
          const p = loadProj(); p[name] = pfad; saveProj(p);
          await send(`Registriert: ${name} -> ${pfad}\nNutzen mit /neu ${name} [Auftrag]`);
        } else if (teile[1] === "scan") {
          const neu = unregistriert();
          if (!neu.length) { await send(`Nichts Neues unter ${WORK_ROOT}.`); continue; }
          const p = loadProj();
          for (const pf of neu) p[pf.split("/").pop().toLowerCase()] = pf;
          saveProj(p);
          await send("Neu registriert:\n" + neu.map((pf) => `${pf.split("/").pop().toLowerCase()} -> ${pf}`).join("\n"));
        } else if (teile[1] === "repos") {
          const repos = await repoKatalog(true);
          await send(repos.length ? `${repos.length} eigene Repos neu eingelesen. /neu <name> holt jedes davon selbst.` : "Repo-Liste konnte nicht geladen werden (gh nicht erreichbar?).");
        } else {
          const p = loadProj();
          const neu = unregistriert();
          let t = "Projekte:\n" + Object.entries(p).map(([k, v]) => `${k} -> ${v}`).join("\n");
          if (neu.length) t += `\n\nNoch nicht registriert (in ${WORK_ROOT}):\n` + neu.map((pf) => "  " + pf.split("/").pop()).join("\n") + "\n\nAlle übernehmen: /projekte scan";
          t += "\n\nEinzeln: /projekte add name [pfad]  (ohne Pfad = " + WORK_ROOT + "/name)";
          t += "\nNeues Repo holen: /neu <reponame> [Auftrag] — klont selbst, der Name darf unscharf sein.";
          t += "\nRepo-Liste neu einlesen: /projekte repos";
          await send(t);
        }
        continue;
      }
      if (text === "/sessions") {
        if (!reg.sessions.length) { await send("Keine Sessions. Schick einfach einen Auftrag oder /neu."); continue; }
        await send(reg.sessions.map((s, i) => `${i + 1}. ${s.titel} [${kurz(s.cwd)}, ${modusName(s.modus)}, ${modellName(s.modell)}${s.branch ? `, ${s.branch}` : s.direkt ? ", direkt" : ""}] - zuletzt ${wann(s.zuletzt)}${s.id === reg.aktiv ? " (aktiv)" : ""}`).join("\n") + "\nWechseln mit /wechsel N");
        continue;
      }
      if (text.startsWith("/wechsel")) {
        const n = parseInt(text.split(/\s+/)[1], 10);
        const ziel = reg.sessions[n - 1];
        if (!ziel) { await send("Unbekannte Nummer. /sessions zeigt die Liste."); continue; }
        mutate((r) => { r.aktiv = ziel.id; });
        await send(`Aktiv: ${ziel.titel} [${kurz(ziel.cwd)}, ${modusName(ziel.modus)}, ${modellName(ziel.modell)}]${ziel.branch ? `\nBranch: ${ziel.branch}` : ""}${ziel.prUrl ? `\nPR: ${ziel.prUrl}` : ""}`);
        continue;
      }
      if (text === "/status") {
        const rcOffen = await rcListe();
        const lage = busy ? `Ein Auftrag läuft gerade${queue.length ? `, ${queue.length} in Warteschlange` : ""}.` : queue.length ? `${queue.length} in Warteschlange.` : "Bereit.";
        const wacht = !HC_URL ? "Außenwache: UNSCHARF (HC_URL nicht gesetzt) — ein Ausfall fällt niemandem auf."
          : hc.letzterFehler ? `Außenwache: FEHLER (${hc.letzterFehler.slice(0, 120)}), zuletzt ok ${hc.letzterOk ? wann(hc.letzterOk) : "nie"}`
          : `Außenwache: scharf, letzter erfolgreicher Fähigkeits-Test ${hc.letzterOk ? wann(hc.letzterOk) : "steht noch aus"}`;
        const rcZeile = rcOffen.length ? `\nRemote Control offen: ${rcOffen.join(", ")}` : "";
        if (cur) await send(`Aktive Session: ${cur.titel}\nVerzeichnis: ${cur.cwd || DEFAULT_CWD}\nModus: ${modusName(cur.modus)}\nModell: ${modellName(cur.modell)}\nArbeitsweise: ${cur.direkt ? "direkt auf dem Hauptbranch" : `Branch + PR${cur.branch ? ` (${cur.branch})` : ""}`}${cur.prUrl ? `\nPR: ${cur.prUrl}` : ""}\nZuletzt: ${wann(cur.zuletzt)}\n${lage}\n${wacht}${rcZeile}\n\nAm Rechner fortsetzen:\nssh -i ~/.ssh/claude_proxmox root@${HOST}\nsu - claude\ncd "${cur.cwd || DEFAULT_CWD}" && claude --resume ${cur.id}`);
        else await send(`Keine aktive Session. ${lage}\n${wacht}${rcZeile}`);
        continue;
      }
      if (text === "/clear") {
        if (!cur) { await send("Keine aktive Session. /neu startet frisch."); continue; }
        mutate((r) => {
          r.sessions = r.sessions.filter((s) => s.id !== cur.id);
          r.aktiv = null; r.naechstesCwd = cur.cwd || DEFAULT_CWD; r.naechsterModus = cur.modus || null;
          r.naechstesModell = cur.modell || null; r.naechsterDirekt = !!cur.direkt;
        });
        await send(`Kontext geleert. Deine nächste Nachricht startet frisch in ${kurz(cur.cwd)} (Modus ${modusName(cur.modus)}).${cur.branch ? `\nDer Branch ${cur.branch} bleibt stehen; die neue Session legt einen eigenen an.` : ""}`);
        continue;
      }
      if (text === "/ende") {
        if (!cur) { await send("Keine aktive Session."); continue; }
        mutate((r) => { r.sessions = r.sessions.filter((s) => s.id !== cur.id); r.aktiv = null; });
        await send(`Abgelegt: ${cur.titel}. Das Transkript bleibt auf dem Server erhalten.`);
        continue;
      }

      if (text === "/rc" || text.startsWith("/rc ")) {
        const teile = text.slice(3).trim().split(/\s+/).filter(Boolean);
        if (teile[0] === "stop") {
          const offen = await rcListe();
          if (!offen.length) { await send("Keine Remote-Control-Sitzung offen."); continue; }
          const name = teile[1] ? rcName(teile[1]) : (cur ? rcName(cur.cwd || DEFAULT_CWD) : offen[0]);
          if (!offen.includes(name)) { await send(`${name} läuft nicht. Offen: ${offen.join(", ")}`); continue; }
          await tmux("kill-session", "-t", name);
          await send(`Beendet: ${name}. Der Gesprächsverlauf bleibt auf dem Server, /rc öffnet eine neue Sitzung.`);
          continue;
        }
        if (teile[0] === "liste") {
          const offen = await rcListe();
          await send(offen.length ? "Offene Remote-Control-Sitzungen:\n" + offen.map((n) => "  " + n).join("\n") : "Keine offen. /rc [projekt] macht eine auf.");
          continue;
        }
        const wunsch = teile[0];
        if (!wunsch) { rcOeffnen(cur ? (cur.cwd || DEFAULT_CWD) : DEFAULT_CWD, ""); continue; }
        const projekte = loadProj();
        if (wunsch.startsWith("/") && existsSync(wunsch)) { rcOeffnen(wunsch, ""); continue; }
        if (projekte[wunsch.toLowerCase()] && existsSync(projekte[wunsch.toLowerCase()])) { rcOeffnen(projekte[wunsch.toLowerCase()], ""); continue; }
        await send(`Suche "${wunsch}" …`);
        const tr = await zielFinden(wunsch);
        if (tr.art === "treffer") {
          const b = await zielBereitstellen(tr.ziel);
          if (!b.ok) { await send(b.meldung); continue; }
          rcOeffnen(b.pfad, norm(tr.ziel.name) === norm(wunsch) ? "" : `Gemeint ist vermutlich ${tr.ziel.name}.`);
        } else if (tr.art === "mehrdeutig") {
          const id = frage({ typ: "rc", liste: tr.liste });
          await send(tr.liste.length === 1 ? `Meintest du ${tr.liste[0].name}?` : `"${wunsch}" passt auf mehrere. Welches?`, {
            reply_markup: { inline_keyboard: tr.liste.map((x, i) => [knopf(`${x.name}${x.quelle === "projekt" ? " (schon da)" : ""}`, id, String(i))]) },
          });
        } else {
          await send(`Kein Projekt und kein eigenes Repo passt auf "${wunsch}".`);
        }
        continue;
      }

      // B1: /neu macht alles selbst — klonen, registrieren, starten. Nie einen Pfad tippen.
      if (text === "/neu" || text.startsWith("/neu ")) {
        const rest = text.slice(4).trim();
        if (!rest) {
          mutate((r) => { r.aktiv = null; r.naechstesCwd = null; });
          await send(`Alles klar, deine nächste Nachricht eröffnet eine neue Session in ${kurz(null)}.`);
          continue;
        }
        const erst = rest.split(/\s+/)[0];
        const auftrag = rest.slice(erst.length).trim();
        const projekte = loadProj();

        if (erst.startsWith("/")) {              // absoluter Pfad
          if (!existsSync(erst)) { await send(`Verzeichnis ${erst} existiert nicht auf dem Server.`); continue; }
          await neuStarten(erst, kurz(erst), auftrag, "");
          continue;
        }
        if (projekte[erst.toLowerCase()] && existsSync(projekte[erst.toLowerCase()])) {
          await zielOeffnen({ name: erst.toLowerCase(), pfad: projekte[erst.toLowerCase()], quelle: "projekt" }, auftrag, "");
          continue;
        }
        await send(`Suche "${erst}" ...`);
        const t = await zielFinden(erst);
        if (t.art === "treffer") {
          const hin = norm(t.ziel.name) === norm(erst) ? "" : `Gemeint ist vermutlich ${t.ziel.name} — ich nehme das.`;
          await zielOeffnen(t.ziel, auftrag, hin);
        } else if (t.art === "mehrdeutig") {
          const id = frage({ typ: "wahl", liste: t.liste, auftrag });
          await send(t.liste.length === 1 ? `Meintest du ${t.liste[0].name}?` : `"${erst}" passt auf mehrere. Welches?`, {
            reply_markup: { inline_keyboard: t.liste.map((x, i) => [knopf(`${x.name}${x.quelle === "projekt" ? " (schon da)" : ""}`, id, String(i))]) },
          });
        } else {
          const nah = t.liste.length ? "\n\nAm nächsten dran:\n" + t.liste.map((x) => "  " + x.name).join("\n") : "";
          await send(`Kein Projekt und kein eigenes Repo passt auf "${erst}".${nah}\n\n/projekte zeigt die registrierten, /projekte repos liest die Repo-Liste neu ein.`);
        }
        continue;
      }

      await einreihen(text, null, cur
        ? `Auftrag läuft in "${cur.titel}" [${kurz(cur.cwd)}, ${modusName(cur.modus)}]. ${DAUER}`
        : `Neue Session in ${kurz(reg.naechstesCwd)} wird eröffnet (Modus ${modusName(reg.naechsterModus)}), Auftrag läuft. ${DAUER}`);
    }
  } catch (e) { fehler("Loop:", (e && e.message) || e); await new Promise((r) => setTimeout(r, 5000)); }
}
