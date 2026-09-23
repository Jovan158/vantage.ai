<img width="1408" height="768" alt="vantage dev_schriftzug" src="https://github.com/user-attachments/assets/13b85a02-08a3-4ea0-813c-44c4c14bbe23" />


# vantage.dev
AI that creates software on its own

---

## Vantage — Kontroll- & Transparenzschicht für AI-Coding-CLIs

Vantage legt sich als Wrapper über **Claude Code** und behebt dessen bekannteste
Schwachstellen — ohne den Agent nachzubauen. Derzeit wird bewusst nur Claude
Code unterstützt; die Architektur (Provider-Schicht, Agent-Adapter) lässt weitere
Agents später additiv zu. Vollständiges Konzept: [`docs/CONCEPT.md`](docs/CONCEPT.md).

**MVP-Prototyp:** Live-Token-/Cost-Meter auf Proxy-Basis.
Ein lokaler, transparenter Streaming-Proxy leitet den API-Traffic byte-genau
durch und liest dabei die echten Token-Zahlen aus — Fundament für Kosten-
Transparenz, Session-Replay und ein granulares Approval-Gate.

**Status: an echtem Traffic verifiziert.** `vantage run claude` wrappt die echte
Claude-Code-CLI, leitet an `api.anthropic.com` durch (der Proxy respektiert
`HTTPS_PROXY`/`NO_PROXY`) und extrahiert reale Usage — inkl. gzip/br-Dekompression
der beobachteten Kopie und Metering von Streaming- *und* JSON-Antworten. Zusätzlich
liest der Proxy die **Rate-Limit-Header** aus und zeigt eine echte Limit-Prognose:

```
[vantage] session end · 2 request(s) · in 66 · out 45 · cache 66414 · ~$0.0208 (est.)
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
Signal ist die Quota-Zeile. (Die Beispielausgaben in diesem README stammen aus
früheren Läufen; die Beträge darin sind illustrativ.)

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
[vantage] ⚠  Quota 5h zu 92% verbraucht — nähert sich dem Limit (reset 18m)
```

Schwelle konfigurierbar über `VANTAGE_QUOTA_WARN` (Prozent `80` oder Anteil `0.8`,
Default 90 %). Diagnose mit `VANTAGE_DEBUG=1` (loggt Upstream-Status, Content-Type,
Encoding und alle Rate-Limit-Header).

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

### Installation

```bash
npm install -g vantagedev   # oder: npx vantagedev --help
vantage --help
```

Das veröffentlichte Paket enthält ein kompiliertes `dist/` — es läuft ohne
Build-Schritt und ohne TypeScript-Toolchain beim Nutzer. Der Launcher lädt das
Kompilat **in-process** (kein zusätzlicher Prozess, Signale und stdio gehen
unverändert durch) und fällt nur im Dev-Checkout ohne Build auf Nodes
Type-Stripping zurück.

```bash
# Aus dem Checkout entwickeln
npm install          # nur TypeScript + @types/node (keine Laufzeit-Deps)
npm test             # 86 Tests (2 davon nur unter Windows)
npm run typecheck    # tsc --noEmit über src + test
npm run build        # -> dist/
npm pack             # baut via prepack und schnürt das Tarball
```

**Null Laufzeit-Abhängigkeiten** — alles läuft auf Node-Bordmitteln.

**Wie Vantage den Agent findet.** Vantage bringt keinen eigenen Agent und keinen
API-Key mit — es startet *deinen* installierten Claude Code, der sich mit seinem
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

### Ausprobieren (Node ≥ 22.6, keine Installation nötig)

