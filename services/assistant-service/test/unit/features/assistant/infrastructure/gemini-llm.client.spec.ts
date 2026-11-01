import {
  ApiError,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import {
  type LlmRequest,
  LlmQuotaExceededError,
  LlmUnavailableError,
} from '../../../../../src/features/assistant/application/contracts/llm-client.js';
import { GeminiLlmClient } from '../../../../../src/features/assistant/infrastructure/gemini-llm.client.js';

const TOOL = {
  name: 'get_order_timeline',
  description: 'Current state of one order.',
  parameters: {
    type: 'object',
    properties: { order_id: { type: 'string' } },
    required: ['order_id'],
  },
};

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: 'Answer from the tools.',
    messages: [{ role: 'user', text: '¿por qué?' }],
    tools: [TOOL],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function response(body: object): GenerateContentResponse {
  return body as GenerateContentResponse;
}

describe('GeminiLlmClient', () => {
  let generateContent: ReturnType<
    typeof vi.fn<
      (params: GenerateContentParameters) => Promise<GenerateContentResponse>
    >
  >;
  let client: GeminiLlmClient;

  beforeEach(() => {
    generateContent = vi.fn(async () =>
      response({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
      }),
    );
    client = new GeminiLlmClient({ generateContent }, 'gemini-test', {
      maxOutputTokens: 512,
    });
  });

  function sent(): GenerateContentParameters {
    const params = generateContent.mock.calls[0]?.[0];
    if (!params) throw new Error('generateContent was not called');
    return params;
  }

  it('reports the model it runs', () => {
    expect(client.model).toBe('gemini-test');
  });

  describe('the request', () => {
    it('sends the system prompt, the tools and the limits', async () => {
      const signal = new AbortController().signal;

      await client.complete(request({ signal }));

      expect(sent()).toEqual({
        model: 'gemini-test',
        contents: [{ role: 'user', parts: [{ text: '¿por qué?' }] }],
        config: {
          systemInstruction: 'Answer from the tools.',
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_order_timeline',
                  description: 'Current state of one order.',
                  parametersJsonSchema: TOOL.parameters,
                },
              ],
            },
          ],
          maxOutputTokens: 512,
          thinkingConfig: { thinkingLevel: 'LOW' },
          abortSignal: signal,
        },
      });
    });

    it('sends the model turn back as it came, then the tool results', async () => {
      const original = {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'c1',
              name: 'get_order_timeline',
              args: { order_id: 'o' },
            },
            thoughtSignature: 'opaque-signature',
          },
        ],
      };

      await client.complete(
        request({
          messages: [
            { role: 'user', text: 'q' },
            {
              role: 'model',
              text: '',
              toolCalls: [
                {
                  id: 'c1',
                  name: 'get_order_timeline',
                  args: { order_id: 'o' },
                },
              ],
              providerData: original,
            },
            {
              role: 'tool',
              results: [
                {
                  callId: 'c1',
                  name: 'get_order_timeline',
                  output: { found: false },
                },
                {
                  name: 'search_orders',
                  output: { error: 'invalid arguments' },
                },
              ],
            },
          ],
        }),
      );

      expect(sent().contents).toEqual([
        { role: 'user', parts: [{ text: 'q' }] },
        original,
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'c1',
                name: 'get_order_timeline',
                response: { found: false },
              },
            },
            {
              functionResponse: {
                name: 'search_orders',
                response: { error: 'invalid arguments' },
              },
            },
          ],
        },
      ]);
    });

    it('rebuilds a model turn that has no provider data', async () => {
      await client.complete(
        request({
          messages: [
            { role: 'user', text: 'q' },
            {
              role: 'model',
              text: 'looking',
              toolCalls: [{ name: 'search_orders', args: {} }],
            },
          ],
        }),
      );

      expect(sent().contents).toEqual([
        { role: 'user', parts: [{ text: 'q' }] },
        {
          role: 'model',
          parts: [
            { text: 'looking' },
            { functionCall: { name: 'search_orders', args: {} } },
          ],
        },
      ]);
    });
  });

  describe('the response', () => {
    it('returns the tool calls and keeps the content for the next turn', async () => {
      const content = {
        role: 'model',
        parts: [
          { text: 'thinking about it', thought: true },
          {
            functionCall: {
              id: 'c1',
              name: 'get_order_timeline',
              args: { order_id: 'o' },
            },
            thoughtSignature: 'sig',
          },
          { functionCall: { name: 'search_orders' } },
        ],
      };
      generateContent.mockResolvedValue(
        response({
          candidates: [{ content }],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 30,
          },
        }),
      );

      const turn = await client.complete(request());

      expect(turn).toEqual({
        message: {
          role: 'model',
          text: '',
          toolCalls: [
            { id: 'c1', name: 'get_order_timeline', args: { order_id: 'o' } },
            { name: 'search_orders', args: {} },
          ],
          providerData: content,
        },
        usage: { input: 100, output: 50 },
      });
    });

    it('joins the text parts of a final answer, without the thoughts', async () => {
      generateContent.mockResolvedValue(
        response({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'plan: ', thought: true },
                  { text: 'El pedido ' },
                  { text: 'se rechazó.' },
                ],
              },
            },
          ],
        }),
      );

      const turn = await client.complete(request());

      expect(turn.message).toMatchObject({
        text: 'El pedido se rechazó.',
        toolCalls: [],
      });
      expect(turn.usage).toEqual({ input: 0, output: 0 });
    });

    it('returns an empty answer when the model gave no candidate', async () => {
      generateContent.mockResolvedValue(response({ candidates: [] }));

      const turn = await client.complete(request());

      expect(turn.message).toMatchObject({ text: '', toolCalls: [] });
    });
  });

  describe('errors', () => {
    it('turns a 429 into a quota error', async () => {
      generateContent.mockRejectedValue(
        new ApiError({ message: 'RESOURCE_EXHAUSTED', status: 429 }),
      );

      await expect(client.complete(request())).rejects.toThrow(
        LlmQuotaExceededError,
      );
    });

    it('turns any other API error into an unavailable model', async () => {
      generateContent.mockRejectedValue(
        new ApiError({ message: 'internal', status: 500 }),
      );

      await expect(client.complete(request())).rejects.toThrow(
        new LlmUnavailableError('the model API answered 500'),
      );
    });

    it('reports a timeout when the question ran out of time', async () => {
      const controller = new AbortController();
      generateContent.mockImplementation(async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      });

      await expect(
        client.complete(request({ signal: controller.signal })),
      ).rejects.toThrow(
        new LlmUnavailableError('the model did not answer in time'),
      );
    });

    it('reports a network failure as an unavailable model', async () => {
      generateContent.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client.complete(request())).rejects.toThrow(
        new LlmUnavailableError('could not reach the model API'),
      );
    });
  });
});
