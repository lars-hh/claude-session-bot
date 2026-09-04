# Änderungen gegenüber AlphaGenX/claude-telegram-session-bot

Fork von [AlphaGenX/claude-telegram-session-bot](https://github.com/AlphaGenX/claude-telegram-session-bot)
(MIT), Stand v6.1 vom 2026-09-04. Betrieben auf LXC 112 `claude-dev` (Debian 12, unprivileged
Container, User `claude`, Claude Code 2.1.260).

Diese Datei hält fest, **was geändert wurde und warum** — und markiert, was davon nicht an unsere
Umgebung gebunden ist und deshalb upstream nützlich wäre.

## 1. `permission-mode "default"` existiert nicht mehr → `"manual"`

```diff
- const MODI = { standard: "default", edits: "acceptEdits", plan: "plan", voll: "bypassPermissions" };
+ const MODI = { standard: "manual", edits: "acceptEdits", plan: "plan", auto: "auto", voll: "bypassPermissions" };
```

Gültige Werte auf 2.1.220 und 2.1.260: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`.
Mit `default` bricht `/modus standard` ab.

**Upstream-relevant: ja** — betrifft jeden Nutzer, unabhängig von der Umgebung.

## 2. Falsche Timeout-Variable

```diff
- MCP_TOOL_TIMEOUT: "360000"
+ CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "1800000"
```

`MCP_TOOL_TIMEOUT` ist der **Startup**-Timeout. Was einen wartenden Permission-Prompt killt, ist der
**Idle**-Timeout: 300 s bei Netzwerk-, 1800 s bei stdio-Servern. Der Permission-MCP wartet bis zu
5 Minuten auf einen Button-Klick und liegt damit genau in diesem Fenster.

**Upstream-relevant: ja** — der bisherige Fix wirkt nur zufällig.

## 3. `is_error` wird nicht geprüft (der gefährlichste Punkt)

```diff
  const j = JSON.parse(out);
+ if (j.is_error === true) {
+   const grund = j.result || j.api_error_status || j.terminal_reason || "unbekannter API-Fehler";
+   return resolve({ ok: false, error: `Claude meldet einen Fehler: ${grund}` });
+ }
  resolve({ ok: true, result: j.result || "(kein Ergebnis)", sid: j.session_id || resumeId || null });
```

`claude -p` meldet API-Fehler mit **Exit 0 und `subtype: "success"`** — der Fehlertext steht in
`result`. Wer nur den Exit-Code oder `subtype` prüft, schickt Fehlermeldungen als vermeintliche
Claude-Antwort in den Chat, und der Dienst wirkt dabei monatelang gesund.

**Am 2026-09-04 auf LXC 112 live reproduziert:**

```json
{"is_error": true, "subtype": "success", "terminal_reason": "api_error",
 "result": "Failed to authenticate: OAuth session expired and could not be refreshed"}
```

Ohne diese Prüfung wäre „Failed to authenticate…" als Antwort im Telegram-Chat gelandet.

**Upstream-relevant: ja, mit Priorität.**

## 4. Bot-Token wird an den Claude-Subprozess weitergereicht

```diff
- const ENV = { ...process.env, HOME: "/root", ... };
+ const { BOT_TOKEN: _t, CHAT_ID: _c, ...SAFE_ENV } = process.env;
+ const ENV = { ...SAFE_ENV, HOME, PERM_DIR, ... };
```

`{...process.env}` reicht `BOT_TOKEN` und `CHAT_ID` an Claude weiter. `sendMessage` akzeptiert jede
`chat_id`, und `api.telegram.org` muss erreichbar sein, damit der Bot funktioniert — ein per Prompt
Injection gekaperter Agent exfiltriert also über den vorgesehenen Kanal mit dem vorgesehenen Token.
Mit Firewall-Regeln nicht zu schließen.

**Upstream-relevant: ja** — Sicherheit, umgebungsunabhängig.

## 5. Permission-MCP arbeitet tokenlos (Umbau, kein Bugfix)

Vorher rief `permission-mcp.mjs` die Telegram-API **selbst** auf und brauchte dafür den Token — in
einem Prozess, den Claude als stdio-Subprozess startet. Punkt 4 allein reicht deshalb nicht.

Jetzt:

```
MCP  schreibt  PERM_DIR/<id>.req   (JSON: tool, detail, ts)   ← kennt keinen Token
Bot  liest .req → sendet via Telegram → schreibt PERM_DIR/<id>  (ja|nein)
MCP  liest <id>, löscht beide Dateien
```

Der Token bleibt damit ausschließlich im Bot-Prozess. Timeout und Ablauf-Kennzeichnung
(`<id>.req.expired`) funktionieren unverändert.

**Upstream-relevant: als PR, nicht als Issue** — das ist ein Architektur-Umbau, keine Zeile.

## 6. Pfade und Umgebung

`/root` → `/home/claude`, `CLAUDE` auf `/usr/bin/claude`, `HOST` gesetzt, `DEFAULT_CWD` auf ein
Arbeitsverzeichnis statt des Vaults.

Nebenbei entfällt damit die Einschränkung aus dem Original-Kommentar: `bypassPermissions` verweigert
Claude Code **als root** grundsätzlich — als normaler User funktioniert es (auf 2.1.260 verifiziert).

**Upstream-relevant: nein** — das ist unsere Umgebung.

## Zusätzlich: Projektverwaltung entschärft

`/projekte` zeigt jetzt auch **nicht registrierte** Verzeichnisse unter `~/work`, `/projekte scan`
übernimmt sie alle, und bei `/projekte add <name>` ist der Pfad optional (Default `~/work/<name>`).
Grund: auf dem Handy ist das Tippen absoluter Pfade der Punkt, an dem man es sein lässt.

**Upstream-relevant: als PR denkbar.**

## Betriebsentscheidung dieser Installation

`DEFAULT_MODE = "bypassPermissions"` — bewusst gewählt, mit gemessenem und akzeptiertem
Blast-Radius (User `claude` hat passwortloses `sudo` und ist in der `docker`-Gruppe). **Das ist
keine Empfehlung**, sondern eine Entscheidung für diese Maschine. Der Default im Upstream
(`acceptEdits`) ist für die meisten Installationen richtiger.
