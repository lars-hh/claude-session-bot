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

---

# v8 (2026-09-05) — Ausbaustufen 1 und 2

Grundlage ist der Grill vom 2026-09-04 (`second-brain/artifacts/brainstorms/2026-09-04-claude-session-bot-features.md`),
dort „Die sieben Bauteile". Gebaut sind **1, 2, 5, 6, 7**. Die Bauteile **3** (Fortschritt aus dem
Live-Transkript) und **4** (Nebenläufigkeit pro Projekt) sind bewusst offen — Stufe 3.

Der tragende Satz aus dem Grill: *„wenn kein Cloud offen ist mit Remote Control, komme ich gar nicht
mehr ran."* Der Bot ist eine **Rückfalllinie**, kein Bequemlichkeits-Kanal — daraus folgt jede
Entscheidung unten, insbesondere das laute Melden statt des stillen Verschluckens.

## B1 — `/neu <repo>` klont, registriert und startet in einem Zug

Vorher drei Schritte (klonen lassen → `/projekte scan` → `/neu`), und man musste den exakten Namen
kennen. Jetzt ein Befehl, und der Name darf daneben liegen:

```
/neu sessionbot Ergänze die README um einen Abschnitt zur Warteschlange
```

Auflösungsreihenfolge: registriertes Projekt → absoluter Pfad → **unscharfe Suche über die eigenen
GitHub-Repos** (`gh repo list lars-hh`, 6 h gecacht in `~/.config/claude-repos.json`). Ein sicherer
Treffer wird genommen und benannt, mehrere Kandidaten kommen als Buttons, nichts wird geraten.

Die Bewertung (`punkte()`) ist bewusst schlicht: exakt = 100 · Präfix ≥ 78 · Teilstring 76 ·
Levenshtein-Nähe 45–68. Gemessen: `sessionbot` → `claude-session-bot` (80), `second brain` →
`second-brain` (100), `geldwrk` → Rückfrage auf `geldwerk` (62), `xyzabc123` → nichts.

