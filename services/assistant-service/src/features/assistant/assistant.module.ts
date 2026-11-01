import { GoogleGenAI } from '@google/genai';
import { Module } from '@nestjs/common';
import { RedisConnection } from '../../core/cache/redis.connection.js';
import { ENV, type Env } from '../../core/config/env.js';
import { OrderHistoryModule } from '../order-history/order-history.module.js';
import { LlmClient } from './application/contracts/llm-client.js';
import { OrderQueries } from './application/contracts/order-queries.js';
import { RateLimiter } from './application/contracts/rate-limiter.js';
import { buildOrderTools } from './application/tools/order-tools.js';
import { AskAssistant } from './application/usecases/ask-assistant.js';
import { FakeLlmClient } from './infrastructure/fake-llm.client.js';
import { GeminiLlmClient } from './infrastructure/gemini-llm.client.js';
import { ReadModelOrderQueries } from './infrastructure/read-model-order-queries.js';
import { RedisRateLimiter } from './infrastructure/redis-rate-limiter.js';
import { AskRateLimitGuard } from './presentation/http/ask-rate-limit.guard.js';
import { AssistantController } from './presentation/http/assistant.controller.js';

/** LLM_PROVIDER picks the model; `fake` needs no key (ADR-0022). */
function createLlmClient(env: Env): LlmClient {
  if (env.LLM_PROVIDER === 'gemini') {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    return new GeminiLlmClient(ai.models, env.LLM_MODEL);
  }
  return new FakeLlmClient();
}

/** DI wiring of the feature (the `di/` package of the Python services). */
@Module({
  imports: [OrderHistoryModule],
  controllers: [AssistantController],
  providers: [
    { provide: LlmClient, useFactory: createLlmClient, inject: [ENV] },
    { provide: OrderQueries, useClass: ReadModelOrderQueries },
    {
      provide: AskAssistant,
      useFactory: (llm: LlmClient, queries: OrderQueries) =>
        new AskAssistant(llm, buildOrderTools(queries)),
      inject: [LlmClient, OrderQueries],
    },
    {
      provide: RateLimiter,
      useFactory: (redis: RedisConnection, env: Env) =>
        new RedisRateLimiter(redis, {
          limit: env.ASK_RATE_LIMIT_PER_MINUTE,
          windowSeconds: 60,
        }),
      inject: [RedisConnection, ENV],
    },
    AskRateLimitGuard,
  ],
})
export class AssistantModule {}
