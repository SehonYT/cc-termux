import test from "node:test";
import assert from "node:assert/strict";

import {
  mapStop,
  flatten,
  stripCache,
  sanitizeBody,
  requestShapeError,
  toOpenAI,
  fromOpenAI,
  createTranslator,
  responsesApi,
  toResponses,
  fromResponses,
  createResponsesTranslator,
  estimate,
} from "../proxy/translate.mjs";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Collects the SSE events a translator sends, so assertions read like the wire format.
function recorder() {
  const events = [];
  return { events, send: (event, data) => events.push({ event, data }) };
}

function sse(...objects) {
  return objects.map((o) => "data: " + (typeof o === "string" ? o : JSON.stringify(o)) + "\n\n").join("");
}

function names(events, kind) {
  return events.filter((e) => e.event === kind).map((e) => e.data);
}

// ---------------------------------------------------------------------------
// mapStop / flatten / stripCache / sanitizeBody
// ---------------------------------------------------------------------------

test("mapStop maps finish reasons and only reports tool_use when tools were used", () => {
  assert.equal(mapStop("length", false), "max_tokens");
  assert.equal(mapStop("tool_calls", false), "tool_use");
  assert.equal(mapStop("content_filter", false), "end_turn");
  assert.equal(mapStop("stop", false), "end_turn");
  assert.equal(mapStop(undefined, false), "end_turn");
  // A response that produced tool calls is a tool_use turn even when the provider says stop.
  assert.equal(mapStop("stop", true), "tool_use");
  assert.equal(mapStop(undefined, true), "tool_use");
  assert.equal(mapStop("length", true), "max_tokens");
});

test("flatten turns any tool_result payload into text", () => {
  assert.equal(flatten("plain"), "plain");
  assert.equal(flatten([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(flatten([{ type: "image", source: {} }]), "[image omitted]");
  assert.equal(flatten([{ type: "weird", n: 1 }]), '{"type":"weird","n":1}');
  assert.equal(flatten(null), '""');
  assert.equal(flatten(undefined), '""');
  assert.equal(flatten(42), "42");
});

test("stripCache removes cache_control recursively and leaves everything else alone", () => {
  const input = {
    system: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "yo", cache_control: { type: "ephemeral" } }] }],
    tools: [{ name: "t", input_schema: { type: "object", properties: { a: { type: "string", cache_control: { x: 1 } } } } }],
  };
  assert.deepEqual(stripCache(input), {
    system: [{ type: "text", text: "hi" }],
    messages: [{ role: "user", content: [{ type: "text", text: "yo" }] }],
    tools: [{ name: "t", input_schema: { type: "object", properties: { a: { type: "string" } } } }],
  });
  assert.equal(stripCache(null), null);
  assert.equal(stripCache("x"), "x");
  assert.deepEqual(stripCache([1, 2]), [1, 2]);
});

test("sanitizeBody keeps the Anthropic request keys and drops provider-rejected ones", () => {
  const out = sanitizeBody({
    model: "m", messages: [], system: "s", tools: [], tool_choice: { type: "auto" },
    max_tokens: 5, temperature: 0.1, top_p: 1, top_k: 40, stop_sequences: ["x"], stream: true,
    metadata: { user_id: "u" },
    thinking: { type: "enabled" }, betas: ["x"], cache_control: { type: "ephemeral" },
    context_management: { edits: [] }, output_config: { effort: "high" },
  });
  assert.deepEqual(Object.keys(out).sort(), [
    "max_tokens", "messages", "metadata", "model", "stop_sequences", "stream", "system",
    "temperature", "tool_choice", "tools", "top_k", "top_p",
  ]);
  assert.deepEqual(sanitizeBody({}), {});
  assert.deepEqual(sanitizeBody(null), {});
  assert.deepEqual(sanitizeBody(undefined), {});
});

