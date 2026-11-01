import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const askRequestSchema = z.object({
  question: z.string().trim().min(1).max(500),
});

export type AskRequest = z.infer<typeof askRequestSchema>;

/** 400 with the problems, in the `{ message }` shape of the other errors. */
export function parseAskRequest(body: unknown): AskRequest {
  const result = askRequestSchema.safeParse(body);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException({ message: `invalid request: ${problems}` });
  }
  return result.data;
}
