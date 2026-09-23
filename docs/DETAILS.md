# Vantage — Details & Hintergründe

Ergänzt die [README](../README.md) um Beispielausgaben und die Gründe hinter den
Designentscheidungen. Das ursprüngliche Konzept steht in [`CONCEPT.md`](CONCEPT.md).
Die Beispielausgaben stammen aus echten Läufen; Beträge darin sind illustrativ.

## ① Tokens, Kosten, Limits

`vantage run claude` wrappt die echte
Claude-Code-CLI, leitet an `api.anthropic.com` durch (der Proxy respektiert
`HTTPS_PROXY`/`NO_PROXY`) und extrahiert reale Usage — inkl. gzip/br-Dekompression
der beobachteten Kopie und Metering von Streaming- *und* JSON-Antworten. Zusätzlich
liest der Proxy die **Rate-Limit-Header** aus und zeigt eine echte Limit-Prognose:

```
[vantage] session end · 2 request(s) · in 66 · out 45 · cache 66414 · ~$0.0208
[vantage] quota 5h 53% used reset 1h50m · 7d 6% used reset 156h50m
```

Die Quota-Zeile deckt beide Anbieter-Formen ab: **Unified-Fenster** (Abo/Pro-Max,
was Claude Code real zurückgibt — 5h-/7d-Auslastung + Reset) und die **klassischen
Per-Key-Buckets** (API-Key-Billing — requests/tokens remaining). Genau der
Abo-Quota-Fall, den reine Token-Zählung nicht abbilden kann.

**Kosten sind eine Schätzung zu API-Listenpreisen:** exakter Lookup pro
Modell-ID, Cache-Writes getrennt nach 5-Minuten- und 1-Stunden-TTL. Unbekannte
Modelle werden als `price unknown` ausgewiesen statt geraten — Tokens werden
trotzdem gezählt. Im Abo ist der Dollarbetrag nur ein API-Äquivalent; das echte
Signal ist die Quota-Zeile.

**Woher die Preise kommen.** Keine Zahl ist von Hand eingetippt. Die einzige
Quelle ist Anthropics offizielle Preisseite in ihrer Markdown-Form
(`…/pricing.md`), gelesen von *einem* Parser (`src/pricing-source.ts`):

```
offizielle Preisseite ─► Parser ─┬─► src/pricing-snapshot.ts   generiert, wird mit Vantage ausgeliefert
                                 └─► ~/.vantage/pricing.json    `vantage pricing update`
```

- `vantage pricing` zeigt die aktiven Preise, ihren Stand und ihre Quelle.
- `vantage pricing update` holt die aktuelle Liste — **nur auf diesen Befehl hin**.
  Vantage lädt nie selbstständig etwas nach; ein Meter, der unaufgefordert
  Traffic erzeugt, widerspräche seinem Zweck.
- Beim Zusammenführen gewinnt pro Modell die **neuere** Quelle: ein frisches
  Update schlägt ein altes Release, ein neues Release ein altes Update.
- Der Parser ist streng: Spalten per Überschrift statt Position, jeder Preis
  muss `$X / MTok` lauten, jede Zeile eine Plausibilitätsprüfung bestehen
  (Cache-Read < Input < 5m-Write < 1h-Write, Output > Input — fängt vertauschte
  Spalten). Ändert sich das Seitenformat, gibt es einen Fehler und nichts wird
  geschrieben — nie falsche Zahlen im Meter.
- Taucht ein Modell ohne Preis auf oder ist die Liste älter als 60 Tage, sagt
  das Session-Ende es mit einer Zeile.
- Ein wöchentlicher CI-Job (`Pricing drift`) vergleicht die ausgelieferte
  Liste mit der offiziellen und schlägt bei Abweichung fehl; behoben wird mit
  `npm run pricing:snapshot` und Commit.

Bei Annäherung ans Limit warnt Vantage auffällig — **einmalig** beim Überschreiten
der Schwelle (kein Spam), re-armiert nach Reset, und meldet akute Fälle
(`rejected`, `retry-after`) sofort:

