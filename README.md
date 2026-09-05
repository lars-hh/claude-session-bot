# Claude Code per Telegram fernsteuern — Fork für LXC 112

Ein Telegram-Bot, der Claude-Code-Sessions auf einem Linux-Server steuert: Sessions vom Handy eröffnen, Aufträge geben, Berechtigungen per Button freigeben. Zwei Node-Scripts, null Dependencies, kein offener Port.

**Dies ist ein Fork** von [AlphaGenX/claude-telegram-session-bot](https://github.com/AlphaGenX/claude-telegram-session-bot) (MIT), betrieben auf LXC 112 `claude-dev`. Was gegenüber dem Original geändert wurde und **warum**, steht vollständig in **[AENDERUNGEN.md](AENDERUNGEN.md)** — inklusive der Punkte, die auch upstream nützlich wären.

Der Zweck hier ist **Verfügbarkeit, nicht Bequemlichkeit**: der Bot ist die Rückfalllinie an die eigenen Maschinen, wenn kein anderer Weg offen ist. Daraus folgen der Vollmodus als Default, der PR als einzige verbliebene Kontrollstelle und die externe Überwachung.

## Was dieser Fork zusätzlich kann

- **`/neu <repo> [Auftrag]` klont, registriert und startet in einem Zug** — mit unscharfer Namenssuche über die eigenen GitHub-Repos. `sessionbot` findet `claude-session-bot`, `geldwrk` fragt nach `geldwerk`. Nie einen Pfad tippen
- **Branch + Pull Request als Default für jedes Projekt.** Der Bot legt den Branch an, *bevor* Claude läuft, und öffnet danach den PR. `/direkt` ist die Ausnahme pro Session
- **Die Warteschlange überlebt einen Neustart** und fragt beim Start nach, statt Aufträge still zu verschlucken
- **Timeout 2 Stunden** statt 30 Minuten, und ein Abbruch wird als Zwischenstand gemeldet — der PR entsteht trotzdem
- **Capability-Ping an healthchecks.io:** alle 30 Minuten ein winziges `claude -p`, gepingt wird nur bei `is_error: false`
- **`/compact`** verdichtet den Kontext der aktiven Session, mit Gegenprobe am Transkript
- **`/rc [projekt]`** öffnet eine echte Remote-Control-Sitzung und schickt die `claude.ai`-Adresse in den Chat — volle Claude-Code-Oberfläche auf dem Handy
- Antworten kommen **formatiert** an (Markdown → Telegram-HTML) statt mit rohen Sternchen, und der Bot meldet ein **Befehlsmenü** bei Telegram an

## Wie es funktioniert

Der Bot nutzt die dokumentierte Headless-Schnittstelle von Claude Code:

```bash
claude -p "Auftrag" --output-format json          # liefert session_id
claude -p "Folgeauftrag" --resume <session_id>    # setzt fort
```

Berechtigungen delegiert Claude Code per `--permission-prompt-tool` an einen Mini-MCP-Server (`permission-mcp.mjs`), der die Anfrage als Telegram-Buttons stellt und bis zu 5 Minuten auf den Klick wartet.

Drei Dinge, die man kennen muss — alle drei am 2026-09-05 auf Claude Code **2.1.260** nachgemessen:

- **`is_error` prüfen, nie den Exit-Code.** `claude -p` meldet API-Fehler mit Exit 0 **und** `subtype: "success"`; der Fehlertext steht in `result`. Wer das nicht prüft, schickt „Failed to authenticate…" als vermeintliche Claude-Antwort in den Chat, und der Dienst wirkt dabei monatelang gesund.
- **Der Idle-Timeout ist der Killer, nicht der Startup-Timeout.** `MCP_TOOL_TIMEOUT` ist der Startup-Wert; was einen wartenden Freigabe-Prompt abschneidet, ist `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (Default 1800 s bei stdio-Servern).
- **`--resume` behält die Session-ID.** Über vier aufeinanderfolgende `--resume`-Läufe blieb `session_id` unverändert — die Annahme „jeder Aufruf forkt eine neue ID" trifft auf dieser Version nicht zu. Der Bot übernimmt eine geänderte ID trotzdem, falls sich das wieder ändert.

Und eine Falle, die hier dreimal zugeschlagen hat: **eine interaktive Claude-Sitzung darf man nicht umleiten.** Pipe, `tee` oder Logdatei nehmen ihr das TTY, sie fällt auf `--print` zurück und stirbt mit „Input must be provided…". Genau das trieb einen Vorgänger-Dienst in 23.457 Neustarts.

## Betrieb auf LXC 112

| | |
|---|---|
| Container | `claude-dev`, Debian 12, unprivileged, 4 Cores, 8 GB |
| Benutzer | `claude` (**nicht** root — sonst verweigert Claude Code `bypassPermissions`) |
| Scripts | `/home/claude/bin/telegram-session.mjs`, `permission-mcp.mjs`, `perm-mcp.json`, Mode 700 |
| Konfiguration | `/home/claude/.config/telegram-session.env` (`BOT_TOKEN`, `CHAT_ID`, optional `HC_URL`) |
| Projektregister | `/home/claude/.config/claude-projekte.json`, Repo-Katalog `claude-repos.json` |
| Sessions + Warteschlange | `/home/claude/.claude-sessions.json` |
| Dienst | `claude-session-bot.service` — `systemctl status\|restart claude-session-bot` |
| Logs | `journalctl -u claude-session-bot -f` |
| Arbeitsverzeichnis | `/home/claude/work/<repo>` — `/neu` legt die Klone selbst dort an |
| Remote-Control-Sitzungen | tmux, Namen `rc-<projekt>` |

**Nach jedem Deploy prüfen:** `systemctl show claude-session-bot -p NRestarts` muss `0` bleiben. Ein hochzählender Wert ist ein Crash-Loop, kein Schönheitsfehler.

**Externe Überwachung scharf stellen:** Check auf healthchecks.io anlegen (Periode 30 Min, Grace 20 Min), Ping-URL als `HC_URL=` in die env, Dienst neu starten. Fehlt sie, läuft der Bot normal weiter, protokolliert das aber als `Capability-Ping UNSCHARF` und sagt es in `/status` — der unscharfe Zustand soll sichtbar sein, nicht still.

## Befehle

| Befehl | Wirkung |
|---|---|
| *(Nachricht)* | Auftrag an die aktive Session; ohne aktive wird eine neue eröffnet |
| `/neu [repo\|projekt\|/pfad] [Auftrag]` | Projekt öffnen — klont bei Bedarf, unscharfer Name erlaubt |
| `/rc [projekt]` · `/rc liste` · `/rc stop` | Remote-Control-Sitzung öffnen, auflisten, beenden |
| `/direkt [aus]` | Für diese Session direkt auf dem Hauptbranch statt Branch + PR |
| `/compact` | Kontext der aktiven Session verdichten |
| `/projekte` · `add` · `scan` · `repos` | Verzeichnisse zeigen, registrieren, übernehmen, Repo-Liste neu einlesen |
| `/modus [standard\|edits\|plan\|auto\|voll]` | Berechtigungsmodus (Default hier: `voll`) |
| `/modell [opus\|sonnet\|haiku\|standard]` | Sprachmodell je Session |
| `/sessions` · `/wechsel N` | Sessions auflisten und wechseln |
| `/status` | Stand, Branch, PR, Außenwache, SSH-Befehl zum Fortsetzen |
| `/clear` · `/ende` | Kontext leeren bzw. Session ablegen (Transkript bleibt) |

## Stellschrauben

| Wo | Was | Bedeutung |
|---|---|---|
| `telegram-session.env` | `BOT_TOKEN`, `CHAT_ID` | Zugang; die Chat-ID ist die einzige Schranke |
| `telegram-session.env` | `HC_URL` | Ping-Ziel der Außenwache; leer = unscharf, wird laut protokolliert |
| `telegram-session.mjs` | `DEFAULT_MODE` | hier `bypassPermissions` — bewusste Entscheidung, siehe unten |
| `telegram-session.mjs` | `RUN_TIMEOUT` | 2 h je Auftrag |
| `telegram-session.mjs` | `HC_INTERVAL` | Abstand der Fähigkeits-Prüfung (30 Min) |
| `telegram-session.mjs` | `GH_USER`, `REPO_CACHE_TTL` | Repo-Katalog für die unscharfe Suche |
| `telegram-session.mjs` | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` | muss größer sein als die Button-Wartezeit |
| `permission-mcp.mjs` | `300000` in `frage()` | Wartezeit auf den Button (5 Min), danach abgelehnt |

## Sicherheit

- Die **Chat-ID-Whitelist ist die einzige Schranke**. Token geheim halten. Bei Verdacht: `/revoke` bei @BotFather, neuen Token in die env, Dienst neu starten
- `BOT_TOKEN` und `CHAT_ID` werden aus der Umgebung des Claude-Subprozesses **gestrippt** — sonst könnte ein per Prompt Injection gekaperter Agent über den vorgesehenen Kanal mit dem vorgesehenen Token exfiltrieren. Mit Firewall-Regeln nicht zu schließen
- Der Freigabe-MCP kennt **keinen** Token; er tauscht Dateien mit dem Bot aus
- Keine offenen Ports: Long Polling nutzt nur ausgehende HTTPS-Verbindungen
- **`DEFAULT_MODE = "bypassPermissions"` ist eine Entscheidung für diese Maschine, keine Empfehlung.** Der Blast-Radius ist gemessen und akzeptiert (der Benutzer `claude` hat passwortloses `sudo` und ist in der `docker`-Gruppe). Für die meisten Installationen ist der Upstream-Default `acceptEdits` richtiger. Der PR-Diff ist im Vollmodus die einzige verbliebene Kontrollstelle — deshalb ist Branch + PR hier Default und nicht Option

## Versionen

- **v8.2** (2026-09-05): `/rc` öffnet eine Remote-Control-Sitzung und schickt die Adresse
- **v8.1** (2026-09-05): Markdown-Formatierung, Umlaute, Befehlsmenü, keine leeren Branches mehr
- **v8** (2026-09-05): `/neu` mit Auto-Klonen und unscharfer Suche · Branch + PR als Default · persistente Warteschlange · Timeout 2 h · Capability-Ping · `/compact`
- **v7** (2026-09-04): sechs Korrekturen gegenüber Upstream v6.1, tokenloser Freigabe-Relay, Pfade auf Benutzer `claude` — siehe [AENDERUNGEN.md](AENDERUNGEN.md)
- Ältere Versionen: Historie des Originals

## Lizenz

MIT — siehe [LICENSE](LICENSE). Ursprung: [AlphaGenX/claude-telegram-session-bot](https://github.com/AlphaGenX/claude-telegram-session-bot).