test("requestShapeError accepts valid bodies and names the first bad field", () => {
  assert.equal(requestShapeError({ model: "m", messages: [{ role: "user", content: "hi" }] }), null);
  assert.equal(requestShapeError({ messages: [] }), null);
  assert.equal(requestShapeError({ model: "m", messages: [{ role: "user", content: [] }], system: [] }), null);
  assert.equal(requestShapeError({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }), null);
  assert.equal(requestShapeError({}), null);

  assert.equal(requestShapeError(null), "request body must be a JSON object");
  assert.equal(requestShapeError([]), "request body must be a JSON object");
  assert.equal(requestShapeError("x"), "request body must be a JSON object");
  assert.equal(requestShapeError(42), "request body must be a JSON object");
  assert.equal(requestShapeError({ model: 42 }), "model must be a string");
  assert.equal(requestShapeError({ model: null }), null);
  assert.equal(requestShapeError({ messages: "x" }), "messages must be an array");
  assert.equal(requestShapeError({ messages: [null] }), "each message must be an object");
  assert.equal(requestShapeError({ messages: [[]] }), "each message must be an object");
  assert.equal(requestShapeError({ messages: [{ content: 42 }] }), "message content must be a string or an array of content blocks");
  assert.equal(requestShapeError({ messages: [{ content: [null] }] }), "each content block must be an object");
  assert.equal(requestShapeError({ messages: [{ content: ["x"] }] }), "each content block must be an object");
  assert.equal(requestShapeError({ system: 42 }), "system must be a string or an array of content blocks");
  assert.equal(requestShapeError({ system: [null] }), "each system block must be an object");
});

// ---------------------------------------------------------------------------
// toOpenAI
// ---------------------------------------------------------------------------

test("toOpenAI maps a system string and plain messages", () => {
  const req = toOpenAI({
    system: "be terse",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
  }, "up/m");
  assert.equal(req.model, "up/m");
  assert.equal(req.stream, false);
  assert.deepEqual(req.messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
});

test("toOpenAI joins system blocks and skips an empty system", () => {
  const req = toOpenAI({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }], messages: [{ role: "user", content: "x" }] }, "m");
  assert.deepEqual(req.messages[0], { role: "system", content: "a\nb" });
  assert.equal(toOpenAI({ system: [], messages: [] }, "m").messages.length, 0);
  assert.equal(toOpenAI({ system: "", messages: [] }, "m").messages.length, 0);
});

test("toOpenAI turns assistant tool_use into tool_calls and keeps text", () => {
  const req = toOpenAI({
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: "running" },
        { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } },
        { type: "tool_use", id: "toolu_2", name: "read", input: {} },
      ],
    }],
  }, "m");
  assert.equal(req.messages.length, 1);
  assert.deepEqual(req.messages[0], {
    role: "assistant",
    content: "running",
    tool_calls: [
      { id: "toolu_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
      { id: "toolu_2", type: "function", function: { name: "read", arguments: "{}" } },
    ],
  });
});

test("toOpenAI omits an empty assistant turn and defaults tool input to {}", () => {
  const req = toOpenAI({ messages: [
    { role: "assistant", content: [] },
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "n" }] },
  ] }, "m");
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].content, null);
  assert.equal(req.messages[0].tool_calls[0].function.arguments, "{}");
});

test("toOpenAI converts tool_result blocks into role=tool messages", () => {
  const req = toOpenAI({ messages: [{
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] },
      { type: "tool_result", tool_use_id: "toolu_2", content: "raw" },
    ],
  }] }, "m");
  assert.deepEqual(req.messages, [
    { role: "tool", tool_call_id: "toolu_1", content: "ok" },
    { role: "tool", tool_call_id: "toolu_2", content: "raw" },
  ]);
});

test("toOpenAI keeps text and images in user turns as content parts", () => {
  const req = toOpenAI({ messages: [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    { type: "image", source: { type: "url" } },
  ] }] }, "m");
  assert.deepEqual(req.messages[0].content, [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    { type: "image_url", image_url: { url: "https://example.com/a.png" } },
  ]);
});

test("toOpenAI uses a bare string when a user turn is a single text part", () => {
  const req = toOpenAI({ messages: [{ role: "user", content: [{ type: "text", text: "solo" }] }] }, "m");
  assert.equal(req.messages[0].content, "solo");
});

