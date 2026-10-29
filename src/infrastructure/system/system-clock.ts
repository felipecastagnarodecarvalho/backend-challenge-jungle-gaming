import type { Clock } from '../../application/ports/system';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
