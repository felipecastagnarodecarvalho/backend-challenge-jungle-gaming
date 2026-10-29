/**
 * Base class for every business-rule violation raised by the domain.
 * `code` is a stable, machine-readable identifier that outer layers map to
 * API error codes; it must never depend on the message text.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