```
[vantage] warning: 5-hour limit 92% used — getting close (resets in 18m)
```

Schwelle konfigurierbar über `VANTAGE_QUOTA_WARN` (Prozent `80` oder Anteil `0.8`,
Default 90 %). Diagnose mit `VANTAGE_DEBUG=1` (loggt Upstream-Status, Content-Type,
Encoding und alle Rate-Limit-Header).

## Budget

Warnen allein verhindert nicht, dass eine Session weiterläuft. Mit einem Budget
greift Vantage ein:

```
vantage run --max-cost 2 claude       # ab ~$2 geschätzten Session-Kosten
vantage run --max-quota 80 claude     # ab 80 % eines Abo-Fensters (5h oder 7d)
```

Ist das Budget erreicht, braucht **jede Aktion deine Freigabe** — Claude Code
fragt vor dem nächsten Tool-Aufruf nach. Bewusst kein harter Abbruch: Ein Agent,
der mitten in einer Änderung beendet wird, hinterlässt halbfertige Dateien. `deny`
aus der Policy bleibt `deny`. Ein Kosten-Budget bleibt für die Session erreicht
(Kosten sinken nicht); ein Quota-Budget hebt sich wieder auf, sobald das Fenster
zurückgesetzt ist.

```
[vantage] ALERT: budget reached — session cost ~$2.03 reached the $2.00 budget. Every action now needs your approval.
```

Umsetzung: Der Hook ist bei Claude Code ein eigener Prozess pro Tool-Aufruf und
teilt keinen Speicher mit `vantage run`. Vantage schreibt deshalb beim Erreichen
eine kleine Zustandsdatei in den Session-Ordner, die der Hook bei jedem Aufruf
liest. Was das Budget nicht sehen kann, sagt Vantage einmalig: Anfragen an
Modelle ohne bekannten Preis zählen nicht zum Kosten-Budget, und API-Key-Konten
liefern keine 5h/7d-Fenster für das Quota-Budget. Auch als Umgebungsvariablen:
`VANTAGE_MAX_COST`, `VANTAGE_MAX_QUOTA`. Replay und `watch` zeigen den Zeitpunkt.

## ② Freigaben je Aktionstyp

**Granulare Freigaben (Problem ②).** Vantage
klassifiziert jeden Tool-Call nach Typ — **read / write / shell / network / other**
— zeigt ihn im Replay je Turn plus eine Aktions-Summary, und meldet nach Policy
eine Warnung, wenn ein als `warn` markierter Typ genutzt wird:

```
[vantage] warning: policy: shell action used (Bash) — policy 'warn' (observe-only, not blocked)
…
actions: write×1 · shell×1
```

Vier Stufen je Aktionstyp: `allow` · `warn` (nur Hinweis) · `ask` (Mensch muss
freigeben) · `deny` (blockiert). Konfiguration über `.vantage/policy.json` oder
`VANTAGE_POLICY="shell:deny,network:ask"`, Anzeige mit `vantage policy`
(Default: shell+network = warn).

**Enforcement läuft über den `PreToolUse`-Hook des Agents, nicht über den Proxy.**
Das ist kein Detail, sondern die einzig mögliche Schicht: Der Proxy sieht eine
Tool-*Absicht* im Antwortstrom, aber ausgeführt wird das Tool **innerhalb** des
Agents — es passiert den Proxy nie. Nur der Agent selbst (Hook) oder das
Betriebssystem (Sandbox) können einen Schreibvorgang oder Shell-Befehl wirklich
stoppen. An echtem Traffic verifiziert:

```
$ VANTAGE_POLICY="shell:deny" vantage run claude -- -p "Run 'echo hi' and show the output"
[vantage] enforcing policy via claude-code PreToolUse hook — shell:deny
→ "The command was blocked by your Vantage policy, which currently sets shell
   actions to 'deny'."

$ VANTAGE_POLICY="shell:deny" vantage run claude -- -p "Create control.txt containing ALLOWED"
→ Created control.txt   # write bleibt erlaubt — es blockt präzise, nicht pauschal
```

