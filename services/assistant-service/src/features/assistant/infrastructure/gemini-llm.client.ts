import {
  ApiError,
  type Content,
  type Models,
  type Part,
  ThinkingLevel,
} from '@google/genai';
import {
  type ConversationMessage,
  LlmClient,
  LlmQuotaExceededError,
  type LlmRequest,
  type LlmTurn,
  LlmUnavailableError,
  type ToolCall,
} from '../application/contracts/llm-client.js';

export interface GeminiOptions {
  /** Caps the answer, thinking included, so a turn can't drain the quota. */
  maxOutputTokens?: number;
}

const QUOTA_EXCEEDED = 429;

/**
 * The real model: Gemini through `@google/genai`, one stateless
 * `generateContent` call per turn with function calling.
 *
 * Gemini 3 models attach thought signatures to their turns and expect them
 * back unchanged, so each model turn keeps the content it came with
 * (`providerData`) and is replayed as is; only a turn without it is rebuilt.
 */
export class GeminiLlmClient extends LlmClient {
  private readonly maxOutputTokens: number;

  constructor(
    private readonly models: Pick<Models, 'generateContent'>,
    readonly model: string,
    options: GeminiOptions = {},
  ) {
    super();
    this.maxOutputTokens = options.maxOutputTokens ?? 2_048;
  }

  async complete(request: LlmRequest): Promise<LlmTurn> {
    let response;
    try {
      response = await this.models.generateContent({
        model: this.model,
        contents: request.messages.map(toContent),
        config: {
          systemInstruction: request.system,
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.parameters,
              })),
            },
          ],
          maxOutputTokens: this.maxOutputTokens,
          // Answers come from the tools; low thinking saves quota and time.
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          abortSignal: request.signal,
        },
      });
    } catch (error) {
      throw translate(error, request.signal);
    }

    const content: Content = response.candidates?.[0]?.content ?? {
      role: 'model',
      parts: [],
    };
    const parts = content.parts ?? [];
    const toolCalls = parts.flatMap((part): ToolCall[] => {
      const call = part.functionCall;
      if (call === undefined) return [];
      return [
        {
          ...(call.id === undefined ? {} : { id: call.id }),
          name: call.name ?? '',
          args: call.args ?? {},
        },
      ];
    });
    const text = parts
      .filter((part) => typeof part.text === 'string' && part.thought !== true)
      .map((part) => part.text)
      .join('');
    const usage = response.usageMetadata;

    return {
      message: { role: 'model', text, toolCalls, providerData: content },
      usage: {
        input: usage?.promptTokenCount ?? 0,
        output:
          (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      },
    };
  }
}

function toContent(message: ConversationMessage): Content {
  switch (message.role) {
    case 'user':
      return { role: 'user', parts: [{ text: message.text }] };
    case 'model':
      if (message.providerData !== undefined) {
        return message.providerData as Content;
      }
      return {
        role: 'model',
        parts: [
          ...(message.text === '' ? [] : [{ text: message.text }]),
          ...message.toolCalls.map((call): Part => ({
            functionCall: {
              ...(call.id === undefined ? {} : { id: call.id }),
              name: call.name,
              args: call.args,
            },
          })),
        ],
      };
    case 'tool':
      return {
        role: 'user',
        parts: message.results.map((result): Part => ({
          functionResponse: {
            ...(result.callId === undefined ? {} : { id: result.callId }),
            name: result.name,
            response: result.output,
          },
        })),
      };
  }
}

/** Messages name the failure but never echo the request (or the key). */
function translate(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) {
    return new LlmUnavailableError('the model did not answer in time', {
      cause: error,
    });
  }
  if (error instanceof ApiError) {
    return error.status === QUOTA_EXCEEDED
      ? new LlmQuotaExceededError('the model quota is exhausted', {
          cause: error,
        })
      : new LlmUnavailableError(`the model API answered ${error.status}`, {
          cause: error,
        });
  }
  return new LlmUnavailableError('could not reach the model API', {
    cause: error,
  });
}
