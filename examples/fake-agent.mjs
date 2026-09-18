// A stand-in "coding agent" used to verify Vantage's orchestration end-to-end
// without needing the real Claude Code binary. It mimics the ONE behaviour
// Vantage relies on: it reads ANTHROPIC_BASE_URL and streams a request to
// /v1/messages, printing the streamed text like a real agent would.
//
// If this runs correctly under `vantage run`, the whole chain is proven:
// env injection -> child spawn -> proxy -> usage metering -> event log.

const base = process.env.ANTHROPIC_BASE_URL;
if (!base) {
  console.error("fake-agent: ANTHROPIC_BASE_URL not set — vantage did not inject env");
  process.exit(2);
}

console.log(`fake-agent: talking to ${base}`);

const res = await fetch(base + "/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "sk-fake" },
  body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [] }),
});

// Parse the SSE stream and print text deltas, exactly as a real agent renders.
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
let text = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n\n")) !== -1) {
    const frame = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const json = JSON.parse(line.slice(5).trim());
        if (json.type === "content_block_delta" && json.delta?.text) {
          text += json.delta.text;
          process.stdout.write(json.delta.text);
        }
      } catch {}
    }
  }
}
process.stdout.write("\n");
console.log(`fake-agent: done (received "${text}")`);