Zwei Sicherheitseigenschaften: Vantage gibt **nie** ein explizites `allow` zurück
(das würde die eigenen Permission-Regeln des Nutzers aufweichen — Vantage darf nur
einschränken, nie erweitern), und die Session-Settings werden von Claude Code mit
den Settings des Nutzers **gemerged**, wobei Listen wie `hooks` kombiniert statt
ersetzt werden — vorhandene Hooks bleiben also erhalten. Agents ohne Hook-Mechanik
bleiben beobachtend, und Vantage sagt das ausdrücklich statt Schutz vorzutäuschen.

## ③ Live-Ansicht und Replay

**Live-Ansicht im zweiten Terminal — bewusst kein Overlay.** `vantage watch`
zeigt die laufende Session live und folgt automatisch der zuletzt gestarteten
Session, auch aus einem anderen Ordner. Jede Zeile beantwortet eine Frage, die
man mitten in der Arbeit hat: Was macht Claude gerade? Reicht mein Limit? Woran
hat Claude gearbeitet? Was kostet das?

```
vantage · running · 3m · claude-opus-5-5 · vantage.dev
2026-09-23T12-00-00-000Z_ab12

Approval requested 15s ago: Bash npm test

Limits
  5-hour  ███████████████░░░░░  74%  resets 15:00 (in 56m)
  weekly  ███████░░░░░░░░░░░░░  35%  resets Thu 23:20 (in 1d 9h)
  this session so far: +13% of the 5-hour limit
  At this pace the 5-hour limit runs out around 14:09, before it resets.

This session
  work     1 message(s) from you  →  3 model call(s), 4 tool call(s)
  cost     ~$0.2000  API-equivalent; on your subscription the limits above count
  budget   █░░░░░░░░░ 10% of $2
  context  64k tokens sent with the last message  ·  90% of all input came from cache

Activity · read×2 · write×1 · shell×1 · 1 file(s) edited
  14:00:09          Read      src/net/fetch.ts
  14:00:09          Grep      fetchWithRetry
  14:00:40          Edit      src/net/fetch.ts
  14:03:20  asked   Bash      npm test
```

- **Status:** „Claude is thinking…“ (Anfrage läuft), „Claude is working: Edit
  src/app.ts“ (führt Tools aus), „Approval requested 15s ago“ (eine `ask`-Regel
  oder ein Budget hat eine Rückfrage ausgelöst), „Claude replied“.
- **Limits:** Balken grün/gelb/rot, Reset als Uhrzeit, der Anteil dieser Session
  und eine Prognose: Reicht das aktuelle Tempo bis zum Reset? Die Fenster gelten
  fürs ganze Konto, andere Claude-Nutzung zählt also mit.
- **work:** Nachrichten von dir gegenüber Modellaufrufen — Claude ruft das Modell
  nach jedem Tool erneut auf. Hintergrund-Aufrufe von Claude Code (z. B. „ist der
  Agent fertig?“) zählen bei Kosten mit, nicht als Turn.
- **context:** wie viele Tokens mit der letzten Nachricht mitgeschickt wurden, und
  wie viel davon aus dem Cache kam (günstig).
- **Mehrere Sessions:** Laufen mehrere gleichzeitig, zeigt `vantage watch` eine
  Übersicht — die Limits einmal (sie gelten fürs ganze Konto), darunter jede
  Session mit Status, Kosten und Nachrichten. `vantage watch <id>` zeigt eine
  davon im Detail, egal aus welchem Ordner. Laufend heißt: kein Session-Ende im
  Protokoll und der `vantage run`-Prozess lebt noch — abgestürzte Sessions
  erscheinen also nicht als laufend.
- **Activity:** die letzten Tool-Aufrufe mit Datei, Befehl oder URL — relativ zum
  Projekt —, markiert, wenn Vantage blockiert (`blocked`) oder nachgefragt
  (`asked`) hat.