test("toOpenAI copies generation parameters and drops provider-only tool entries", () => {
  const schema = { type: "object", properties: { x: { type: "string" } } };
  const req = toOpenAI({
    messages: [], max_tokens: 10, temperature: 0.5, top_p: 0.9, stop_sequences: ["END"],
    stream: true,
    tools: [
      { name: "keep", description: "d", input_schema: schema },
      { name: "no-schema" },
      null,
      { name: "keep2", input_schema: { type: "object" } },
    ],
    tool_choice: { type: "tool", name: "keep" },
  }, "m");
  assert.equal(req.max_tokens, 10);
  assert.equal(req.temperature, 0.5);
  assert.equal(req.top_p, 0.9);
  assert.deepEqual(req.stop, ["END"]);
  assert.deepEqual(req.stream_options, { include_usage: true });
  assert.deepEqual(req.tools, [
    { type: "function", function: { name: "keep", description: "d", parameters: schema } },
    { type: "function", function: { name: "keep2", description: "", parameters: { type: "object" } } },
  ]);
  assert.deepEqual(req.tool_choice, { type: "function", function: { name: "keep" } });
});

test("toOpenAI maps every tool_choice variant", () => {
  const base = { messages: [] };
  assert.equal(toOpenAI({ ...base, tool_choice: { type: "auto" } }, "m").tool_choice, "auto");
  assert.equal(toOpenAI({ ...base, tool_choice: { type: "any" } }, "m").tool_choice, "required");
  assert.equal(toOpenAI({ ...base, tool_choice: { type: "none" } }, "m").tool_choice, "none");
  assert.equal(toOpenAI(base, "m").tool_choice, undefined);
  assert.equal(toOpenAI({ ...base, tool_choice: { type: "bogus" } }, "m").tool_choice, undefined);
});

test("toOpenAI disables reasoning effort only for OpenAI models with tools", () => {
  const tools = [{ name: "t", input_schema: { type: "object" } }];
  assert.equal(toOpenAI({ messages: [], tools }, "openai/gpt-5").reasoning_effort, "none");
  assert.equal(toOpenAI({ messages: [], tools }, "deepseek/deepseek-v4").reasoning_effort, undefined);
  assert.equal(toOpenAI({ messages: [], tools: [{ name: "t" }] }, "openai/gpt-5").reasoning_effort, undefined);
  assert.equal(toOpenAI({ messages: [] }, "openai/gpt-5").reasoning_effort, undefined);
});

test("toOpenAI tolerates missing messages, tools and content", () => {
  const req = toOpenAI({}, "m");
  assert.deepEqual(req.messages, []);
  assert.equal(req.tools, undefined);
  const nulled = toOpenAI({ messages: [{ role: "assistant", content: null }, { role: "user", content: null }] }, "m");
  assert.deepEqual(nulled.messages, []);
});

// ---------------------------------------------------------------------------
// fromOpenAI
// ---------------------------------------------------------------------------

test("fromOpenAI builds a text message with usage", () => {
  const msg = fromOpenAI({
    id: "chatcmpl-1",
    choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  }, "m");
  assert.equal(msg.id, "chatcmpl-1");
  assert.equal(msg.type, "message");
  assert.equal(msg.role, "assistant");
  assert.equal(msg.model, "m");
  assert.deepEqual(msg.content, [{ type: "text", text: "hello" }]);
  assert.equal(msg.stop_reason, "end_turn");
  assert.equal(msg.stop_sequence, null);
  assert.deepEqual(msg.usage, { input_tokens: 11, output_tokens: 3 });
});

test("fromOpenAI maps tool_calls, parses arguments and survives malformed JSON", () => {
  const msg = fromOpenAI({
    choices: [{
      message: {
        content: "thinking",
        tool_calls: [
          { id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          { id: "call_2", function: { name: "read", arguments: "{not json" } },
        ],
      },
      finish_reason: "tool_calls",
    }],
  }, "m");
  assert.deepEqual(msg.content, [
    { type: "text", text: "thinking" },
    { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } },
    { type: "tool_use", id: "call_2", name: "read", input: {} },
  ]);
  assert.equal(msg.stop_reason, "tool_use");
});

test("fromOpenAI handles empty answers, missing choice and absent usage", () => {
  const empty = fromOpenAI({ choices: [{ message: {} }] }, "m");
  assert.deepEqual(empty.content, [{ type: "text", text: "" }]);
  assert.equal(empty.stop_reason, "end_turn");
  assert.deepEqual(empty.usage, { input_tokens: 0, output_tokens: 0 });
  assert.match(fromOpenAI({}, "m").id, /^msg_/);
  assert.equal(fromOpenAI({ choices: [{ message: {}, finish_reason: "length" }] }, "m").stop_reason, "max_tokens");
});

