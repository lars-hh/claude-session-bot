#!/usr/bin/env node
// Session-Bot v7 (LXC 112) — steuert Claude-Code-Sessions per Telegram.
// Abgeleitet von AlphaGenX/claude-telegram-session-bot v6.1 (MIT), mit sechs Korrekturen:
//   1. MODI.standard: "default" existiert nicht mehr -> "manual"
//   2. CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT statt MCP_TOOL_TIMEOUT (der echte Killer)
//   3. is_error wird geprueft — claude -p liefert bei API-Fehlern Exit 0 UND subtype:"success"
//   4. BOT_TOKEN/CHAT_ID werden aus der Claude-Subprozess-Env gestrippt
//   5. Permission-Relay ueber Dateien statt direktem Telegram-Call im MCP (Token bleibt hier)
//   6. Pfade auf User claude statt root
// Befehle: /neu [projekt|/pfad] [Auftrag], /projekte [add name /pfad], /modus, /modell,
//          /sessions, /wechsel N, /status, /clear, /ende
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = Number(process.env.CHAT_ID);
if (!TOKEN || !CHAT_ID) { console.error("BOT_TOKEN und CHAT_ID muessen gesetzt sein"); process.exit(1); }
const API = `https://api.telegram.org/bot${TOKEN}`;

const HOME = "/home/claude";
const REG = `${HOME}/.claude-sessions.json`;
const PROJ = `${HOME}/.config/claude-projekte.json`;
const PERM_DIR = `${HOME}/.perm`;
const DEFAULT_CWD = `${HOME}/work`;
const DEFAULT_MODE = "bypassPermissions"; // Lars-Entscheidung 2026-09-04, Blast-Radius akzeptiert
const WORK_ROOT = `${HOME}/work`;         // hier entstehen Projekte; /projekte findet sie selbst
const CLAUDE = "/usr/bin/claude";
const HOST = "192.168.1.139";

// Korrektur 4: Token und Chat-ID NICHT an den Claude-Subprozess weiterreichen.
// Sonst kann ein per Prompt Injection gekaperter Agent den Bot-Token lesen und an
// beliebige chat_id senden — mit Firewall-Regeln nicht zu verhindern.
const { BOT_TOKEN: _t, CHAT_ID: _c, ...SAFE_ENV } = process.env;
const ENV = {
  ...SAFE_ENV,
  HOME,
  PERM_DIR,
  // Korrektur 2: MCP_TOOL_TIMEOUT ist der Startup-Timeout. Der Killer bei langen
  // Freigabe-Wartezeiten ist der Idle-Timeout (Default 1800s bei stdio-Servern).
  CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "1800000",
  PATH: `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
};

// Korrektur 1: "default" ist als permission-mode nicht mehr gueltig.
// Gueltig: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan
const MODI = { standard: "manual", edits: "acceptEdits", plan: "plan", auto: "auto", voll: "bypassPermissions" };
const modusName = (wert) => (Object.entries(MODI).find(([, v]) => v === (wert || DEFAULT_MODE)) || ["voll"])[0];

const MODELLE = { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };
const modellName = (wert) => (Object.entries(MODELLE).find(([, v]) => v === wert) || ["standard"])[0];

const load = () => { try { return JSON.parse(readFileSync(REG, "utf8")); } catch { return { sessions: [], aktiv: null, naechstesCwd: null, naechsterModus: null, naechstesModell: null }; } };
const save = (r) => writeFileSync(REG, JSON.stringify(r, null, 2), { mode: 0o600 });
const loadProj = () => { try { return JSON.parse(readFileSync(PROJ, "utf8")); } catch { return { work: DEFAULT_CWD }; } };
const saveProj = (p) => writeFileSync(PROJ, JSON.stringify(p, null, 2), { mode: 0o600 });
const kurz = (cwd) => {
  const c = cwd || DEFAULT_CWD;
  const hit = Object.entries(loadProj()).find(([, v]) => v === c);
  return hit ? hit[0] : c.split("/").filter(Boolean).pop();
};
const wann = (t) => new Date(t).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const DAUER = "Antwort kommt meist unter einer Minute, groessere Auftraege brauchen laenger.";

async function tg(method, body) {
  try {
    const r = await fetch(`${API}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { console.error(new Date().toISOString(), "TG:", (e && e.message) || e); return null; }
}