Warum kein Overlay über dem Agent? Der Agent besitzt sein Terminal (`stdio:
"inherit"`) und bringt eine eigene TUI mit. Ein Overlay hieße: Vantage übernimmt
und rendert neu — genau die Bruchstelle aus Konzept §6b („beobachten, nicht neu
rendern"), die die UI des gewrappten Tools zerstören kann. Die Live-Ansicht läuft
deshalb in einem eigenen Terminal/tmux-Pane, gespeist aus dem append-only
Event-Log: **null Risiko für das Agent-Terminal, null Abhängigkeiten.**

Konsequent zu Ende gedacht heißt das: Solange die Chat-Oberfläche von Claude Code
offen ist, schreibt `vantage run` **gar nichts** in dieses Terminal. Eine frühere
Version gab nach jeder Antwort eine Statuszeile aus; die landete irgendwo in der
Oberfläche, verdeckte das Eingabefeld und verschwand beim nächsten Neuzeichnen.
Jetzt entfallen Routinezeilen (sie stehen in `vantage watch`), und Warnungen —
Quota, Budget, Policy — werden gesammelt und nach dem Beenden unter „during the
session:“ ausgegeben. Im Druckmodus (`claude -p`) gibt es keine Oberfläche, dort
bleibt die Ausgabe wie gehabt (`src/terminal.ts`).

**Session-Replay (Problem ③).** `vantage replay <id>` rendert den Event-Log als
lesbare Timeline — jeder Turn mit Modell/Tokens/Kosten **und Inhalt** (letzter
Prompt, Antworttext, aufgerufene Tools), Quota-Verlauf und Zusammenfassung:

```
session start · agent claude-code
 +2.1s quota 5h 76% used reset 1h35m · 7d 9% used
 +3.4s turn 1 claude-sonnet-5 · in 2 · out 147 · cache 55k · $0.0385
         prompt: Create a file poem.txt with a two-line poem about the sea
         tools:  Write
 +4.3s turn 2 claude-sonnet-5 · in 2 · out 21 · cache 61k · $0.0193
         reply:  Created poem.txt with a two-line poem about the sea.
 +6.0s session end · 3 turn(s) · in 98 · out 232 · cache 122k · ~$0.0609 · exit 0
```

So sieht man, **was** der Agent über mehrere Schritte vorhatte. Prompt-/Antwort-
Auszüge werden gekürzt gespeichert und durch einen **Redaction-Pass** von offen-
sichtlichen Secrets/PII (E-Mails, API-Keys, Bearer-Token, JWTs) bereinigt, bevor
sie in den Event-Log geschrieben werden (Konzept §6d).

**Nicht im Repository.** Die Protokolle enthalten Auszüge aus Prompts und
Antworten. Beim ersten `vantage run` legt Vantage deshalb `.vantage/.gitignore`
an, das `sessions/` und `worktrees/` ausschließt; `policy.json` und `memory/`
bleiben versionierbar. Die eigene `.gitignore` des Projekts wird nicht
angefasst, und eine vorhandene `.vantage/.gitignore` bleibt, wie sie ist.

**Aufräumen.** Jede Session bleibt unter `.vantage/sessions/` liegen, bis man
sie löscht. `vantage sessions prune` zeigt die Sessions dieses Projekts, in die
seit 30 Tagen nichts mehr geschrieben wurde, samt Größe — gelöscht wird erst mit
`--yes`. `--older-than 12h` / `2w` ändert das Alter, `--all` nimmt alle Projekte
dieses Rechners dazu. Nie gelöscht werden laufende Sessions und isolierte
Sessions, deren Worktree noch da ist (deren Branch wäre sonst ohne `vantage
discard`). Der Index in `~/.vantage/sessions.jsonl` verliert dabei die Einträge,
deren Protokoll nicht mehr existiert.

## ④ Git-Isolation

**Git-Session-Isolation (Problem ④).** Mit `--isolate` läuft der Agent in einem
dedizierten Git-Worktree auf Branch `vantage/<session>` — dein Arbeitsverzeichnis
bleibt unberührt. Am Ende committet Vantage die Änderungen auf den Branch und zeigt
einen **aggregierten Diff**; danach entscheidest du mergen oder verwerfen:

```
[vantage] isolated on branch vantage/…_y6rf (base bbb2b2fc) · worktree .vantage/worktrees/…
[vantage] isolation: 1 file(s) changed, +1/-0 on vantage/…_y6rf
[vantage]   greeting.txt (+1 -0)
[vantage] review:  vantage review …_y6rf
[vantage] merge:   git merge --no-ff vantage/…_y6rf
[vantage] discard: vantage discard …_y6rf
```

## ⑤ Projektgedächtnis

**Projektgedächtnis (Problem ⑤).** Dateibasiert unter `.vantage/memory/*.md`
(in Git versioniert), das Vantage vor jedem Run in den Agent-Kontext kompiliert
und **nicht-invasiv** injiziert (Claude Code: `--append-system-prompt`, kein
Datei-Mutieren). So startet keine Session mehr bei null. End-to-end verifiziert:

```
$ vantage memory add conventions "Preferred one-word greeting is 'Ahoy'."
$ vantage run claude -- -p "Greet me in one word"           → Ahoy
$ vantage run --no-memory claude -- -p "Greet me in one word" → Hello!
```

Der kanonische Store ist agent-agnostisch — derselbe Kontext lässt sich pro Agent
ins jeweils native Format kompilieren (Cross-Agent-Gedächtnis).

**Harvest — assistiert, nicht automatisch.** Nach einer Session, die etwas getan
hat, weist Vantage mit *einer* Zeile auf `vantage harvest <id>` hin. Das bereitet
das Material auf und schlägt einen fertigen Befehl vor:

```
harvest · session 2026-09-18T11-31-28-722Z_0k4i
3 turn(s) · ~$0.0604 · write×1

  what the agent said it did
    Created notes.txt containing "HARVEST".

  files changed
    notes.txt

Nothing is written automatically. Record what is worth keeping:
  vantage memory add decisions "Created notes.txt containing \"HARVEST\"."
```

Bewusst **kein** automatisches LLM-Destillieren am Session-Ende: Das würde bei
jeder Session still Quota verbrennen — genau Problem ①, gegen das Vantage antritt —
und ein falsch destillierter Eintrag vergiftet jede künftige Session, weil Memory
in den Kontext injiziert wird. Die beste Zusammenfassung ohne LLM liefert ohnehin
der Agent selbst: seine Abschluss-Antwort.

## Wie Vantage den Agent findet

Vantage bringt keinen eigenen Agent und keinen API-Key mit — es startet *deinen* installierten Claude Code, der sich mit seinem
eigenen Login (Abo oder `ANTHROPIC_API_KEY`) anmeldet; Vantage reicht das nur
durch. Gesucht wird `claude` auf dem PATH. Unter Windows installiert npm Agents als
`claude.cmd`-Hilfsdatei, die Node nicht ohne Shell starten kann; Vantage liest aus
ihr, was sie aufruft (die native `claude.exe` aktueller Versionen oder ein
JS-Skript), und startet das direkt — ohne Shell, damit Prompt und Memory-Text nicht
von cmd.exe interpretiert werden. Liegt der Agent woanders:

```powershell
$env:VANTAGE_AGENT_PATH = "C:\pfad\zu\claude.exe"
vantage run claude
```

## Architektur

`vantage demo` fährt die ganze Orchestrierung vor: Env-Injektion → Agent-Spawn
→ Proxy → Live-Meter → Event-Log. Läuft dank Nodes Type-Stripping ohne
Build-Schritt; ein `dist/`-Build (`npm run build`) ist der Distributionspfad.

**Derzeit nur Claude Code — erweiterbar.** Hinter dem Proxy sitzt eine
Provider-Schicht: ein Provider sagt nur, welche Pfade einen Turn tragen und wie
sein Streaming-/JSON-Format zu parsen ist. Alles darüber (Meter, Event-Log,
Replay, Policy, Quota) arbeitet auf einer normalisierten Form. Aktiv ist nur
`anthropic` (`/v1/messages`, SSE `message_start`/`message_delta`), gegen echten
`api.anthropic.com`-Traffic verifiziert. Adapter für Codex CLI und Aider gab es
bereits; sie konnten aber nur messen, waren nie mit den echten Tools getestet und
wurden deshalb entfernt statt halbfertig ausgeliefert (siehe git-Historie). Ein
weiterer Agent ist additiv — kein Eingriff in den Kern.

### Struktur


| Pfad | Rolle |
|------|-------|
| `src/proxy.ts` | Transparenter Streaming-Reverse-Proxy (Schicht B) |
| `src/usage.ts` | SSE-Usage-Extraktor (Tokens aus dem Stream) |
| `src/meter.ts` | Aggregierte Totals + Rate + Statuszeile |
| `src/ratelimit.ts` | Rate-Limit-Header → Limit-Prognose (unified + klassisch) |
| `src/upstream.ts` | Egress-Connector (`HTTPS_PROXY`/`NO_PROXY`, CONNECT-Tunnel) |
| `src/events.ts` | Append-only Event-Log (JSONL) |
| `src/git.ts` | Git-Session-Isolation (Worktree/Branch, aggregierter Diff) |
| `src/replay.ts` | Session-Replay: Event-Log → Timeline + Session-Liste |
| `src/watch.ts` | Live-Ansicht fürs zweite Terminal (folgt dem Event-Log) |
| `src/turn.ts` | Turn-Inhalt (Prompt/Antwort/Tools) + Redaction |
| `src/memory.ts` | Projektgedächtnis (`.vantage/memory/`, Kompilierung/Injektion) |
| `src/harvest.ts` | Assistierter Harvest: Session-Material → Memory-Vorschlag |
| `src/policy.ts` | Aktionstyp-Klassifizierung + Policy-Stufen (②) |
| `src/hook.ts` | PreToolUse-Enforcement (ask/deny) über den Agent-Hook |
| `src/budget.ts` | Budget-Wächter (`--max-cost` / `--max-quota`) |
| `src/rules.ts` | Regeln für bestimmte Dateien und Befehle (`.vantage/policy.json`) |
| `src/secrets.ts` | Erkennung versehentlich gesendeter Geheimnisse, mit Herkunft |
| `src/home.ts` | `~/.vantage`: Session-Index, letzte Session, läuft eine Session noch? |
| `src/stats.ts`, `src/search.ts` | `vantage stats` und `vantage search` über alle Sessions |
| `src/doctor.ts` | `vantage doctor`: Prüfung der Einrichtung |
| `src/terminal.ts` | Hält Ausgaben zurück, solange Claude Codes Chat-Oberfläche offen ist |
| `src/resolve.ts` | Findet die ausführbare Datei des Agents (auch npm-`.cmd`-Shims unter Windows) |
| `src/pricing.ts`, `src/pricing-source.ts`, `src/pricing-snapshot.ts` | Preise: Lookup, Parser der offiziellen Liste, generierter Stand |
| `src/providers/` | Provider-Schicht (derzeit nur Anthropic) hinter einem Interface |
| `src/agents/` | Agent-Adapter (derzeit nur Claude Code) |
| `src/cli.ts` | Einstieg: Hilfe und Verteilung auf die Befehle |
| `src/commands/` | Ein Modul je Befehl (`run`, `watch`, `sessions`, `pricing`, …) und die gemeinsame Terminal-Ausgabe |
| `src/session-meta.ts` | Metadaten einer Session (Isolation, Working-Tree-Snapshots) |
| `src/prune.ts` | `vantage sessions prune`: was gelöscht wird, was bleibt |
| `spike/` | Ursprünglicher Wegwerf-Durchstich, der die Kernannahme bewies |
