#!/usr/bin/env node
// Permission-MCP v3 (tokenlos) — leitet Claudes Berechtigungsanfragen an den Nutzer weiter.
// Aufruf durch: claude -p ... --permission-prompt-tool mcp__perm__approve
//
// UNTERSCHIED ZUR VORLAGE (AlphaGenX v2): Dieser Prozess kennt den Bot-Token NICHT.
// Er laeuft im Claude-Prozessbaum; ein per Prompt Injection gekaperter Agent koennte
// einen dort vorhandenen Token lesen und an beliebige chat_id senden. Deshalb:
//   - MCP schreibt   PERM_DIR/<id>.req   (Anfrage als JSON)
//   - Bot-Prozess    liest .req, sendet via Telegram, schreibt PERM_DIR/<id>  (ja|nein)
//   - MCP liest      PERM_DIR/<id>       und loescht sie
// Der Token bleibt damit ausschliesslich im Bot-Prozess.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";

const DIR = process.env.PERM_DIR || "/home/claude/.perm";
const TIMEOUT_MS = Number(process.env.PERM_TIMEOUT_MS || 300000); // 5 Minuten
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const kurzInput = (inp) => {
  try {
    if (inp && typeof inp.command === "string") return inp.command.slice(0, 600);
    const s = JSON.stringify(inp);
    return s.length > 600 ? s.slice(0, 600) + "..." : s;
  } catch { return String(inp); }
};

async function frage(toolName, input) {
  mkdirSync(DIR, { recursive: true });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const reqFile = `${DIR}/${id}.req`;
  const ansFile = `${DIR}/${id}`;

  // Anfrage ablegen — der Bot-Prozess pollt dieses Verzeichnis
  writeFileSync(reqFile, JSON.stringify({
    id,
    tool: String(toolName || "unbekannt"),
    detail: kurzInput(input),
    ts: Date.now(),
    timeout_ms: TIMEOUT_MS,
  }), { mode: 0o600 });

  const ende = Date.now() + TIMEOUT_MS;
  while (Date.now() < ende) {
    await new Promise((r) => setTimeout(r, 1000));
    if (existsSync(ansFile)) {
      let antwort = "";
      try { antwort = readFileSync(ansFile, "utf8").trim(); } catch {}
      try { unlinkSync(ansFile); } catch {}
      try { if (existsSync(reqFile)) unlinkSync(reqFile); } catch {}
      return antwort === "ja";
    }
  }
  // Abgelaufen: Anfrage zuruecknehmen, damit der Bot sie als abgelaufen kennzeichnen kann
  try { if (existsSync(reqFile)) writeFileSync(reqFile + ".expired", "1", { mode: 0o600 }); } catch {}
  return false;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  try {
    if (m.method === "initialize") {
      out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "perm", version: "3.0.0" } } });
    } else if (m.method === "tools/list") {
      out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "approve", description: "Fragt per Telegram um Erlaubnis fuer eine Tool-Nutzung", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" } }, required: ["tool_name", "input"] } }] } });
    } else if (m.method === "tools/call" && m.params && m.params.name === "approve") {
      const a = m.params.arguments || {};
      const ok = await frage(a.tool_name || "unbekannt", a.input || {});
      const ergebnis = ok
        ? { behavior: "allow", updatedInput: a.input || {} }
        : { behavior: "deny", message: "Abgelehnt oder keine Antwort innerhalb der Frist." };
      out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(ergebnis) }] } });
    } else if (m.id !== undefined) {
      out({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  } catch (e) {
    if (m && m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: String((e && e.message) || e).slice(0, 200) } });
  }
});
