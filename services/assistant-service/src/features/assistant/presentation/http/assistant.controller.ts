import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ASSISTANT_LLM_TOKENS,
  ASSISTANT_QUESTIONS,
  ASSISTANT_TOOL_CALLS,
} from '../../../../core/observability/metrics.js';
import { TOOL_NAMES } from '../../application/tools/order-tools.js';
import {
  type AskAssistantResult,
  AskAssistant,
} from '../../application/usecases/ask-assistant.js';
import { AskRateLimitGuard } from './ask-rate-limit.guard.js';
import { parseAskRequest } from './ask.request.js';
import { type AskResponse, toAskResponse } from './ask.response.js';
import { toHttpError } from './assistant.errors.js';

@Controller('v1/assistant')
export class AssistantController {
  private readonly logger = new Logger(AssistantController.name);

  constructor(
    @Inject(AskAssistant) private readonly askAssistant: AskAssistant,
  ) {}

  /** A question about the orders, answered by the agent over the read model. */
  @Post('ask')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AskRateLimitGuard)
  async ask(@Body() body: unknown): Promise<AskResponse> {
    const { question } = parseAskRequest(body);
    let result: AskAssistantResult;
    try {
      result = await this.askAssistant.execute(question);
    } catch (error) {
      ASSISTANT_QUESTIONS.inc({ outcome: 'error' });
      if (error instanceof Error) {
        this.logger.warn(`question failed: ${error.name}: ${error.message}`);
      }
      throw toHttpError(error);
    }
    record(result);
    return toAskResponse(result);
  }
}

function record(result: AskAssistantResult): void {
  ASSISTANT_QUESTIONS.inc({ outcome: result.outcome });
  for (const call of result.toolCalls) {
    ASSISTANT_TOOL_CALLS.inc({
      tool: TOOL_NAMES.has(call.name) ? call.name : 'unknown',
    });
  }
  ASSISTANT_LLM_TOKENS.inc({ direction: 'input' }, result.usage.input);
  ASSISTANT_LLM_TOKENS.inc({ direction: 'output' }, result.usage.output);
}