test("fromOpenAI surfaces upstream errors instead of returning an empty message", () => {
  assert.throws(() => fromOpenAI({ error: { message: "bad key" } }, "m"), /upstream error: bad key/);
  assert.throws(() => fromOpenAI({ error: { code: "x" } }, "m"), /upstream error: {"code":"x"}/);
});

// ---------------------------------------------------------------------------
// responsesApi / toResponses / fromResponses
// ---------------------------------------------------------------------------

test("responsesApi picks an explicit api, a per-model api, then auto detection", () => {
  assert.equal(responsesApi({ api: "chat" }, "openai/gpt-5"), "chat");
  assert.equal(responsesApi({ apiByModel: { "openai/gpt-5": "chat" } }, "openai/gpt-5"), "chat");
  assert.equal(responsesApi({ apiMode: "auto" }, "openai/gpt-5"), "responses");
  assert.equal(responsesApi({ apiMode: "auto" }, "anthropic/claude"), "chat");
  assert.equal(responsesApi({}, "openai/gpt-5"), "chat");
  assert.equal(responsesApi({ apiMode: "chat" }, "openai/gpt-5"), "chat");
});

test("toResponses maps system to instructions and messages to input items", () => {
  const req = toResponses({
    system: "sys",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }, { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "done" }] }] },
      { role: "user", content: [{ type: "text", text: "more" }, { type: "image", source: { type: "base64", data: "x" } }] },
    ],
  }, "openai/gpt-5");
  assert.equal(req.model, "openai/gpt-5");
  assert.equal(req.instructions, "sys");
  assert.equal(req.stream, false);
  assert.deepEqual(req.input, [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
    { role: "assistant", content: [{ type: "output_text", text: "yo" }] },
    { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"ls"}' },
    { type: "function_call_output", call_id: "call_1", output: "done" },
    { role: "user", content: [{ type: "input_text", text: "more" }] },
  ]);
});

test("toResponses copies limits and tool definitions", () => {
  const schema = { type: "object" };
  const req = toResponses({
    messages: [], max_tokens: 7, temperature: 0.2, top_p: 0.8, stream: true,
    tools: [{ name: "t", description: "d", input_schema: schema }, { name: "skip" }],
    tool_choice: { type: "any" },
  }, "m");
  assert.equal(req.max_output_tokens, 7);
  assert.equal(req.temperature, 0.2);
  assert.equal(req.top_p, 0.8);
  assert.equal(req.stream, true);
  assert.deepEqual(req.tools, [{ type: "function", name: "t", description: "d", parameters: schema }]);
  assert.equal(req.tool_choice, "required");
  assert.equal(toResponses({ messages: [] }, "m").instructions, undefined);
});

test("fromResponses collects message text and function calls", () => {
  const msg = fromResponses({
    id: "resp_1",
    output: [
      { type: "message", content: [{ type: "output_text", text: "hello" }, { type: "refusal", refusal: "no" }] },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"ls"}' },
      { type: "function_call", call_id: "call_2", name: "read", arguments: "{" },
    ],
    usage: { input_tokens: 3, output_tokens: 4 },
  }, "m");
  assert.equal(msg.id, "resp_1");
  assert.deepEqual(msg.content, [
    { type: "text", text: "hello" },
    { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } },
    { type: "tool_use", id: "call_2", name: "read", input: {} },
  ]);
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.usage, { input_tokens: 3, output_tokens: 4 });
});

test("fromResponses falls back to output_text, then an empty block", () => {
  assert.deepEqual(fromResponses({ output_text: "tail" }, "m").content, [{ type: "text", text: "tail" }]);
  const empty = fromResponses({}, "m");
  assert.deepEqual(empty.content, [{ type: "text", text: "" }]);
  assert.equal(empty.stop_reason, "end_turn");
  assert.match(empty.id, /^msg_/);
  assert.throws(() => fromResponses({ error: { message: "boom" } }, "m"), /upstream error: boom/);
});

// ---------------------------------------------------------------------------
// estimate
// ---------------------------------------------------------------------------

