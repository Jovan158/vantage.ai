<img width="1408" height="768" alt="vantage dev_schriftzug" src="https://github.com/user-attachments/assets/13b85a02-08a3-4ea0-813c-44c4c14bbe23" />


# vantage.dev
AI that creates software on its own

---

## Vantage — Kontroll- & Transparenzschicht für AI-Coding-CLIs

Vantage legt sich als Wrapper über bestehende AI-Coding-Agents (Claude Code,
Codex CLI, Aider, …) und behebt deren bekannteste Schwachstellen — ohne die
Agents nachzubauen. Vollständiges Konzept: [`docs/CONCEPT.md`](docs/CONCEPT.md).

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

### Ausprobieren (Node ≥ 22.6, keine Installation nötig)

```bash
npm test          # 16 Tests: Proxy-Transparenz, Usage, Rate-Limit, Quota, Git-Isolation
npm run demo      # komplette Kette gegen einen Mock-Upstream (kein API-Key nötig)

node bin/vantage.mjs --help
node bin/vantage.mjs run claude -- -p "..."             # wrappen + metern
node bin/vantage.mjs run --isolate claude -- -p "..."   # isoliert + aggregierter Diff
node bin/vantage.mjs sessions                           # vergangene Sessions auflisten
node bin/vantage.mjs replay <sessionId>                 # Session als Timeline abspielen
node bin/vantage.mjs review <sessionId>                 # Diff einer Session ansehen
node bin/vantage.mjs discard <sessionId>                # Worktree + Branch verwerfen
node bin/vantage.mjs memory init                        # Projektgedächtnis anlegen
node bin/vantage.mjs memory add decisions "..."         # Entscheid festhalten
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
| `src/turn.ts` | Turn-Inhalt (Prompt/Antwort/Tools) + Redaction |
| `src/memory.ts` | Projektgedächtnis (`.vantage/memory/`, Kompilierung/Injektion) |
| `src/agents/` | Agent-Adapter (Claude Code, Codex, Aider) |
| `src/cli.ts` | `run [--isolate]` / `sessions` / `replay` / `review` / `discard` / `demo` |
| `spike/` | Ursprünglicher Wegwerf-Durchstich, der die Kernannahme bewies |
