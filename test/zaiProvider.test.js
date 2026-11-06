const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createOpenAiCompatibleProvider,
} = require("../helpers/aiProviders/openaiCompatible");
const zai = require("../helpers/aiProviders/zai");
const { PROVIDER_IDS, providerCatalogue } = require("../helpers/aiProviders");

function mockResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
  };
}

test("Z.AI is registered as an AI Insights provider", () => {
  assert.ok(PROVIDER_IDS.includes("zai"));
  assert.equal(zai.DEFAULT_MODEL, "glm-4.7-flash");

  const entry = providerCatalogue().find((provider) => provider.id === "zai");
  assert.equal(entry.label, "Z.AI (GLM)");
  assert.equal(entry.keysUrl, "https://z.ai/manage-apikey/apikey-list");
});

test("Z.AI model listing only offers text GLM models", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    mockResponse({
      data: [
        { id: "glm-4.7-flash" },
        { id: "glm-5.3" },
        { id: "glm-4.6v-flash" },
        { id: "glm-ocr" },
      ],
    });

  try {
    const result = await zai.listModels("test-key");
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ["glm-4.7-flash", "glm-5.3"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("JSON-object providers receive the schema in their system instruction", async () => {
  const originalFetch = global.fetch;
  let sentBody;

  global.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return mockResponse({
      model: "glm-test",
      choices: [
        {
          finish_reason: "stop",
          message: { content: '{"summary":"ok"}' },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });
  };

  const provider = createOpenAiCompatibleProvider({
    id: "zai-test",
    baseUrl: "https://example.test/v1",
    defaultModel: "glm-test",
    responseFormat: "json_object",
    offerModel: () => true,
  });

  try {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };
    const result = await provider.generateInsights("test-key", {
      model: "glm-test",
      briefing: "Business facts",
      systemInstruction: "Write a concise insight.",
      responseSchema: schema,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(sentBody.response_format, { type: "json_object" });
    assert.match(sentBody.messages[0].content, /Write a concise insight/);
    assert.match(sentBody.messages[0].content, /"summary"/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("existing OpenAI-compatible providers retain strict JSON Schema mode", async () => {
  const originalFetch = global.fetch;
  let sentBody;

  global.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return mockResponse({
      model: "strict-test",
      choices: [
        {
          finish_reason: "stop",
          message: { content: '{"summary":"ok"}' },
        },
      ],
    });
  };

  const provider = createOpenAiCompatibleProvider({
    id: "strict-test",
    baseUrl: "https://example.test/v1",
    defaultModel: "strict-test",
    offerModel: () => true,
  });

  try {
    const result = await provider.generateInsights("test-key", {
      model: "strict-test",
      briefing: "Business facts",
      responseSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(sentBody.response_format.type, "json_schema");
    assert.equal(sentBody.response_format.json_schema.strict, true);
    assert.deepEqual(sentBody.response_format.json_schema.schema.required, [
      "summary",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});
