import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ValidationError } from '../../application/errors';

/** Validates/normalises a request part with zod; issues become a 400 VALIDATION_ERROR with paths. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      );
    }
    return parsed.data;
  }
}

export function parseOrThrow<T>(schema: ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({
        path: [path, ...i.path.map(String)].filter(Boolean).join('.'),
        message: i.message,
      })),
    );
  }
  return parsed.data;
}
