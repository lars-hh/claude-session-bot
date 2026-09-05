# Änderungen gegenüber AlphaGenX/claude-telegram-session-bot

Fork von [AlphaGenX/claude-telegram-session-bot](https://github.com/AlphaGenX/claude-telegram-session-bot)
(MIT), Stand v6.1 vom 2026-09-04. Betrieben auf LXC 112 `claude-dev` (Debian 12, unprivileged
Container, User `claude`, Claude Code 2.1.260).

Diese Datei hält fest, **was geändert wurde und warum** — und markiert, was davon nicht an unsere
Umgebung gebunden ist und deshalb upstream nützlich wäre.

## Stand gegenüber dem Original (geprüft 2026-09-05)

Abzweigpunkt: `0ac515f` — Upstream v6.1 vom 2026-09-04.

| | |
|---|---|
| Original voraus | **2 Commits** |
| Dieser Fork voraus | **4 Commits** |
| Einziger Autor upstream | `AlphaGenX` |

**Was im Original seither dazukam:**

- `f9f7721` **v7: `/usage`** — Kontext-Verbrauch der aktiven Session, gelesen aus dem
  Session-Transkript (letzte `assistant`-Zeile, Subagenten ausgefiltert), Kontextfenster je Lauf aus
  dem Result-JSON gemerkt statt hartcodiert. Anzeige mit Balken und Prozent, ab 70 % Hinweis auf
  `/clear`. Kostet keinen Claude-Lauf.
- `92825a4` Executable-Bit von `telegram-session.mjs` wiederhergestellt.

**Bewertung:** `/usage` ist übernehmenswert und liegt genau auf dem Weg von **Bauteil 3** (Fortschritt
aus dem Live-Transkript) — beide lesen `~/.claude/projects/<slug>/<id>.jsonl`, nur mit anderer
Fragestellung. Ein direkter Cherry-Pick ist nicht sinnvoll: die Pfade zeigen auf `/root`, und die
Ausgabe müsste durch unsere Formatierungsschicht. Sinnvoller ist, die Transkript-Leserei **einmal**
zu bauen und beides daraus zu bedienen.

**Erledigt am 2026-09-05 mit v9** (siehe unten): die Transkript-Schicht steht, `/usage` ist
nachgebaut statt gepickt, Bauteil 3 und 4 sitzen darauf.

Umgekehrt sind vier Punkte aus diesem Fork **upstream-relevant** und unten je einzeln markiert
(Punkte 1–4). Sie gehören als schmale Branches von `upstream/main` eingereicht, nicht als dieser
Fork — der trägt Pfade und Betriebsentscheidungen, die nur hier gelten.

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

## v8.1 (2026-09-05) — drei Mängel aus dem ersten Live-Test

Gefunden von Lars beim ersten echten Lauf am Handy. Alle drei betreffen nicht die Mechanik,
sondern das, was man tatsächlich sieht — und genau deshalb fallen sie nur im Live-Test auf.

**Markdown kam roh im Chat an.** Claude antwortet in Markdown, der Bot schickte ohne `parse_mode` —
also standen `**Sternchen**`, `## Rauten` und Backticks als Zeichen da. Jetzt wird nach
**Telegram-HTML** übersetzt (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`; Überschriften werden fett,
Listenpunkte zu `•`). HTML statt MarkdownV2, weil MarkdownV2 ein Dutzend Zeichen zu escapen verlangt
und bei einem einzigen unbalancierten Zeichen die **ganze** Nachricht ablehnt.

Zwei Sicherungen, weil eine abgelehnte Nachricht schlimmer ist als eine unformatierte: vor dem
Senden wird geprüft, ob alle Tags im Stück ausgewogen sind, und wird das Stück trotzdem abgelehnt,
geht es unformatiert raus. Geteilt wird an Zeilengrenzen statt hart nach 3800 Zeichen.

> **Fast selbst gebaut:** die erste Fassung parkte Codeblöcke unter dem Platzhalter `␣N␣`
> (Leerzeichen-Ziffer-Leerzeichen). Beim Zurücksetzen hätte das auch normalen Text wie
> „lief 5 Minuten" getroffen und durch einen fremden Codeblock ersetzt. Jetzt klammern NUL-Zeichen.
> Der Test dazu steht als eigener Fall im Selbsttest.

**Die eigenen Meldungen hatten keine Umlaute** — „eroeffnet", „laeuft", „groessere Auftraege". Das
stammt aus dem Upstream und war nie nötig: Claudes Antworten zeigten schon immer korrekte Umlaute,
UTF-8 trägt also über die ganze Strecke. Ersetzt wurde **nur innerhalb von Strings und Kommentaren**
(Bezeichner wie `naechstesCwd` bleiben unberührt), abgesichert durch einen Vergleich, der beweist,
dass außerhalb dieser Bereiche kein Zeichen abweicht.

**Kein Befehlsmenü im Chat.** Telegram zeigt den Menüknopf erst, wenn ein Bot seine Befehle über
`setMyCommands` anmeldet. Passiert jetzt beim Start, mit allen zwölf Befehlen und je einer Zeile
Erklärung.

**Dazu, aus demselben Testlauf:** `/neu proteinhit` gefolgt von der reinen Frage „was sind die
nächsten Schritte?" hinterließ einen **leeren Branch** `claude/was-sind-die-nachsten-schritte-i-…`.
Gibt es am Ende weder Commit noch geänderte Datei, wird jetzt auf den Basis-Branch zurückgewechselt
und der leere Branch gelöscht. Nebeneffekt: der Branch heißt danach nach dem Auftrag, der wirklich
etwas geschrieben hat, statt nach einer Zwischenfrage.

## v8.2 (2026-09-05) — `/rc`: der Bot macht eine Remote-Control-Sitzung auf

Der tragende Satz aus dem Grill war: *„wenn kein Cloud offen ist mit einem Remote Control, komme ich
gar nicht mehr ran."* Diese Lücke ist jetzt geschlossen, ohne dass der Bot ein eigenes Feature
bekommt — er drückt einen Knopf, den Claude Code schon hat.

```
/rc [projekt]      Sitzung öffnen (klont bei Bedarf, unscharfer Name erlaubt)
/rc liste          offene Sitzungen
/rc stop [projekt] beenden
```

Zurück kommt eine `claude.ai/code`-Adresse: die **volle** Claude-Code-Oberfläche mit Rückfragen,
Dateiansicht und Unterbrechen — im Gegensatz zum Ein-Auftrag-Weg des Bots. Damit ist die Kette
vollständig: Telegram erreicht man immer → Bot öffnet die Sitzung → Link aufs Handy.

Der Befehl ist `claude --remote-control <name>` und ausdrücklich **interaktiv**, braucht also ein
echtes Terminal. Auf einer Maschine ohne Bildschirm heißt das tmux. Der Start beantwortet die zwei
Erstdialoge (Ordner-Vertrauen, Renderer) selbst, indem er das tmux-Fenster liest, und wartet auf die
Adresse. Gemessen: **6 Sekunden** bis zur Adresse, ein zweiter Aufruf liefert dieselbe Sitzung.

> **Dieselbe Falle, zum dritten Mal:** der erste Versuch leitete die Ausgabe durch `tee` in eine
> Logdatei. Damit ist das TTY weg, Claude fällt auf `--print` zurück und stirbt mit *„Input must be
> provided…"* — wortwörtlich die Ursache, die den alten `claude-telegram.service` in seine 23.457
> Neustarts getrieben hat. Wer eine interaktive Sitzung startet, darf ihre Ausgabe nicht umleiten.

Der Aufruf läuft bewusst **ohne `await`** aus der Nachrichtenschleife heraus, damit der Bot während
des Starts weiter auf Nachrichten hört.

## v9 (2026-09-05) — Ausbaustufe 3, plus `/usage` aus dem Original

Bauteil 3 und 4 zusammen, wie im Grill entschieden („zweimal am selben Code schrauben ist
teurer"). Dazu `/usage` aus Upstream v7 — **nachgebaut, nicht gepickt**: dort zeigen die Pfade auf
`/root`, und die Ausgabe müsste ohnehin durch unsere Formatierungsschicht. Beide Bauteile und
`/usage` lesen dieselbe Datei, also gibt es die Leserei genau einmal.

### Die Transkript-Schicht

`~/.claude/projects/<slugifizierter-cwd>/<session-id>.jsonl` wird gelesen und liefert in einem
Durchlauf beides: die Zahl der Werkzeugaufrufe seit einem Zeitpunkt samt letztem Aufruf
(Fortschritt) und die Kontextgröße aus der letzten `assistant`-Zeile (`/usage`). Subagenten
(`isSidechain`) zählen nicht mit, sonst meldet ein Fan-out Schritte, die nicht die Hauptarbeit sind.

Bewusst **gepollt statt `--output-format stream-json`**: der Streaming-Weg baut genau die Teile um,
die heute tragen — die `is_error`-Prüfung und die Warteschlange. Lesen kostet nichts.

**Die bekannte Kante ist damit geschlossen** (siehe „Was v8 nicht kann" weiter unten, jetzt
gestrichen): bei einer *neuen* Session steht die ID erst am Ende fest, deshalb nimmt der Bot die
jüngste `.jsonl` im Projektverzeichnis. Eindeutig ist das nur, solange je Projekt ein Lauf läuft —
was Bauteil 4 garantiert. Wird dieser Deckel je gelockert, bricht diese Stelle zuerst.

### B3 — Fortschritt

Zwei Wege, derselbe Text:

- **Von selbst.** Dauert ein Auftrag länger als 90 Sekunden, erscheint eine Zeile
  („`vault läuft seit 5 Min · 12 Schritte · zuletzt Edit auf src/api.ts`") und wird danach jede
  Minute **editiert**, nicht neu gesendet. Ein Edit löst auf dem Handy keine Benachrichtigung aus,
  eine neue Nachricht schon — deshalb `editMessageText` und `disable_notification`. Am Ende wird
  dieselbe Nachricht auf das Ergebnis umgeschrieben („fertig nach 7 Min · 31 Schritte").
- **Auf Zuruf.** `/fortschritt` zeigt alle laufenden Aufträge mit Projekt, Laufzeit, Schritten und
  letztem Werkzeugaufruf.

Bei kurzen Aufträgen erscheint gar nichts. Eine Fortschrittsanzeige, die schneller fertig ist als
der Auftrag, ist nur Lärm.

### B4 — Nebenläufigkeit je Projekt

`busy` und die eine Warteschlange sind weg. Stattdessen eine Reihe **je Projekt**: innerhalb eines
Projekts weiter streng nacheinander (sonst kollidieren zwei Läufe in denselben Dateien),
verschiedene Projekte nebeneinander, **Deckel bei 3** wegen 8 GB RAM und weil jeder `--resume` ein
Vielfaches der Transkriptgröße zieht.

Drei Folgeänderungen, die daran hängen:

1. **Das Ziel-Projekt wird beim Einreihen festgelegt, nicht beim Ausführen.** Sonst läse ein
   Auftrag, der zehn Minuten in der Reihe stand, am Ende die inzwischen gewechselte aktive Session
   und liefe im falschen Verzeichnis.
2. **Die aktive Session wird je Projekt geführt** (`reg.aktivJe`). Ein globaler Zeiger reicht nicht
   mehr — zwei parallele Läufe würden dieselbe Session greifen und durcheinander resümieren.
   `reg.aktiv` bleibt daneben bestehen: die Session, die der Nutzer gerade *ansieht*.
3. **Laufen mehrere Projekte, trägt jede Antwort ihr Projekt im Kopf** (`[vault]`). Ohne das weiß
   man am Handy nicht, zu welchem Auftrag eine Antwort gehört.

`r.laufend` (Einzelwert) wird zu `r.laufende` (Liste). Beim Start liest der Bot beide Formen und
schreibt nur die neue — sonst ginge beim ersten Start nach dem Update ein offener Auftrag verloren.

### Der Übergang von v8, der beim Deploy aufgefallen ist

Die Registry auf der Maschine kannte `aktivJe` nicht. Ohne Übernahme hätte der erste Auftrag nach
dem Update in seinem Projekt keine Session gefunden, eine **neue eröffnet** — und der laufende
Gesprächsfaden wäre still weg gewesen. Der Bot bindet die vorhandene `aktiv`-Session beim Start an
ihr Projekt und protokolliert das. Live geprüft:
`v8-Übergang: aktive Session 03a50368 an /home/claude/work gebunden`.

Das ist die Sorte Fehler, die ein Test auf dem Entwicklungsrechner nicht findet: dort gab es keine
gewachsene Registry.

### `/usage`

Zeigt Balken, Prozent und absolute Zahlen. Das echte Kontextfenster meldet nur der Lauf selbst
(`modelUsage[].contextWindow`) und wird an der Session gemerkt. Solange es fehlt, wird geraten —
200k, bei `[1m]`-Modellen 1 Mio. **Ist die geratene Zahl kleiner als der gemessene Verbrauch, wird
kein Balken gezeigt**, sondern gesagt, dass das Fenster noch nicht bekannt ist. Eine Schätzung, die
kleiner ist als die Messung, ist keine Schätzung mehr, sondern falsch — und 100 % anzuzeigen, wo
22 % richtig wären, ist der Fehler, der zum unnötigen `/clear` führt.

### Geprüft, bevor es deployt wurde

Testkopie der Datei, Telegram-Schleife abgeschnitten, Funktionen exportiert, gegen **echte
Transkripte** laufen lassen (`scripts`-Variante im Scratchpad, nicht im Repo). 45 Prüfungen:
Schrittzählung gegen Handzählung derselben Datei, Zeitfenster, Dateisuche mit und ohne
Session-ID, serielle Reihenfolge im selben Projekt, echte Parallelität über Projekte hinweg, der
Deckel per Sweep-Line über Start- und Endezeiten, ein Fehlschlag, der die Reihe nicht blockiert,
und die Taktung des Melders in Echtzeit mit verkürzten Intervallen.

Zwei echte Fehler kamen dabei heraus, beide vor dem Deploy behoben: das Fortschritts-Intervall lief
mit 150 s statt 60 s (Timeout und Interval standen nebeneinander statt ineinander), und die
Raterei des Kontextfensters ignorierte die `[1m]`-Modelle. Dazu zwei Fehler im Testgerüst selbst —
der auffälligere: „wie viele überlappen mit x" ist nicht „wie viele liefen gleichzeitig", und die
naive Variante meldete fälschlich einen Deckelbruch.

Nach dem Deploy wurde die Schicht **auf der Maschine** gegen deren eigene Transkripte geprüft; die
Pfad-Slugifizierung ist genau das, was ein Test auf dem Mac nicht abdecken kann.

## Was v9 nicht kann (bewusst)

- Der Vault-Klon hängt an einem read-only Deploy-Key. Ein Push dorthin scheitert und wird ehrlich
  gemeldet; er wird nicht heimlich auf HTTPS umgebogen.
- **Die Außenwache ist weiterhin unscharf**, solange `HC_URL` fehlt (siehe B7). Das ist der einzige
  offene Punkt aus Stufe 2 und rangiert vor allem Weiteren.

## v10 (2026-09-05) — Verbrauch sichtbar machen, plus ein Fehler aus v9

Der Bot warf bis hierher alles weg, was ein Lauf über seinen eigenen Verbrauch meldete. Jedes
Ergebnis-JSON von `claude -p` enthält `total_cost_usd`, ein `usage` mit Cache-Aufschlüsselung und
`modelUsage` je Modell; gelesen wurden davon drei Felder. Anlass war eine Messung, die etwas
Unerwartetes zeigte.

### Die Messung

Über alle 69 Transkripte auf der Maschine, Stand 2026-09-05 nach dem Deploy:

| Herkunft | Dateien | Token | API-Calls |
|---|---:|---:|---:|
| **Fähigkeits-Ping** („Antworte nur mit OK") | 53 | **1.414.140** | 58 |
| Bot-Aufträge | 11 | 1.007.379 | 30 |
| Sonstiges (`/rc`, SSH-Läufe, Testverzeichnisse) | 5 | 134.624 | 6 |
| | **69** | **2.556.143** | **94** |

**Die Wache verbraucht mehr als alles andere zusammen — 55 % des Gesamtverbrauchs.** Ein einzelner
Ping kostet rund 26.700 Token für eine Antwort aus zwei Buchstaben.

Gegengeprüft, woran das liegt, und es liegt **nicht** an der Konfiguration: für User `claude` ist
kein MCP-Server eingerichtet, es gibt keine eigenen Skills, Commands, Agents oder Hooks, und die
globale `CLAUDE.md` ist knapp 2.400 Token groß. Der Rest ist Claude Codes eigener Systemprompt samt
Werkzeug-Definitionen — der Boden jedes `claude -p`-Aufrufs. **An der Größe eines Pings ist nichts zu
holen, nur an der Häufigkeit.**

### Die Falle beim Zählen: eine API-Antwort sind mehrere Zeilen

Beim Bauen kam heraus, dass die naheliegende Auswertung falsch rechnet, und zwar um Faktor zwei.

Claude Code schreibt **eine** API-Antwort als **eine JSONL-Zeile je Content-Block** — `thinking`,
`text`, jedes einzelne `tool_use` — und legt in **jede** dieser Zeilen das **volle, identische**
`usage`-Objekt. Wer über alle `assistant`-Zeilen summiert, zählt jeden Aufruf so oft, wie er Blöcke
hatte. Ein Ping-Transkript zeigt es im Kleinen: zwei Zeilen (`thinking` + `text`), gleiche
`message.id`, gleiche `requestId`, beide mit 27.268 Token. Verbraucht wurden 27.268, nicht 54.536.

Gemessen über den gesamten Bestand: **naiv 5.137.873 gegen dediziert gezählt 2.556.143, Faktor 2,01**
(je Topf 1,43 bis 2,14 — ein Ping hat zwei Blöcke, ein echter Auftrag oft vier). Der Leser
dedupliziert deshalb je Datei über `message.id` + `requestId`, dieselbe Regel wie `ccusage`. Fehlt
eines der beiden Felder, wird auf die Zeilen-`uuid` ausgewichen: lieber einmal zu viel gezählt als
eine Messung still verschwinden lassen.

**Der Kommentar an dieser Stelle im Code nennt die Messung ausdrücklich.** Wer sie nicht kennt, hält
die Deduplizierung für überflüssigen Aufwand und verdoppelt beim Aufräumen still jede Zahl in
`/usage`.

Die Verhältnisse zwischen den Töpfen ändert das kaum — die Aussage „die Wache frisst mehr als die
Arbeit" hält in beiden Zählweisen. Die absoluten Zahlen ändert es um die Hälfte.

### Der Fehler aus v9, der mitbehoben ist

`capabilityPing()` startete Claude mit `cwd: DEFAULT_CWD` und legte seine Transkripte damit in
**dasselbe** Projektverzeichnis wie die echten Aufträge. Genau dort greift die Fallback-Regel aus v9:
bei einer neuen Session steht die Session-ID erst am Ende fest, also nimmt `juengstesTranskript()`
die jüngste `.jsonl` im Verzeichnis. Fiel ein Ping in einen laufenden Auftrag — und er fiel alle
30 Minuten irgendwohin —, war **seine** Datei die jüngste, und die Fortschrittsanzeige meldete für
den laufenden Auftrag „noch kein Schritt im Protokoll".

Oben in diesem Dokument steht zu dieser Stelle, sie „bricht bei einer Lockerung zuerst". Sie brach
schon ohne Lockerung, an etwas, das von selbst passierte. Die Wache hat jetzt mit `WACHE_CWD`
(`/home/claude/.wache`) ihr eigenes Arbeitsverzeichnis. Die alten Ping-Transkripte bleiben liegen,
wo sie sind — sie sind die Datengrundlage für den Rückblick und werden über die erste Nutzerzeile
weiterhin korrekt als Wache erkannt.

### Die Wache pingt nur noch im Leerlauf

Ein durchgelaufener Auftrag beweist die Fähigkeit besser als ein „OK": er hat dieselbe Kette benutzt
und dabei etwas Nützliches getan. Lief in den letzten `HC_INTERVAL` ein Auftrag **erfolgreich**
durch, unterbleibt der Ping.

Zwei Feinheiten, die leicht falsch gebaut werden:

- **Nur ein erfolgreicher Lauf zählt.** Ein fehlgeschlagener ist ausdrücklich kein Nachweis — sonst
  besänftigt ausgerechnet ein Auth-Ausfall die Wache, und genau den soll sie finden.
- **Beim Überspringen wird trotzdem gepingt** (`hcPing("")`). Ohne das bedeutet „übersprungen" für
  healthchecks.io dasselbe wie „ausgefallen", und die Wache schlägt falschen Alarm.

Nach einem Neustart ist der Nachweis leer, der erste Ping läuft also normal. Im Zweifel prüfen.

### `/usage` hat jetzt zwei Teile

Teil eins ist unverändert der Kontextstand der angesehenen Session. Teil zwei zeigt den Verbrauch
der **ganzen Maschine** — heute, gestern, sieben Tage — und darunter die Aufteilung nach Herkunft.
Das ist der eigentliche Ertrag: eine sessionbezogene Anzeige hätte genau die Posten nie gezeigt, die
überrascht haben. Ohne aktive Session sagt Teil eins das und Teil zwei läuft trotzdem.

Dazu ein kleiner Schreibpfad, ohne den der Kostenteil unbaubar wäre: die Transkripte enthalten **kein
einziges Kostenfeld** (0 Zeilen mit `costUSD` oder `total_cost_usd`, geprüft). Der Betrag steht nur
im Ergebnis-JSON, und das wurde bisher weggeworfen. `runClaude()` gibt ihn jetzt zurück,
`auftragAusfuehren()` schreibt ihn als Tagessumme in die Registry (30 Tage Vorhalt). `/usage` weist
ihn als **API-Äquivalent** aus, nie als „Kosten", und **nur für Bot-Aufträge** — für Wache und `/rc`
gibt es keinen Wert, und es wird auch keiner geschätzt. Sonst liest sich eine Tagessumme wie eine
Abbuchung.

**Fail-loud statt Null:** ist das Projektverzeichnis nicht lesbar oder liegt im Fenster keine Datei,
sagt `/usage` das ausdrücklich und zeigt keine Null, die wie eine Messung aussieht. Dieselbe Regel,
an der die `cal snapshot`-Havarie im Juli gescheitert ist — ein `event_count: 0` war dort praktisch
immer ein Backend-Defekt, nie ein leerer Kalender.

### Geprüft, bevor es deployt wurde

Wie bei v9: Testkopie der Datei, Telegram-Schleife abgeschnitten, `HOME` umgebogen, Timer entschärft,
`tg()` gestubbt. **34 Prüfungen, alle grün**, gegen echte von der Maschine kopierte Transkripte plus
vier künstliche Kontrollen. Drei davon tragen die Last:

- **Positivkontrolle:** ein von Hand gebautes Transkript, eine `message.id` über drei Blöcke, `usage`
  je 100 Token. Erwartung 100, naiv käme 300 heraus.
- **Mutationsprobe:** dieselbe Prüfung noch einmal gegen eine Fassung, in der die Deduplizierung
  absichtlich ausgebaut ist. Sie meldet dort 300. Erst damit ist gezeigt, dass die Prüfung überhaupt
  rot werden **kann** — ein grüner Test allein beweist nichts.
- **Unabhängige Handzählung:** ein getrennt geschriebenes Python-Skript ermittelt dieselben Tages-
  und Herkunftssummen. Bewusst eine andere Sprache, damit ein Denkfehler nicht mitkopiert wird.

Nach dem Deploy noch einmal **auf der Maschine** gegen deren eigene 68 Transkripte: Leser und
Handzählung stimmen auf die Stelle überein (`{wache: 1.386.818, auftrag: 1.007.379, sonstiges:
134.624}`), Laufzeit 66 ms. Die Pfad-Slugifizierung ist genau das, was ein Mac-Test nicht abdeckt —
`/home/claude/.wache` wird zu `-home-claude--wache` und kollidiert nicht mit `-home-claude-work`.
Verifiziert ist außerdem, dass die beiden Pings nach dem Neustart im neuen Verzeichnis landen,
während die jüngste Datei im Auftrags-Verzeichnis von vor dem Deploy stammt.

### Was v10 nicht kann (bewusst)

- **Die Außenwache ist weiterhin unscharf**, solange `HC_URL` fehlt. Damit ist auch der
  `hcPing("")` beim Überspringen ein No-op — die Leerlauf-Logik ist mit Stub nachgewiesen, aber
  bis zur Außenwelt nicht verifiziert. Das bleibt der erste offene Punkt.
- **Kein Plan-Fenster.** Wie viel vom Max-Plan verbraucht ist, lässt sich auf einer Maschine nicht
  ehrlich beantworten — der Arbeits-Mac fehlt in der Rechnung, die Zahl wäre systematisch zu
  niedrig. Lieber keine Zahl als eine falsche.
- **Keine Preistabelle.** Die Einheit ist Token. Eine selbst gepflegte Preistabelle rottet still,
  und ein falscher Preis ist schlechter als keiner.

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