test("estimate counts strings, structures and images", () => {
  assert.equal(estimate(null), 0);
  assert.equal(estimate(undefined), 0);
  assert.equal(estimate("abcd"), 1);
  assert.equal(estimate("abcde"), 2);
  assert.equal(estimate([]), 0);
  assert.equal(estimate(["abcd", "efgh"]), 2);
  assert.equal(estimate({ a: "abcd" }), 1);
  assert.equal(estimate({ type: "image" }), 85);
  assert.equal(estimate({ type: "image_url" }), 85);
  assert.equal(estimate({ source: { type: "base64" } }), 85);
  assert.equal(estimate({ data: "x" }), 85, "raw base64 data is priced as an image payload");
  assert.equal(estimate(42), 1);
  assert.equal(estimate(true), 1);
});

// ---------------------------------------------------------------------------
// createTranslator: OpenAI chat streaming -> Anthropic SSE
// ---------------------------------------------------------------------------

test("createTranslator streams text deltas into one Anthropic text block", () => {
  const rec = recorder();
  const tr = createTranslator("m", rec.send);
  tr.onData(sse(
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ));
  tr.onEnd();

  assert.deepEqual(names(rec.events, "message_start").length, 1);
  assert.deepEqual(names(rec.events, "content_block_start"), [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }]);
  assert.deepEqual(names(rec.events, "content_block_delta").map((d) => d.delta), [
    { type: "text_delta", text: "Hel" },
    { type: "text_delta", text: "lo" },
  ]);
  assert.deepEqual(names(rec.events, "content_block_stop"), [{ type: "content_block_stop", index: 0 }]);
  assert.equal(names(rec.events, "message_delta")[0].delta.stop_reason, "end_turn");
  assert.equal(rec.events.at(-1).event, "message_stop");
});

test("createTranslator reassembles SSE lines split across chunks", () => {
  const rec = recorder();
  const tr = createTranslator("m", rec.send);
  const wire = sse({ choices: [{ delta: { content: "split" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] });
  for (const ch of wire.match(/[\s\S]{1,7}/g)) tr.onData(ch);
  tr.onEnd();
  assert.deepEqual(names(rec.events, "content_block_delta").map((d) => d.delta.text), ["split"]);
  assert.equal(names(rec.events, "message_start").length, 1);
});

test("createTranslator ignores comments, [DONE], blank data and invalid JSON", () => {
  const rec = recorder();
  const tr = createTranslator("m", rec.send);
  tr.onData("event: message\n:comment\ndata: [DONE]\n\ndata: {oops\n\ndata: \n\n");
  tr.onEnd();
  assert.equal(names(rec.events, "content_block_start").length, 0);
  assert.deepEqual(names(rec.events, "message_delta")[0], {
    type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 },
  });
});

test("createTranslator maps streamed tool calls (including parallel calls) to tool_use blocks", () => {
  const rec = recorder();
  const tr = createTranslator("m", rec.send);
  tr.onData(sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "bash", arguments: '{"cm' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'd":"ls"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "read" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 9, completion_tokens: 5 } },
  ));
  tr.onEnd();

  const starts = names(rec.events, "content_block_start");
  assert.deepEqual(starts.map((s) => s.content_block.type), ["tool_use", "tool_use"]);
  assert.deepEqual(starts.map((s) => s.content_block.name), ["bash", "read"]);
  assert.equal(starts[0].content_block.id, "call_a");
  assert.equal(starts[1].content_block.id, "call_b");
  assert.deepEqual(names(rec.events, "content_block_delta").map((d) => [d.index, d.delta.partial_json]), [[0, '{"cm'], [0, 'd":"ls"}']]);
  const delta = names(rec.events, "message_delta")[0];
  assert.equal(delta.delta.stop_reason, "tool_use");
  assert.deepEqual(delta.usage, { input_tokens: 9, output_tokens: 5 });
  assert.deepEqual(names(rec.events, "content_block_stop").map((s) => s.index), [0, 1]);
});

