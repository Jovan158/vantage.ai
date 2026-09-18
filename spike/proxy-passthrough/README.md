# Spike: transparenter Streaming-Proxy + Usage-Extraktion

> **Wegwerf-Spike, kein Produktionscode.** Zweck: die riskanteste Annahme des
> Vantage-MVP isoliert beweisen, bevor wir darauf aufbauen. Bewusst
> abhängigkeitsfrei (reines Node-ESM, kein Build) und mit Mock-Upstream, damit er
> ohne API-Key und ohne Netzwerk-Egress reproduzierbar läuft. Die echte
> Implementierung wird TypeScript (siehe `docs/CONCEPT.md` §3).

## Die geprüfte Annahme

> Kann ein lokaler Reverse-Proxy die Anthropic-SSE **byte-genau** an den Agent
> durchleiten **und gleichzeitig** die `usage`-Tokens auslesen, ohne den Stream zu
> stören?

Das ist die tragende Säule von „Schicht B" (LLM-Proxy) aus dem Konzept — sie
speist Kosten (①), Event-Log/Replay (③) und später das Netzwerk-Gate (②).

## Ausführen

```bash
node spike/proxy-passthrough/run-spike.mjs
```

Kette: `client → vantage proxy → mock anthropic (SSE)`. Der Runner assertet:

1. **Transparenz** — die Bytes beim Client sind **identisch** zu dem, was der
   Upstream gesendet hat (der Proxy ist unsichtbar).
2. **Usage** — Input-/Output-/Cache-Tokens werden korrekt aus den SSE-Frames
   extrahiert (`message_start` + `message_delta`).
3. **Kosten** — Schätzung aus der Preis-Tabelle.
4. **Event-Log** — ein `usage`-Event wird nach `events.jsonl` geschrieben.

Ergebnis: **9/9 Checks grün**, Time-to-first-byte durch den Proxy ~11 ms (kein
Puffern → Stream bleibt live).

## Dateien

| Datei | Rolle |
|-------|-------|
| `proxy.mjs` | Transparenter Streaming-Reverse-Proxy; forwardet Bytes, tee't Kopie in den Extractor |
| `usage.mjs` | SSE-Parser: zieht Token-Zahlen aus den Frames, ohne den Stream zu verändern |
| `pricing.mjs` | Platzhalter-Preistabelle + Kostenrechnung (real: updatebare Config) |
| `mock-anthropic.mjs` | Emuliert `POST /v1/messages` (Streaming) mit realistischer SSE-Sequenz |
| `run-spike.mjs` | Startet Mock+Proxy, schickt eine Anfrage durch, assertet 1–4 |

## Bewusst noch NICHT geprüft (nächste Unbekannte)

- **Echter Endpunkt** `api.anthropic.com` durch den Umgebungs-HTTPS-Proxy
  (undici `ProxyAgent`/CA-Trust) statt Mock.
- **Echter Claude-Code-Prozess** im PTY mit umgebogenem `ANTHROPIC_BASE_URL` —
  akzeptiert die CLI die Base-URL und läuft interaktiv unverändert?
- **Abo-Auth** (OAuth statt API-Key): Tokens zählbar, aber €-Kosten nicht exakt →
  Anzeige muss zwischen „Tokens exakt" und „€ geschätzt" trennen.
- **Rate-Limit-Header** (`anthropic-ratelimit-*`) für echte statt geschätzte
  Limit-Prognose.

Diese gehören in den nächsten Schritt (`vantage run claude` gegen den echten
Endpunkt), nicht mehr in diesen Spike.
