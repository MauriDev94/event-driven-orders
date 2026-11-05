import { GoogleGenAI } from '@google/genai';
import type { LlmClient } from '../src/features/assistant/application/contracts/llm-client.js';
import { FakeLlmClient } from '../src/features/assistant/infrastructure/fake-llm.client.js';
import { GeminiLlmClient } from '../src/features/assistant/infrastructure/gemini-llm.client.js';
import { formatReport, runEval } from './runner.js';

// 15 requests per minute on the free plan; 4.5 s apart leaves some margin.
const GEMINI_MIN_INTERVAL_MS = 4_500;
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/**
 * `npm run eval` (fake model) or `npm run eval:gemini`. The npm script loads
 * the repo's root `.env`, so GEMINI_API_KEY and LLM_MODEL come from there and
 * the key is never printed or passed on the command line.
 */
function buildLlm(provider: string): { llm: LlmClient; minIntervalMs: number } {
  if (provider === 'fake')
    return { llm: new FakeLlmClient(), minIntervalMs: 0 };
  if (provider !== 'gemini')
    throw new Error(`unknown provider ${provider}, use fake or gemini`);
  const apiKey = process.env['GEMINI_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw new Error(
      'GEMINI_API_KEY is empty: paste a Google AI Studio key into the root .env',
    );
  }
  const model = process.env['LLM_MODEL'] || DEFAULT_MODEL;
  const ai = new GoogleGenAI({ apiKey });
  return {
    llm: new GeminiLlmClient(ai.models, model),
    minIntervalMs: GEMINI_MIN_INTERVAL_MS,
  };
}

const flag = process.argv.indexOf('--provider');
const provider = flag === -1 ? 'fake' : (process.argv[flag + 1] ?? 'fake');
const maxCalls = Number(process.env['EVAL_MAX_MODEL_CALLS'] ?? 100);

const { llm, minIntervalMs } = buildLlm(provider);
const report = await runEval({ llm, minIntervalMs, maxModelCalls: maxCalls });
console.log(formatReport(report));
process.exitCode = report.stoppedEarly === undefined ? 0 : 1;
