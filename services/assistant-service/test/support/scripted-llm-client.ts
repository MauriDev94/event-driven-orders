import {
  LlmClient,
  type LlmRequest,
  type LlmTurn,
  type ToolCall,
} from '../../src/features/assistant/application/contracts/llm-client.js';

type Step = LlmTurn | ((request: LlmRequest) => Promise<LlmTurn>);

/**
 * Plays a fixed script, one step per turn, and keeps a copy of every request
 * (the conversation grows in place, so it is copied when received).
 */
export class ScriptedLlmClient extends LlmClient {
  readonly model = 'scripted';
  readonly requests: LlmRequest[] = [];

  constructor(private readonly steps: Step[]) {
    super();
  }

  async complete(request: LlmRequest): Promise<LlmTurn> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.steps[this.requests.length - 1];
    if (step === undefined) throw new Error('the script has no more turns');
    return typeof step === 'function' ? step(request) : step;
  }
}

export function callTools(
  calls: ToolCall[],
  usage = { input: 10, output: 5 },
): LlmTurn {
  return {
    message: {
      role: 'model',
      text: '',
      toolCalls: calls,
      providerData: { raw: 'turn' },
    },
    usage,
  };
}

export function answer(
  text: string,
  usage = { input: 20, output: 8 },
): LlmTurn {
  return { message: { role: 'model', text, toolCalls: [] }, usage };
}