**Bestehender Klon:** ist er sauber, wird `git pull --ff-only` versucht; ein rein lokaler Branch
ohne Upstream wird übersprungen statt mit einer Fehlermeldung quittiert. Ist er **schmutzig**, wird
*nicht* gepullt, sondern gefragt — mit Optionen statt bloßem Zustandsbericht (Q3: *„melden, mit
sinnvollen Vorschlägen"*): behalten und weiter · stashen · verwerfen · abbrechen.

## B2 — Branch + PR ist der Default, `/direkt` die Ausnahme

Der Bot legt den Branch **vor** dem Lauf an (`claude/<slug>-<MMTT-hhmm>`) und pusht danach selbst.
Damit kann `main` auch dann nicht getroffen werden, wenn Claude den Hinweis im Prompt ignoriert —
die Sicherung liegt im Bot, nicht in der Bitte an das Modell.

Nach dem Lauf: Commits zählen, pushen, `gh pr create`. Kein Commit, aber geänderte Dateien → das
wird gesagt statt verschwiegen. Folgeaufträge derselben Session bleiben auf dem Branch und
aktualisieren denselben PR.

Begründung aus Q6: im Vollmodus sind die Freigabe-Buttons abgeschaltet, **der PR-Diff ist damit die
einzige verbliebene Kontrollstelle** — und Mergen ist auf dem Handy zwei Sekunden.

> **Bug, den der Selbsttest gefunden hat:** In einem **Fork** zielt `gh pr create` ohne `--repo` auf
> das *Upstream*-Repo und scheitert mit „No commits between main and claude/…". Genau dieses Repo
> ist ein Fork, der Fehler war also nicht theoretisch. Das Ziel-Repo wird jetzt aus der
> `origin`-URL abgeleitet und explizit gesetzt.

`/direkt` schaltet die laufende Session auf den Hauptbranch, `/direkt aus` zurück. Hat die Session
schon einen Branch, wird das **abgelehnt** statt halb ausgeführt — sonst bliebe ein verwaister
halbfertiger Branch zurück.

## B5 — Die Warteschlange überlebt einen Neustart

Vorher `const queue = []` im RAM: bei `Restart=on-failure` verschwanden eingereihte Aufträge
**still**, nachdem man „Eingereiht, Position 2" gelesen hatte. Jetzt liegen `warteschlange` und der
gerade `laufend`e Auftrag in `.claude-sessions.json`.

Beim Start wird **gefragt, nicht automatisch fortgesetzt** — sonst wird halbfertige Arbeit doppelt
gemacht —, aber mit Ein-Klick-Wiederaufnahme: „2 Aufträge waren offen … [Alle erneut einreihen]
[Verwerfen]". Lief einer bereits, steht das dabei.

Nebenbei behoben: Nachrichtenschleife und `pump()` laufen nebenläufig und hielten beide ein eigenes
`reg`-Objekt fest — ein `save()` konnte das andere überschreiben. Alle Schreibzugriffe gehen jetzt
über `mutate()` (frisch laden, ändern, schreiben).

## B6 — Timeout 30 Min → 2 h, Abbruch ist ein Zwischenstand

30 Minuten reichen für ein echtes Refactoring nicht. Wichtiger als die Zahl ist die Behandlung:
ein Abbruch wurde vorher als *„Antwort nicht lesbar"* gemeldet, weil die Teilausgabe in den
JSON-Parser lief. Jetzt wird `e.killed`/`e.signal` **zuerst** geprüft und der Abbruch als solcher
benannt — mit dem Hinweis, wo die Arbeit liegt.

**Und der PR-Abschluss läuft nach einem Abbruch trotzdem.** Genau dann ist er wertvoll: was Claude
in zwei Stunden committet hat, ist nach dem Abbruch als PR auf dem Handy sichtbar.

## B7 — Capability-Ping an healthchecks.io

Alle 30 Minuten ein winziges `claude -p "Antworte nur mit OK." --model haiku --permission-mode plan`
(gemessen 3,2 s). Gepingt wird **nur bei `is_error: false`**; ein Fehler pingt `/fail` und alarmiert
sofort statt erst nach der Grace-Zeit.

Der Unterschied ist der Punkt: ein reiner Prozess-Ping hätte den Ausfall vom 2026-09-04 **nicht**
gefunden — der Dienst lief, nur der Login war seit Monaten tot. Es wird die **Fähigkeit** gepingt,
nicht die Existenz.

Konfiguration über `HC_URL` in `~/.config/telegram-session.env`. **Ist sie leer, wird das laut
protokolliert** („Capability-Ping UNSCHARF") und `/status` sagt es ebenfalls — derselbe Grundsatz
wie im Dead-Man-Switch des Proxmox-Hosts: der unscharfe Zustand soll sichtbar sein, nicht still.
`HC_URL` wird wie `BOT_TOKEN` aus der Claude-Subprozess-Env gestrippt.

## Dazu: `/compact`

In der Channels-Anleitung im Vault stand, `/compact` sei über Telegram nicht auslösbar. Das
ist widerlegt. Am 2026-09-05 auf LXC 112 an einer **echten vollen Session** gemessen (4 Turns,
36 Transkriptzeilen):

| | vorher | nachher |
|---|---|---|
| Transkriptzeilen | 36 | 50 |
| `compact_boundary` | 0 | 1 |
| Session-ID | unverändert | unverändert |
| Codewort aus Turn 1 abrufbar | — | **ja** |

`num_turns: 0` und ein leeres `result` sind die **normale Signatur eines Slash-Commands im
`-p`-Modus**, kein Nichtstun — das war die Fehldeutung der ersten Messung an einer leeren Session.
`--autocompact <auto|tokens>` existiert, wird für den expliziten Fall aber nicht gebraucht.

Weil die Rückgabe leer ist, misst `/compact` das Ergebnis selbst: `compact_boundary` im Transkript
vorher gegen nachher. Ohne diese Gegenprobe würde der Befehl „(leere Antwort)" melden.

## Was v8 nicht kann (bewusst)

- **Bauteil 3 und 4** (Fortschritt aus dem Transkript, Nebenläufigkeit pro Projekt) — Stufe 3.
- Bricht eine **neue** Session im Timeout ab, ist ihre Session-ID unbekannt (die liefert `claude -p`
  erst am Ende). Die Dateien und der Branch sind da, aber `/wechsel` findet die Session nicht. Die
  Auflösung — neueste `.jsonl` im Projektverzeichnis — gehört zu Bauteil 3 und wartet darauf.
- Der Vault-Klon hängt an einem read-only Deploy-Key. Ein Push dorthin scheitert und wird ehrlich
  gemeldet; er wird nicht heimlich auf HTTPS umgebogen.

## Selbsttest

Die Maschinerie wurde am 2026-09-05 gegen echte Repos, echtes `gh` und echtes `git` auf LXC 112
geprüft (unscharfe Suche, Klonen, schmutziger Klon, Branch, PR anlegen, PR aktualisieren,
Queue-Persistenz über einen simulierten Crash, Abbruch-Erkennung). Der einzige gefundene Fehler ist
der Fork-Fall oben; er ist behoben und der Test danach vollständig grün. Der Test-PR (#1) wurde
geschlossen, der Branch gelöscht.

---

## Betriebsentscheidung dieser Installation

`DEFAULT_MODE = "bypassPermissions"` — bewusst gewählt, mit gemessenem und akzeptiertem
Blast-Radius (User `claude` hat passwortloses `sudo` und ist in der `docker`-Gruppe). **Das ist
keine Empfehlung**, sondern eine Entscheidung für diese Maschine. Der Default im Upstream
(`acceptEdits`) ist für die meisten Installationen richtiger.
