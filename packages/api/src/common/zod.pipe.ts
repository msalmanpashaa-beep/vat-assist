import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { DomainError } from './errors';

export class ZodBody<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new DomainError(
        'validation_failed',
        'Some fields are missing or invalid.',
        400,
        r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return r.data;
  }
}
