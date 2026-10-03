import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider, DEFAULT_MODEL } from "../../src/agent/anthropic-provider";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { reviewWithRules } from "../../src/agent/fake-review";
import { buildProposal } from "../../src/agent/narrative-builder";
import { OpenAIProvider } from "../../src/agent/openai-provider";
import { OpenRouterProvider } from "../../src/agent/openrouter-provider";
import type { AgentProvider, ReviewProvider } from "../../src/agent/provider";
import { buildReview } from "../../src/agent/reviewer";
import { loadFixture } from "../domain/helpers";

/**
 * External review rounds 7–10 each found a configured secret reaching
 * something the server emits, through a different channel every time: a
 * status field, an output value, an escaped spelling, the SDK's log, the
 * SDK's exception text, an upstream error body. This file is the oracle for
 * the whole class, so that closing one channel is never mistaken for closing
 * the class:
 *
 *   - every channel an adapter reads from upstream (output values and keys,
 *     recursively; envelope metadata; error bodies at non-2xx and in a 200;
 *     the SDK's own parsing exception; a network failure's message),
 *   - four spellings of the secret (plain, with a quote, with a backslash,
 *     with a non-ASCII character),
 *   - all three adapters, Anthropic through the real SDK over a stubbed
 *     transport, for proposals and reviews,
 *   - and what is looked for is the secret's plain tail, which survives any
 *     escaping depth, in the whole result and in everything written to the
 *     console meanwhile.
 */

const TRANSCRIPT = readFileSync(path.join(__dirname, "..", "fixtures", "workshop-transcript.txt"), "utf8");
const SECRETS = ["plain-secret-tail-0001", 'with-"quote"-tail-0002', "with-\\backslash-tail-0003", "with-ümlaut-tail-0004"];
const tail = (secret: string) => secret.slice(-9);

const honestProposal = () => structureWithMarkers(TRANSCRIPT, loadFixture());
const honestReview = () => reviewWithRules(loadFixture());

/** Every string leaf and every object key of a value, as a path and a replacer. */
function placements(value: unknown, at: string[] = []): Array<{ where: string; place: (secret: string) => unknown }> {
  const out: Array<{ where: string; place: (secret: string) => unknown }> = [];
  const set = (root: unknown, pathTo: string[], leaf: unknown): unknown => {
    if (pathTo.length === 0) return leaf;
    const [head, ...rest] = pathTo;
    if (Array.isArray(root)) return root.map((item, i) => (String(i) === head ? set(item, rest, leaf) : item));
    const record = root as Record<string, unknown>;
    return { ...record, [head]: set(record[head], rest, leaf) };
  };
  const renameKey = (root: unknown, pathTo: string[], from: string, to: string): unknown => {
    if (pathTo.length === 0) {
      const record = root as Record<string, unknown>;
      return Object.fromEntries(Object.entries(record).map(([k, v]) => [k === from ? to : k, v]));
    }
    const [head, ...rest] = pathTo;
    if (Array.isArray(root)) return root.map((item, i) => (String(i) === head ? renameKey(item, rest, from, to) : item));
    const record = root as Record<string, unknown>;
    return { ...record, [head]: renameKey(record[head], rest, from, to) };
  };
  const walk = (node: unknown, pathTo: string[]) => {
    if (typeof node === "string") {
      out.push({ where: pathTo.join("."), place: (secret) => set(value, pathTo, secret) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...pathTo, String(i)]));
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        out.push({ where: `${pathTo.join(".")}{${key}}`, place: (secret) => renameKey(value, pathTo, key, secret) });
        walk(child, [...pathTo, key]);
      }
    }
  };
  walk(value, at);
  return out;
}

type Answer = { status?: number; body: unknown };
const stubFetch = (answer: Answer): typeof globalThis.fetch =>
  (async () => new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
const failingFetch = (message: string): typeof globalThis.fetch =>
  (async () => {
    throw new TypeError(message);
  }) as typeof globalThis.fetch;

/** The three adapters, each answering from one stubbed transport. */
function adapters(secret: string, fetch: typeof globalThis.fetch): Array<AgentProvider & ReviewProvider> {
  return [
    new OpenAIProvider({ apiKey: secret, fetch }),
    new OpenRouterProvider({ apiKey: secret, model: "v/m", fetch }),
    new AnthropicProvider({ apiKey: secret, secrets: [secret], fetch, timeoutMs: 5000 }),
  ];
}

/** Envelopes: how each API wraps a model's text, metadata, or an error. */
const envelope = {
  openai: {
    ok: (text: string, status = "completed") => ({ status, output: [{ type: "message", content: [{ type: "output_text", text }] }] }),
    error: (message: string) => ({ error: { message, type: "invalid_request_error" } }),
  },
  openrouter: {
    ok: (text: string, finish = "stop") => ({ choices: [{ finish_reason: finish, message: { role: "assistant", content: text } }] }),
    error: (message: string) => ({ error: { message, code: 400 } }),
    modelError: (message: string) => ({ choices: [{ finish_reason: "error", error: { message }, message: { role: "assistant", content: "" } }] }),
  },
  anthropic: {
    ok: (text: string, stop = "end_turn") => ({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: DEFAULT_MODEL,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text }],
    }),
    error: (message: string) => ({ type: "error", error: { type: "invalid_request_error", message } }),
  },
};