```bash
npm test          # 86 Tests: Proxy-Transparenz & Resilienz, Usage, Preisliste,
                  # Rate-Limit, Quota, Git-Isolation, Replay, Watch, Memory, Policy
npm run demo      # komplette Kette gegen einen Mock-Upstream (kein API-Key nötig)

node bin/vantage.mjs --help
node bin/vantage.mjs run claude -- -p "..."             # wrappen + metern
node bin/vantage.mjs run --isolate claude -- -p "..."   # isoliert + aggregierter Diff
node bin/vantage.mjs watch                              # Live-Ansicht (2. Terminal)
node bin/vantage.mjs sessions                           # vergangene Sessions auflisten
node bin/vantage.mjs replay <sessionId>                 # Session als Timeline abspielen
node bin/vantage.mjs review <sessionId>                 # Diff einer Session ansehen
node bin/vantage.mjs discard <sessionId>                # Worktree + Branch verwerfen
node bin/vantage.mjs harvest [sessionId]                # Memory-Vorschlag aus Session
node bin/vantage.mjs memory init                        # Projektgedächtnis anlegen
node bin/vantage.mjs memory add decisions "..."         # Entscheid festhalten
node bin/vantage.mjs policy                              # Aktionstyp-Policy ansehen
node bin/vantage.mjs pricing [update]                   # Preisliste ansehen / aktualisieren
```

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
3 turn(s) · ~$0.0604 (est.) · write×1

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

**Granulare Freigaben (Problem ②).** Vantage
klassifiziert jeden Tool-Call nach Typ — **read / write / shell / network / other**
— zeigt ihn im Replay je Turn plus eine Aktions-Summary, und meldet nach Policy
eine Warnung, wenn ein als `warn` markierter Typ genutzt wird:

```
[vantage] ⚠  policy: shell action used (Bash) — policy 'warn' (observe-only, not blocked)
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

**Live-Ansicht im zweiten Terminal — bewusst kein Overlay.** `vantage watch`
zeigt die laufende Session live (Totals, Kosten, Rate, Quota, letzter Turn,
Aktionen) und folgt automatisch einer Session, die erst nach dem Start beginnt:

```
● vantage · claude-code · running · 12s
  turns  2   in 66   out 42   cache 66kr/0w
  cost   ~$0.0208 (est.)   rate 1.8k/min
  quota 5h 34% used reset 4h40m · 7d 16% used

  latest turn claude-sonnet-5
    prompt add a retry to the fetch helper
    reply  I'll add exponential backoff.
    tools  Read, Edit
```

Warum kein Overlay über dem Agent? Der Agent besitzt sein Terminal (`stdio:
"inherit"`) und bringt eine eigene TUI mit. Ein Overlay hieße: Vantage übernimmt
und rendert neu — genau die Bruchstelle aus Konzept §6b („beobachten, nicht neu
rendern"), die die UI des gewrappten Tools zerstören kann. Die Live-Ansicht läuft
deshalb in einem eigenen Terminal/tmux-Pane, gespeist aus dem append-only
Event-Log: **null Risiko für das Agent-Terminal, null Abhängigkeiten.**

**Session-Replay (Problem ③).** `vantage replay <id>` rendert den Event-Log als
lesbare Timeline — jeder Turn mit Modell/Tokens/Kosten **und Inhalt** (letzter
Prompt, Antworttext, aufgerufene Tools), Quota-Verlauf und Zusammenfassung:

```
● session start · agent claude-code
 +2.1s ◔ quota 5h 76% used reset 1h35m · 7d 9% used
 +3.4s ▸ turn 1 claude-sonnet-5 · in 2 · out 147 · cache 55k · $0.0385
         prompt: Create a file poem.txt with a two-line poem about the sea
         tools:  Write
 +4.3s ▸ turn 2 claude-sonnet-5 · in 2 · out 21 · cache 61k · $0.0193
         reply:  Created poem.txt with a two-line poem about the sea.
 +6.0s ● session end · 3 turn(s) · in 98 · out 232 · cache 122k · ~$0.0609 (est.) · exit 0
```

So sieht man, **was** der Agent über mehrere Schritte vorhatte. Prompt-/Antwort-
Auszüge werden gekürzt gespeichert und durch einen **Redaction-Pass** von offen-
sichtlichen Secrets/PII (E-Mails, API-Keys, Bearer-Token, JWTs) bereinigt, bevor
sie in den Event-Log geschrieben werden (Konzept §6d).

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
| `src/providers/` | Provider-Schicht (derzeit nur Anthropic) hinter einem Interface |
| `src/agents/` | Agent-Adapter (derzeit nur Claude Code) |
| `src/cli.ts` | `run [--isolate]` / `sessions` / `replay` / `review` / `discard` / `demo` |
| `spike/` | Ursprünglicher Wegwerf-Durchstich, der die Kernannahme bewies |