async function send(text) {
  let s = String(text ?? "").trim() || "(leere Antwort)";
  if (s.length > 15200) s = s.slice(0, 15200) + "\n[gekuerzt]";
  for (let i = 0; i < s.length; i += 3800) await tg("sendMessage", { chat_id: CHAT_ID, text: s.slice(i, i + 3800) });
}

// ---------------------------------------------------------------------------
// Korrektur 5: Permission-Relay. Der MCP legt <id>.req ab und kennt keinen Token.
// Dieser Watcher verschickt die Anfrage und schreibt die Antwort als <id> zurueck.
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
  } catch (e) { console.error(new Date().toISOString(), "PermWatch:", (e && e.message) || e); }
}
setInterval(permWatch, 1000);

function runClaude(auftrag, resumeId, cwd, modus, modell) {
  return new Promise((resolve) => {
    const args = ["-p", auftrag, "--output-format", "json", "--permission-mode", modus || DEFAULT_MODE,
      "--allowedTools", "WebSearch,WebFetch",
      "--permission-prompt-tool", "mcp__perm__approve",
      "--mcp-config", `${HOME}/bin/perm-mcp.json`];
    if (modell) args.push("--model", modell);
    if (resumeId) args.push("--resume", resumeId);
    const kind = execFile(CLAUDE, args, { cwd: cwd || DEFAULT_CWD, env: ENV, timeout: 1800000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
      if (e && !out) return resolve({ ok: false, error: String((e && e.message) || e).slice(-400) });
      let j;
      try { j = JSON.parse(out); }
      catch { return resolve({ ok: false, error: "Antwort nicht lesbar: " + String(out).slice(0, 300) }); }
      // Korrektur 3: claude -p meldet API-Fehler mit Exit 0 UND subtype:"success".
      // Nur is_error ist verlaesslich — sonst landet z.B. "OAuth session expired"
      // als vermeintliche Claude-Antwort im Chat und der Bot wirkt monatelang gesund.
      if (j.is_error === true) {
        const grund = j.result || j.api_error_status || j.terminal_reason || "unbekannter API-Fehler";
        return resolve({ ok: false, error: `Claude meldet einen Fehler: ${String(grund).slice(0, 400)}` });
      }
      resolve({ ok: true, result: j.result || "(kein Ergebnis)", sid: j.session_id || resumeId || null });
    });
    kind.stdin.end(); // sonst wartet Claude 3 Sekunden auf stdin
  });
}

const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const item = queue.shift();
    const reg = load();
    const cur = reg.sessions.find((s) => s.id === reg.aktiv) || null;
    const cwd = cur ? (cur.cwd || DEFAULT_CWD) : (item.cwd || reg.naechstesCwd || DEFAULT_CWD);
    const modus = cur ? (cur.modus || DEFAULT_MODE) : (reg.naechsterModus || DEFAULT_MODE);
    const modell = cur ? (cur.modell || null) : (reg.naechstesModell || null);
    const r = await runClaude(item.text, cur ? cur.id : null, cwd, modus, modell);
    if (!r.ok) { await send("Fehlgeschlagen: " + r.error); continue; }
    const reg2 = load();
    if (cur) {
      const s = reg2.sessions.find((x) => x.id === cur.id);
      if (s) { s.id = r.sid || s.id; s.zuletzt = Date.now(); }
      if (reg2.aktiv === cur.id) reg2.aktiv = r.sid || cur.id;
    } else if (r.sid && !reg2.sessions.some((x) => x.id === r.sid)) {
      reg2.sessions.push({ id: r.sid, titel: item.text.slice(0, 48), cwd, modus, modell, erstellt: Date.now(), zuletzt: Date.now() });
      if (reg2.sessions.length > 15) reg2.sessions = reg2.sessions.slice(-15);
      if (!reg2.aktiv) reg2.aktiv = r.sid;
      reg2.naechstesCwd = null; reg2.naechsterModus = null; reg2.naechstesModell = null;
    }
    save(reg2);
    await send(r.result);
  }
  busy = false;
}

