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
der beobachteten Kopie und Metering von Streaming- *und* JSON-Antworten:

```
[vantage] session end · 2 request(s) · in 66 · out 45 · cache 66414 · ~$0.0208 (est.)
```

Diagnose mit `VANTAGE_DEBUG=1` (loggt Upstream-Status, Content-Type, Encoding).

### Ausprobieren (Node ≥ 22.6, keine Installation nötig)

```bash
npm test          # beweist: Proxy streamt transparent UND extrahiert Usage
npm run demo      # komplette Kette gegen einen Mock-Upstream (kein API-Key nötig)

node bin/vantage.mjs --help
node bin/vantage.mjs run claude -- -p "..."   # echten Agent wrappen + metern
```

`vantage demo` fährt die ganze Orchestrierung vor: Env-Injektion → Agent-Spawn
→ Proxy → Live-Meter → Event-Log. Läuft dank Nodes Type-Stripping ohne
Build-Schritt; ein `dist/`-Build (`npm run build`) ist der Distributionspfad.

### Struktur

| Pfad | Rolle |
|------|-------|
| `src/proxy.ts` | Transparenter Streaming-Reverse-Proxy (Schicht B) |
| `src/usage.ts` | SSE-Usage-Extraktor (Tokens aus dem Stream) |
| `src/meter.ts` | Aggregierte Totals + Rate + Statuszeile |
| `src/events.ts` | Append-only Event-Log (JSONL) |
| `src/agents/` | Agent-Adapter (Claude Code, Codex, Aider) |
| `src/cli.ts` | `vantage run` / `vantage demo` |
| `spike/` | Ursprünglicher Wegwerf-Durchstich, der die Kernannahme bewies |
