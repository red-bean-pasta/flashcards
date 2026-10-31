export class DeckRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeckRequestError';
  }
}

/** A detected local write conflict can be replanned later. */
export class RetryableLocalConflict extends DeckRequestError {}
