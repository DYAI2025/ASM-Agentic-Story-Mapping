import http from "node:http";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { OUTPUT_CONTRACT } from "../../src/agent/prompt";
import { blankProduct } from "../../src/domain/bootstrap";
import { asQaObserved } from "../fixtures/qa-observed-shape";

/**
 * A stand-in for a model behind the OpenAI Responses API, for the browser
 * tests of ASM-29. The app under test runs its real `openai` adapter against
 * this server (`OPENAI_BASE_URL`), so the request, the repair and the
 * validation are the product's own; only the model is scripted:
 *
 * - a first request is answered in the shape External QA recorded from the
 *   reference model (source fields flattened, needs as id/text);
 * - a repair request (the product's repair section present) is answered with
 *   a valid proposal for the marker lines in the pasted text;
 * - a text containing `[stub:never-in-shape]` is answered in the wrong shape
 *   every time;
 * - a text containing `[stub:inexact-quote]` is first answered in the right
 *   shape with one quote that is not in the text (its first word dropped and
 *   the case of the next letter changed, the kind of near miss the reference
 *   model made on 2026-10-06), then correctly on the repair request.
 *
 * It records every request so a test can count them (`GET /calls`) and see
 * whether the key travelled anywhere but the header. `POST /reset` forgets them.
 */
const PORT = Number(process.env.STUB_PORT ?? 3315);
const KEY = process.env.STUB_KEY ?? "";
const REPAIR_MARKER = "Your previous answer to this request could not be used";

type Recorded = { repair: boolean; contract: boolean; keyInBody: boolean; authorized: boolean; namesRefusedQuote: boolean };
let calls: Recorded[] = [];

/** The text of the first source block of a proposal request: what the human pasted. */
function pastedText(message: string): string {
  const block = /\n<([^>\n]+)>\nlabel: [^\n]*\n([\s\S]*?)\n<\/\1>/.exec(message);
  return block ? block[2] : "";
}

/** The quote with its first word dropped and the case of the next letter changed: close to the text, not in it. */
function nearMiss(snippet: string): string {
  const rest = snippet.split(" ").slice(1).join(" ");
  if (rest === "") return "";
  const first = rest[0] === rest[0].toUpperCase() ? rest[0].toLowerCase() : rest[0].toUpperCase();
  return first + rest.slice(1);
}

function answer(output: unknown) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] };
}

const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/health") return send(200, { ok: true });
    if (request.method === "GET" && request.url === "/calls") return send(200, calls);
    if (request.method === "POST" && request.url === "/reset") {
      calls = [];
      return send(200, { ok: true });
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") return send(404, { error: { message: "not here" } });

    const body = JSON.parse(raw) as { input?: Array<{ content?: string }> };
    const message = body.input?.[0]?.content ?? "";
    const repair = message.includes(REPAIR_MARKER);
    const text = pastedText(message);
    const draft = blankProduct("Stub");
    if (!draft.ok) return send(500, { error: { message: "no draft" } });
    const valid = structureWithMarkers(text, draft.product);
    const inexact = nearMiss(valid.personas[0]?.source.snippet ?? "");
    calls.push({
      repair,
      contract: message.includes(OUTPUT_CONTRACT),
      keyInBody: KEY !== "" && raw.includes(KEY),
      authorized: request.headers.authorization === `Bearer ${KEY}`,
      namesRefusedQuote: repair && inexact !== "" && message.includes(inexact),
    });
    if (text.includes("[stub:inexact-quote]") && !repair) {
      const spoiled = { ...valid, personas: valid.personas.map((p, i) => (i === 0 ? { ...p, source: { ...p.source, snippet: inexact } } : p)) };
      return send(200, answer(spoiled));
    }
    if (text.includes("[stub:never-in-shape]") || !repair) return send(200, answer(asQaObserved(valid)));
    return send(200, answer(valid));
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`model stub on ${PORT}`));