test("createTranslator closes a text block before opening a tool block", () => {
  const rec = recorder();
  const tr = createTranslator("m", rec.send);
  tr.onData(sse(
    { choices: [{ delta: { content: "thinking" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "bash", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ));
  tr.onEnd();
  const order = rec.events.map((e) => e.event);
  assert.deepEqual(order.filter((e) => e === "content_block_start").length, 2);
  assert.ok(order.indexOf("content_block_stop") < order.lastIndexOf("content_block_start"), "text block stops before the tool block starts");
});

test("createTranslator reports upstream stream errors and does not emit message_stop", () => {
  const rec = recorder();
  const logged = [];
  const tr = createTranslator("m", rec.send, { log: (...a) => logged.push(a) });
  tr.onData(sse({ error: { message: "overloaded" } }));
  tr.onEnd();
  assert.deepEqual(names(rec.events, "error"), [{ type: "error", error: { type: "api_error", message: "overloaded" } }]);
  assert.equal(names(rec.events, "message_stop").length, 0);
  assert.equal(names(rec.events, "message_delta").length, 0);
  assert.ok(logged.length >= 1);
});

test("createTranslator works without a log hook", () => {
  const rec = recorder();
  const tr = createTranslator("m", rec.send);
  assert.doesNotThrow(() => tr.onData(sse({ error: { message: "x" } })));
});

// ---------------------------------------------------------------------------
// createResponsesTranslator: Responses API streaming -> Anthropic SSE
// ---------------------------------------------------------------------------

test("createResponsesTranslator streams output_text deltas as a text block", () => {
  const rec = recorder();
  const tr = createResponsesTranslator("openai/gpt-5", rec.send);
  tr.onData(sse(
    { type: "response.output_text.delta", delta: "He" },
    { type: "response.output_text.delta", delta: "y" },
    { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2 }, output: [] } },
  ));
  tr.onEnd();
  assert.equal(names(rec.events, "message_start").length, 1);
  assert.deepEqual(names(rec.events, "content_block_delta").map((d) => d.delta), [
    { type: "text_delta", text: "He" },
    { type: "text_delta", text: "y" },
  ]);
  assert.equal(names(rec.events, "message_delta")[0].usage.output_tokens, 2);
  assert.equal(rec.events.at(-1).event, "message_stop");
});

test("createResponsesTranslator streams function calls and marks the turn as tool_use", () => {
  const rec = recorder();
  const tr = createResponsesTranslator("m", rec.send);
  tr.onData(sse(
    { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"cmd":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"ls"}' },
    { type: "response.function_call_arguments.delta", item_id: "unknown", delta: "ignored" },
    { type: "response.completed", response: { output: [{ type: "function_call" }], usage: { input_tokens: 2, output_tokens: 6 } } },
  ));
  tr.onEnd();

  const starts = names(rec.events, "content_block_start");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].content_block, { type: "tool_use", id: "call_1", name: "bash", input: {} });
  assert.deepEqual(names(rec.events, "content_block_delta").map((d) => d.delta.partial_json), ['{"cmd":', '"ls"}']);
  assert.equal(names(rec.events, "message_delta")[0].delta.stop_reason, "tool_use");
  assert.equal(names(rec.events, "message_stop").length, 1);
});

test("createResponsesTranslator tolerates response.done and duplicate finish events", () => {
  const rec = recorder();
  const tr = createResponsesTranslator("m", rec.send);
  tr.onData(sse(
    { type: "response.output_text.delta", delta: "x" },
    { type: "response.done", response: {} },
    { type: "response.completed", response: {} },
  ));
  tr.onEnd();
  assert.equal(names(rec.events, "message_stop").length, 1);
  assert.equal(names(rec.events, "message_delta").length, 1);
});

test("createResponsesTranslator reports errors and suppresses the finish events", () => {
  const rec = recorder();
  const failures = [];
  const tr = createResponsesTranslator("m", rec.send, { logFailure: (...a) => failures.push(a), log: () => {} });
  tr.onData(sse({ type: "response.failed", response: { error: { message: "server_error" } } }));
  tr.onEnd();
  assert.deepEqual(names(rec.events, "error"), [{ type: "error", error: { type: "api_error", message: "server_error" } }]);
  assert.equal(names(rec.events, "message_stop").length, 0);
  assert.equal(failures.length, 1);
});

test("createResponsesTranslator ignores unrelated events and works without hooks", () => {
  const rec = recorder();
  const tr = createResponsesTranslator("m", rec.send);
  const wire = sse(
    { type: "response.created", response: {} },
    { type: "response.in_progress" },
    { type: "error", error: { code: "oops" } },
  );
  for (const ch of wire.match(/[\s\S]{1,5}/g)) tr.onData(ch);
  tr.onEnd();
  assert.deepEqual(names(rec.events, "error"), [{ type: "error", error: { type: "api_error", message: "oops" } }]);
});