/** Runs one call and returns everything that could carry the secret: the result and the console. */
async function observe(run: () => Promise<unknown>): Promise<string> {
  const logged: string[] = [];
  const spies = (["debug", "info", "warn", "error", "log"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }),
  );
  const before = process.env.ANTHROPIC_LOG;
  process.env.ANTHROPIC_LOG = "debug";
  try {
    const result = await run();
    return `${JSON.stringify(result)}\n${logged.join("\n")}`;
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_LOG;
    else process.env.ANTHROPIC_LOG = before;
    for (const spy of spies) spy.mockRestore();
  }
}

const expectContained = (text: string, secret: string, label: string) => {
  expect(text, label).not.toContain(secret);
  expect(text, label).not.toContain(tail(secret));
};

describe("credentials the SDK would send on its own", () => {
  it("an ambient ANTHROPIC_AUTH_TOKEN is never sent: ASM chose the API key, and only that is contained (external review round 11)", async () => {
    const ambient = "ambient-bearer-token-tail-5555";
    const before = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = ambient;
    const headersSeen: Array<Record<string, string>> = [];
    const fetch: typeof globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      headersSeen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(JSON.stringify(envelope.anthropic.ok(JSON.stringify({ ...honestProposal(), summary: `echo ${ambient}` }))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    try {
      const provider = new AnthropicProvider({ apiKey: "the-chosen-key-0001", secrets: ["the-chosen-key-0001"], fetch, timeoutMs: 5000 });
      const result = await buildProposal(loadFixture(), TRANSCRIPT, provider);
      expect(headersSeen).toHaveLength(1);
      expect(Object.keys(headersSeen[0]).map((k) => k.toLowerCase())).not.toContain("authorization");
      expect(JSON.stringify(headersSeen[0])).not.toContain(ambient);
      // What the server could not have received, it cannot have echoed; the proposal stands on its own.
      expect(result.ok).toBe(true);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = before;
    }
  });
});

describe("an error is an error whatever shape it has (external review round 11)", () => {
  it("a 200 with valid output and an error object without a message is a failure, not a proposal", async () => {
    const text = JSON.stringify(honestProposal());
    const cases: Array<[string, AgentProvider]> = [
      ["openai", new OpenAIProvider({ apiKey: "k-0001", fetch: stubFetch({ body: { ...envelope.openai.ok(text), error: { code: 502, metadata: { raw: "upstream disconnected" } } } }) })],
      ["openrouter top-level", new OpenRouterProvider({ apiKey: "k-0001", model: "v/m", fetch: stubFetch({ body: { ...envelope.openrouter.ok(text), error: { code: 502, metadata: { raw: "upstream disconnected" } } } }) })],
      ["openrouter choice-level with finish_reason stop", new OpenRouterProvider({ apiKey: "k-0001", model: "v/m", fetch: stubFetch({ body: { choices: [{ finish_reason: "stop", error: { code: 502 }, message: { role: "assistant", content: text } }] } }) })],
      ["openrouter error: null is not an error", new OpenRouterProvider({ apiKey: "k-0001", model: "v/m", fetch: stubFetch({ body: { ...envelope.openrouter.ok(text), error: null } }) })],
    ];
    for (const [channel, provider] of cases) {
      const result = await buildProposal(loadFixture(), TRANSCRIPT, provider);
      if (channel.endsWith("is not an error")) {
        expect(result.ok, channel).toBe(true);
        continue;
      }
      expect(result.ok, channel).toBe(false);
      expect(result.ok === false && result.issues[0].code, channel).toBe("provider_error");
    }
  });
});

describe("secret containment: no channel, no spelling, no adapter", () => {
  it("output values and keys, recursively, for proposals and reviews", async () => {
    const fixture = loadFixture();
    for (const secret of SECRETS) {
      for (const [kind, honest] of [
        ["proposal", honestProposal()],
        ["review", honestReview()],
      ] as const) {
        for (const { where, place } of placements(honest)) {
          const text = JSON.stringify(place(secret));
          const bodies = [envelope.openai.ok(text), envelope.openrouter.ok(text), envelope.anthropic.ok(text)];
          const providers = adapters(secret, stubFetch({ body: bodies[0] }));
          providers[1] = new OpenRouterProvider({ apiKey: secret, model: "v/m", fetch: stubFetch({ body: bodies[1] }) });
          providers[2] = new AnthropicProvider({ apiKey: secret, secrets: [secret], fetch: stubFetch({ body: bodies[2] }), timeoutMs: 5000 });
          for (const provider of providers) {
            const label = `${provider.name} / ${kind} / ${where} / ${secret}`;
            const seen = await observe(() => (kind === "proposal" ? buildProposal(fixture, TRANSCRIPT, provider) : buildReview(fixture, provider)));
            expectContained(seen, secret, label);
          }
        }
      }
    }
  }, 120_000);

  it("envelope metadata: status, finish_reason, stop_reason", async () => {
    const fixture = loadFixture();
    const text = JSON.stringify(honestProposal());
    for (const secret of SECRETS) {
      const cases: Array<[string, AgentProvider]> = [
        ["openai status", new OpenAIProvider({ apiKey: secret, fetch: stubFetch({ body: envelope.openai.ok(text, `odd ${secret}`) }) })],
        ["openrouter finish_reason", new OpenRouterProvider({ apiKey: secret, model: "v/m", fetch: stubFetch({ body: envelope.openrouter.ok(text, `odd ${secret}`) }) })],
        ["anthropic stop_reason", new AnthropicProvider({ apiKey: secret, secrets: [secret], fetch: stubFetch({ body: envelope.anthropic.ok(text, `odd ${secret}`) }), timeoutMs: 5000 })],
      ];
      for (const [channel, provider] of cases) {
        const seen = await observe(() => buildProposal(fixture, TRANSCRIPT, provider));
        expectContained(seen, secret, `${channel} / ${secret}`);
      }
    }
  });

  it("error bodies: non-2xx, error-in-200, model error, network failure", async () => {
    const fixture = loadFixture();
    for (const secret of SECRETS) {
      const message = `upstream says ${secret} and "${secret}" and ${JSON.stringify(secret)}`;
      const cases: Array<[string, AgentProvider]> = [
        ["openai 400", new OpenAIProvider({ apiKey: secret, fetch: stubFetch({ status: 400, body: envelope.openai.error(message) }) })],
        ["openai error in 200", new OpenAIProvider({ apiKey: secret, fetch: stubFetch({ body: envelope.openai.error(message) }) })],
        ["openai 500 text", new OpenAIProvider({ apiKey: secret, fetch: stubFetch({ status: 500, body: message }) })],
        ["openrouter 400", new OpenRouterProvider({ apiKey: secret, model: "v/m", fetch: stubFetch({ status: 400, body: envelope.openrouter.error(message) }) })],
        ["openrouter error in 200", new OpenRouterProvider({ apiKey: secret, model: "v/m", fetch: stubFetch({ body: envelope.openrouter.error(message) }) })],
        ["openrouter model error", new OpenRouterProvider({ apiKey: secret, model: "v/m", fetch: stubFetch({ body: envelope.openrouter.modelError(message) }) })],
        ["anthropic 400", new AnthropicProvider({ apiKey: secret, secrets: [secret], fetch: stubFetch({ status: 400, body: envelope.anthropic.error(message) }), timeoutMs: 5000 })],
        ["anthropic 500", new AnthropicProvider({ apiKey: secret, secrets: [secret], fetch: stubFetch({ status: 500, body: message }), timeoutMs: 5000 })],
        ["openai network failure", new OpenAIProvider({ apiKey: secret, fetch: failingFetch(message) })],
        ["anthropic network failure", new AnthropicProvider({ apiKey: secret, secrets: [secret], fetch: failingFetch(message), timeoutMs: 5000 })],
      ];
      for (const [channel, provider] of cases) {
        const seen = await observe(() => buildProposal(fixture, TRANSCRIPT, provider));
        expectContained(seen, secret, `${channel} / ${secret}`);
      }
    }
  }, 60_000);

  it("the SDK's own parsing exception: an unexpected key, a wrong type, non-JSON text, through the real Anthropic SDK", async () => {
    const fixture = loadFixture();
    for (const secret of SECRETS) {
      const honest = honestProposal();
      const outputs: Array<[string, string]> = [
        ["unexpected key", JSON.stringify({ ...honest, [secret]: "x" })],
        ["wrong type", JSON.stringify({ ...honest, summary: { nested: secret } })],
        ["non-JSON text", `not json ${secret}`],
        ["array instead of object", JSON.stringify([secret])],
      ];
      for (const [channel, text] of outputs) {
        const provider = new AnthropicProvider({ apiKey: secret, secrets: [secret], fetch: stubFetch({ body: envelope.anthropic.ok(text) }), timeoutMs: 5000 });
        const seen = await observe(() => buildProposal(fixture, TRANSCRIPT, provider));
        expectContained(seen, secret, `${channel} / ${secret}`);
      }
    }
  });
});
