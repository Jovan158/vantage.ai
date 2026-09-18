# Vantage — Konzept: Kontroll- & Transparenzschicht für AI-Coding-CLIs

> **Vantage** = der erhöhte Beobachtungspunkt. Kein weiterer Coding-Agent, sondern
> die Warte, von der aus man bestehende CLI-Agents (Claude Code, Codex CLI, Aider,
> Gemini CLI …) sieht und steuert. Aufruf im Folgenden: `vantage run <agent>`.

Status: **Konzept**. Gewählter Prototyp-Einstieg: **Token-/Cost-Meter (Proxy)** —
siehe [§7](#7-nächste-schritte--prototyp).

---

## Die 5 adressierten Probleme

1. Keine Echtzeit-Transparenz über Token-/Kostenverbrauch → unerwartete Limits mitten in der Arbeit.
2. Zu grobe Freigabestufen ("alles erlauben" vs. "bei jedem Schritt fragen") statt granular je Aktionstyp (lesen / schreiben / Shell / Netzwerk).
3. Fehlende Nachvollziehbarkeit über mehrere Schritte hinweg (Was hatte der Agent vor? Warum?).
4. Kein Schutz vor riskanten Änderungen (keine Branch-Isolation by default, unübersichtliche Multi-Datei-Diffs).
5. Kein projektübergreifendes Gedächtnis: jede Session startet bei null.

---

## 1. Architektur: Wrapper ohne Nachbau

Kernkonflikt: Agents **beobachten und steuern**, ohne Zugriff auf ihren internen
Zustand. Lösung: ein **Mehrschicht-Interception-Modell**. Jede Schicht löst ein
anderes Problem; je Agent nutzt Vantage die beste verfügbare Schicht.

```
        ┌──────────────────────────────────────────────┐
        │                vantage (Core)                │
        │  Session-Orchestrator · Event-Bus · Store    │
        └──────────────────────────────────────────────┘
             │            │             │           │
     ┌───────┴──┐  ┌──────┴─────┐ ┌─────┴────┐ ┌────┴──────┐
     │ PTY-Layer│  │ LLM-Proxy  │ │ Native   │ │ Git/FS    │
     │ (stdio)  │  │ (HTTP)     │ │ Hooks    │ │ -Layer    │
     └──────────┘  └────────────┘ └──────────┘ └───────────┘
        universell    Tokens/Kosten  sauber,      Isolation/
        aber "blind"   + Gate         agent-spez.  Diffs
```

**Schicht A — Prozess-Wrapping (PTY).** Vantage startet den echten Agent als
Kindprozess im Pseudo-Terminal (`node-pty`). Der Agent läuft interaktiv wie immer;
Vantage sieht den gerenderten I/O. Universell für jeden CLI-Agent, aber nur
gerenderter Text — kein strukturiertes Wissen. Fallback-Schicht.

**Schicht B — LLM-Proxy (der Schlüssel).** Fast alle Agents lassen ihre Base-URL
per Env-Var umbiegen (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE` …).
Vantage startet einen lokalen Reverse-Proxy, setzt diese Vars im Kindprozess und
leitet transparent an den echten Anbieter weiter. Damit sieht Vantage den echten
API-Traffic: exakte Tokens aus den `usage`-Feldern, Modell, jeden Tool-Call *vor*
Ausführung. Datenquelle für Kosten (①), Replay (③) und natürlicher Ort für ein
Approval-Gate auf Netzwerkebene (②). Herzstück.

**Schicht C — Native Hooks/Telemetry.** Wo ein Agent bessere Integration bietet,
nutzt Vantage sie: Claude Code `PreToolUse`/`PostToolUse`-Hooks & OpenTelemetry,
Aider `--llm-history-file` usw. Der Adapter zieht die sauberste Quelle.

**Schicht D — Git/FS-Layer.** Agent-unabhängig. Session in eigenem Git-Worktree/
Branch, Dateisystem-Beobachtung (`chokidar`). Löst Isolation & Diff-Aggregation (④)
ohne Agent-Interna.

### Der Klebstoff: das Adapter-Interface

Der Core kennt nur ein normalisiertes Event-Schema. Pro Agent ein Adapter, der
deklariert, *welche Schichten er kann*:

```ts
interface AgentAdapter {
  id: "claude-code" | "codex" | "aider" | "gemini"
  spawn(ctx): ChildHandle               // wie starte ich den echten Agent
  proxyEnv(port): Record<string,string> // welche Env-Vars biege ich um
  parseUsage(res): TokenUsage | null    // wie lese ich Tokens aus Responses
  pricing: ModelPricingTable
  capabilities: { proxy: bool, hooks: bool, pty: bool }
}
```

Core bleibt stabil; ein neuer Agent ist "nur" ein Adapter — kein Nachbau, kein Fork.
**Degradations-Pfad:** Kann eine Schicht etwas nicht, fällt Vantage zurück (z. B. auf
PTY-only) und **sagt das transparent**, statt falsche Zahlen zu zeigen.

---

## 2. MVP-Feature-Set nach Aufwand/Nutzen

Sortiert nach Nutzen ÷ Aufwand (oben = zuerst).

| # | Feature | Problem | Aufwand | Nutzen | Schicht |
|---|---------|---------|---------|--------|---------|
| 1 | **Live Token-/Cost-Meter** — Statuszeile: Tokens, €, Rate, "noch ~X bis Limit" | ① | M | Sehr hoch | B |
| 2 | **Git-Session-Isolation** — auto-Worktree/Branch, ein Befehl zum Mergen/Verwerfen | ④ | S | Hoch | D |
| 3 | **Aggregierter Diff-Review** — `vantage diff` bündelt alle Session-Änderungen | ④ | S | Hoch | D |
| 4 | **Granulares Approval-Gate** — Regeln je Aktionstyp (`read`/`write`/`shell`/`network`) | ② | M–L | Hoch | B/C |
| 5 | **Strukturierter Event-Log** — Session als append-only JSONL | ③ | S | Mittel (Enabler!) | B/C |
| 6 | **Session-Replay / Timeline** — TUI oder lokales Web-Dashboard über den Log | ③ | M | Hoch | — |
| 7 | **Projektgedächtnis `.vantage/`** — dateibasiert, versioniert, pro Agent kompiliert | ⑤ | M | Mittel-hoch | D |

**Schlüssel-Abhängigkeit:** Feature 5 (Event-Log) ist der Enabler für 1, 4 und 6 —
gemeinsamer Datenspeicher. Man baut 5 als Nebenprodukt des Proxys (B) und erntet
Meter, Gate und Replay darauf.

---

## 3. Technologie-Stack

**Empfehlung: TypeScript / Node.js ≥ 20.** Begründung: Ökosystem-Nähe zur Zielgruppe
(`npx vantage` als natürliche Distribution), und die kritischen Bausteine sind in
Node erstklassig (`node-pty`, HTTP-Proxy, Ink-TUI).

| Baustein | Wahl | Warum |
|----------|------|-------|
| Sprache/Runtime | TypeScript, Node ≥ 20 | Ökosystem, `fetch`/Streams nativ |
| CLI-Framework | `clipanion` / `commander` | leicht, typisiert |
| Prozess-Wrapping | `node-pty` | einziger robuster PTY-Weg in Node |
| Proxy | `fastify` + `undici` (streaming pass-through) | schnell, SSE-tauglich |
| TUI | `ink` (+ `ink-ui`) | Live-Statuszeile & Replay in React-Manier |
| Web-Dashboard (opt.) | Fastify statisch + SolidJS/Svelte, SSE für Live | minimal |
| Persistenz | **JSONL** (Log) + **SQLite** (`better-sqlite3`) für Aggregate | JSONL = lesbar/git-tauglich, SQLite = schnelle Queries |
| Git | `simple-git` | Worktrees, Diffs |
| FS-Watch | `chokidar` | Diff-Trigger |
| Config | `.vantage/config.toml` + Zod-Validierung | typsicher |

**Alternative Go/Rust:** Ein statisches Binary wäre für die Distribution schöner und
der Proxy performanter — aber der Distributions-Vorteil ist bei node-affiner
Zielgruppe gering, das TUI-Ökosystem schwächer, die Iterationsgeschwindigkeit in TS
höher. → **TS fürs MVP.** Falls der Proxy je zum Flaschenhals wird, kann man *nur*
diesen Teil später in Go/Rust auslagern.

---

## 4. Session-Replay / Log-Ansicht

**Datengrundlage:** append-only JSONL pro Session (`.vantage/sessions/<id>/events.jsonl`).
Jede Zeile ein normalisiertes Event:

```jsonc
{ "ts": …, "type": "prompt",    "text": … }
{ "ts": …, "type": "tool_call", "tool": "write_file", "path": …, "preview": …, "approved": true }
{ "ts": …, "type": "usage",     "model": …, "in": …, "out": …, "cache": …, "cost_eur": … }
{ "ts": …, "type": "diff",      "path": …, "added": …, "removed": … }
{ "ts": …, "type": "decision",  "summary": … }   // "Agent wollte X, weil Y"
```

Der Proxy (B) füttert `prompt`/`tool_call`/`usage`; der FS/Git-Layer die `diff`-Events.
Eine Quelle, zwei Ansichten:

- **TUI (`vantage replay <id>`):** Ink-App rendert eine auf-/zuklappbare Timeline.
  Live-Modus (`--follow`) hängt via Watcher an die laufende Session an. Bleibt im
  Terminal-Flow, kein Port.
- **Web-Dashboard (`vantage dashboard`):** Fastify serviert eine kleine SPA;
  Live-Updates via SSE. SQLite erlaubt Aggregate über alle Sessions ("diese Woche
  4,20 € verbraucht"). Echte Diff-Viewer (Monaco), teilbar.

**Empfehlung:** TUI zuerst (näher am Workflow), Dashboard als Aufsatz — beide lesen
dasselbe JSONL. "Was hatte der Agent vor": die Tool-Calls eines Assistant-Turns = die
konkreten Schritte eines Vorhabens, optional per billigem LLM-Call verdichtet.

---

## 5. Persistentes, dateibasiertes Projektgedächtnis

**Prinzip: Git ist die Datenbank.** Gedächtnis als versionierte Dateien im Repo —
lesbar, teambar, per PR reviewbar, konsistent mit dem Code-Stand.

```
.vantage/
  memory/
    decisions.md      # Architektur-Entscheide (ADR-artig, append-only)
    architecture.md   # Struktur/Module, aktueller Stand
    glossary.md       # Domänenbegriffe
    conventions.md    # "so machen wir das hier"
    index.json        # Embeddings/Metadaten für Retrieval (optional)
  sessions/<id>/events.jsonl
```

**Kern-Mechanismus — Kompilierung ins native Format je Agent.** Jeder Agent hat sein
eigenes Kontext-Format (Claude Code `CLAUDE.md`; andere `AGENTS.md`, System-Prompt-
Prepend …). Vantage hält *eine* kanonische Quelle und kompiliert sie pro Session:

```
.vantage/memory/*  ──(vantage kompiliert)──▶  CLAUDE.md / --system-prompt / prepend
        ↑                                              │
        └────── (nach Session: destillieren) ◀─────────┘
```

- **Vor der Session (inject):** Adapter rendert die relevante Teilmenge ins native
  Format. Jeder Agent bekommt denselben Kontext.
- **Nach der Session (harvest):** aus dem Event-Log neue Entscheide/Fakten
  destillieren (billiger LLM-Call) und als **Vorschlag** in `decisions.md` schreiben —
  immer mit Bestätigung, nie stilles Überschreiben.
- **Cross-Agent by design:** kanonische Quelle → Claude Code und Aider teilen dasselbe
  Projektwissen.

Für große Projekte: `index.json` mit Embeddings, damit nur relevante Teile injiziert
werden (Kontextfenster schonen).

---

## 6. Risiken & technische Grenzen (ehrlich)

**a) Token/Kosten live auslesen.**
- Via Proxy **sehr zuverlässig** — `usage`-Felder kommen aus echten Provider-Responses
  (bei Streaming im finalen SSE-Event). Ground Truth des Anbieters.
- Grenzen: (1) Base-URL-Umbiegen muss der Agent zulassen — bei Claude Code/Codex/Aider
  ja, sonst nur PTY-Schätzung. (2) **Kosten ≠ Tokens:** Prompt-Caching (Cache-Write vs.
  -Read unterschiedlich bepreist), Batch-Rabatte, und v. a. **Abo-Modelle** (Claude-Abo
  statt API-Key) machen "€ genau" schwer. Ehrliche Botschaft: bei API-Keys sind Tokens
  *exakt*, Kosten *sehr genau*; bei Abos zeigt man **Tokens & Rate zur Limit-Prognose**,
  nicht "Euro". (3) Preis-Tabellen veralten → aktualisierbare Config, nicht hartkodiert.
- **Rate-Limit-Vorhersage** (der eigentliche Bedarf von ①): Anbieter liefern teils
  `*-ratelimit-*`-Header — der Proxy liest sie mit → reale statt geschätzter Prognose.

**b) In fremde CLI-Prozesse eingreifen, ohne sie zu brechen.**
- PTY-Wrapping ist sicher, solange Vantage transparent durchleitet (Resize-Signale,
  Raw-Mode, Ctrl-C, Alternate-Screen) — beobachten, nicht neu rendern.
- Proxy-Eingriff ist am heikelsten: Blockt Vantage einen Tool-Call (Gate), muss es eine
  **wohlgeformte Deny-Antwort** im erwarteten Schema zurückgeben, sonst hängt/crasht der
  Agent. Pro Provider unterschiedlich → gehört in den Adapter, braucht Tests.
  **SSE-Streaming** korrekt durchzuleiten (nicht puffern, Abbrüche sauber) ist die
  Hauptfehlerquelle.
- Versions-Drift: Ändert ein Agent CLI/Format, kann ein Adapter brechen → Adapter
  deklarieren getestete Versionsbereiche, Degradations-Pfad greift.

**c) Approval-Gate — Granularität vs. Realität.** "Netzwerk verbieten" auf Proxy-Ebene
erfasst nur *LLM*-Calls; macht der Agent per Shell `curl`, greift es nicht — dafür
bräuchte es das Gate auf Shell-Ebene (schwerer). MVP-Grenze: Gate zuverlässig für LLM-
und gemeldete Tool-Calls; echtes Shell-Sandboxing ist ein späteres, größeres Thema
(OS-Sandbox/Container).

**d) Sicherheit/Vertrauen.** Vantage sitzt zwischen Agent und Provider, sieht alle
Prompts, Keys, Code. Muss lokal bleiben, Keys nur durchreichen (nie loggen), Event-Log
mit Redaction-Pass (keine Secrets). Voraussetzung für Vertrauen, kein Nice-to-have.

---

## 7. Nächste Schritte — Prototyp

**Gewählter Einstieg: Token-/Cost-Meter auf Proxy-Basis (Feature 1 + 5).**

Begründung: adressiert das schmerzhafteste Problem (①) mit dem höchsten sofort
spürbaren Nutzen, zwingt uns die tragende Säule zuerst zu bauen (Proxy + Event-Log,
Fundament für Gate/Replay/Memory), und testet die riskanteste Annahme des Projekts
(Base-URL-Umbiegen + SSE sauber durchleiten) in Woche 1.

**Prototyp-Scope (eng geschnitten):**

> `vantage run claude` startet Claude Code hinter dem lokalen Proxy, leitet sauber
> durch (inkl. Streaming, interaktiv unverändert nutzbar), liest `usage` aus den
> Responses und zeigt eine Live-Zeile: **kumulierte Input/Output-Tokens, geschätzte
> Kosten, Tokens/Minute.** Nebenbei fällt der erste `events.jsonl` ab.

Ein Ziel-Agent (Claude Code), eine Schicht (Proxy), ein sichtbares Ergebnis. Danach ist
der zweite Agent "nur" ein Adapter; Gate/Replay ernten wir auf dem vorhandenen Log.

**Bausteine des Prototyps:**
1. Reverse-Proxy (Fastify + undici) mit transparentem Streaming-Pass-through zu
   `api.anthropic.com`.
2. `vantage run claude`: setzt `ANTHROPIC_BASE_URL` auf den lokalen Proxy, spawnt Claude
   Code (PTY), reicht I/O transparent durch.
3. SSE-Parser, der `usage` aus dem finalen `message_delta` extrahiert (+ Cache-Tokens).
4. Preis-Tabelle (Config) → Kosten-Schätzung; Anzeige klar als "Tokens exakt, € bei
   Abo geschätzt".
5. Event-Log-Writer (`events.jsonl`) als gemeinsamer Datenspeicher.
6. Live-Statuszeile (Ink) über dem/neben dem Agent-Output.