let offset = 0;
console.log(new Date().toISOString(), "Session-Bot v7 gestartet (LXC 112, User claude)");
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
                  text: ((antwort === "ja" ? "ERLAUBT - Claude fuehrt aus:\n" : "ABGELEHNT - Claude ueberspringt:\n") + orig).slice(0, 4000) });
              }
            } catch (e) { console.error(new Date().toISOString(), "Perm:", (e && e.message) || e); note = "Fehler"; }
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

      if (text === "/start") {
        await send("Session-Bot bereit (LXC 112). Jede Nachricht ist ein Auftrag an die aktive Claude-Session.\n\n/neu [projekt] [Auftrag] - neue Session, Verzeichnis waehlbar\n/projekte - Verzeichnisse zeigen, mit add registrieren\n/modus [standard|edits|plan|auto|voll] - Berechtigungsmodus\n/modell [opus|sonnet|haiku|standard] - Sprachmodell\n/sessions - alle Sessions\n/wechsel N - Session wechseln\n/status - Stand plus SSH-Befehl zum Fortsetzen\n/clear - Kontext leeren\n/ende - aktive Session ablegen\n\nWeb-Suche ist erlaubt. Braucht Claude weitere Rechte, kommt eine Freigabe-Anfrage mit Buttons. " + DAUER);
        continue;
      }
      if (text === "/modus" || text.startsWith("/modus ")) {
        const arg = text.slice(6).trim().toLowerCase();
        if (!arg) {
          await send(`Aktueller Modus${cur ? ` der Session "${cur.titel}"` : " fuer die naechste Session"}: ${cur ? modusName(cur.modus) : modusName(reg.naechsterModus)}\n\nVerfuegbar:\nstandard - fragt per Button an, auch bei Dateiaenderungen\nedits - Dateiaenderungen automatisch, Rest per Button\nplan - nur lesen und planen\nauto - Claude entscheidet selbst\nvoll - keine Nachfragen (STANDARD auf dieser Maschine)\n\nHinweis: "edits" genehmigt auch rm, mv, cp und sed im Arbeitsverzeichnis automatisch.`);
        } else if (!MODI[arg]) {
          await send("Unbekannter Modus. Verfuegbar: standard, edits, plan, auto, voll");
        } else {
          const warn = arg === "voll" ? "\nVorsicht: Claude fragt in dieser Session nichts mehr an."
                     : arg === "edits" ? "\nHinweis: genehmigt auch rm/mv/cp/sed im Arbeitsverzeichnis." : "";
          if (cur) {
            const s = reg.sessions.find((x) => x.id === cur.id);
            if (s) s.modus = MODI[arg];
            save(reg);
            await send(`Modus fuer "${cur.titel}": ${arg}${warn}`);
          } else {
            reg.naechsterModus = MODI[arg]; save(reg);
            await send(`Modus fuer die naechste Session: ${arg}${warn}`);
          }
        }
        continue;
      }
      if (text === "/modell" || text.startsWith("/modell ")) {
        const arg = text.slice(7).trim().toLowerCase();
        if (!arg) {
          await send(`Aktuelles Modell${cur ? ` der Session "${cur.titel}"` : " fuer die naechste Session"}: ${cur ? modellName(cur.modell) : modellName(reg.naechstesModell)}\n\nVerfuegbar: opus, sonnet, haiku, standard`);
        } else if (arg !== "standard" && !MODELLE[arg]) {
          await send("Unbekanntes Modell. Verfuegbar: opus, sonnet, haiku, standard");
        } else {
          const wert = arg === "standard" ? null : MODELLE[arg];
          if (cur) {
            const s = reg.sessions.find((x) => x.id === cur.id);
            if (s) s.modell = wert;
            save(reg);
            await send(`Modell fuer "${cur.titel}": ${arg}`);
          } else { reg.naechstesModell = wert; save(reg); await send(`Modell fuer die naechste Session: ${arg}`); }
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
        } else {
          const p = loadProj();
          const neu = unregistriert();
          let t = "Projekte:\n" + Object.entries(p).map(([k, v]) => `${k} -> ${v}`).join("\n");
          if (neu.length) t += `\n\nNoch nicht registriert (in ${WORK_ROOT}):\n` + neu.map((pf) => "  " + pf.split("/").pop()).join("\n") + "\n\nAlle uebernehmen: /projekte scan";
          t += "\n\nEinzeln: /projekte add name [pfad]  (ohne Pfad = " + WORK_ROOT + "/name)";
          t += "\nNeues Repo holen: schick einfach \"clone lars-hh/<repo> nach ~/work/<repo>\" als Auftrag.";
          await send(t);
        }
        continue;
      }
      if (text === "/sessions") {
        if (!reg.sessions.length) { await send("Keine Sessions. Schick einfach einen Auftrag oder /neu."); continue; }
        await send(reg.sessions.map((s, i) => `${i + 1}. ${s.titel} [${kurz(s.cwd)}, ${modusName(s.modus)}, ${modellName(s.modell)}] - zuletzt ${wann(s.zuletzt)}${s.id === reg.aktiv ? " (aktiv)" : ""}`).join("\n") + "\nWechseln mit /wechsel N");
        continue;
      }
      if (text.startsWith("/wechsel")) {
        const n = parseInt(text.split(/\s+/)[1], 10);
        const ziel = reg.sessions[n - 1];
        if (!ziel) { await send("Unbekannte Nummer. /sessions zeigt die Liste."); continue; }
        reg.aktiv = ziel.id; save(reg);
        await send(`Aktiv: ${ziel.titel} [${kurz(ziel.cwd)}, ${modusName(ziel.modus)}, ${modellName(ziel.modell)}]`);
        continue;
      }
      if (text === "/status") {
        const lage = busy ? `Ein Auftrag laeuft gerade${queue.length ? `, ${queue.length} in Warteschlange` : ""}.` : "Bereit.";
        if (cur) await send(`Aktive Session: ${cur.titel}\nVerzeichnis: ${cur.cwd || DEFAULT_CWD}\nModus: ${modusName(cur.modus)}\nModell: ${modellName(cur.modell)}\nZuletzt: ${wann(cur.zuletzt)}\n${lage}\n\nAm Rechner fortsetzen:\nssh -i ~/.ssh/claude_proxmox root@${HOST}\nsu - claude\ncd "${cur.cwd || DEFAULT_CWD}" && claude --resume ${cur.id}`);
        else await send(`Keine aktive Session. ${lage}`);
        continue;
      }
      if (text === "/clear") {
        if (!cur) { await send("Keine aktive Session. /neu startet frisch."); continue; }
        reg.sessions = reg.sessions.filter((s) => s.id !== cur.id);
        reg.aktiv = null; reg.naechstesCwd = cur.cwd || DEFAULT_CWD; reg.naechsterModus = cur.modus || null; reg.naechstesModell = cur.modell || null; save(reg);
        await send(`Kontext geleert. Deine naechste Nachricht startet frisch in ${kurz(cur.cwd)} (Modus ${modusName(cur.modus)}).`);
        continue;
      }
      if (text === "/ende") {
        if (!cur) { await send("Keine aktive Session."); continue; }
        reg.sessions = reg.sessions.filter((s) => s.id !== cur.id);
        reg.aktiv = null; save(reg);
        await send(`Abgelegt: ${cur.titel}. Das Transkript bleibt auf dem Server erhalten.`);
        continue;
      }
      if (text === "/neu" || text.startsWith("/neu ")) {
        const rest = text.slice(4).trim();
        const projekte = loadProj();
        let cwd = null, auftrag = rest;
        const erst = rest.split(/\s+/)[0] || "";
        if (projekte[erst.toLowerCase()]) { cwd = projekte[erst.toLowerCase()]; auftrag = rest.slice(erst.length).trim(); }
        else if (erst.startsWith("/") && existsSync(erst)) { cwd = erst; auftrag = rest.slice(erst.length).trim(); }
        if (cwd && !existsSync(cwd)) { await send(`Verzeichnis ${cwd} existiert nicht mehr. /projekte zeigt die Liste.`); continue; }
        reg.aktiv = null; reg.naechstesCwd = cwd; save(reg);
        if (auftrag) { queue.push({ text: auftrag, cwd }); await send(`Neue Session in ${kurz(cwd)} wird eroeffnet, Auftrag laeuft. ${DAUER}`); pump(); }
        else await send(`Alles klar, deine naechste Nachricht eroeffnet eine neue Session in ${kurz(cwd)} (Modus ${modusName(reg.naechsterModus)}).`);
        continue;
      }
      queue.push({ text, cwd: null });
      await send(busy ? `Eingereiht, Position ${queue.length}.` : cur ? `Auftrag laeuft in "${cur.titel}" [${kurz(cur.cwd)}, ${modusName(cur.modus)}]. ${DAUER}` : `Neue Session in ${kurz(reg.naechstesCwd)} wird eroeffnet (Modus ${modusName(reg.naechsterModus)}), Auftrag laeuft. ${DAUER}`);
      pump();
    }
  } catch (e) { console.error(new Date().toISOString(), "Loop:", (e && e.message) || e); await new Promise((r) => setTimeout(r, 5000)); }
}
