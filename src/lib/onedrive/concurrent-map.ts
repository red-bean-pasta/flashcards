/** Recognize only cancellation caused by this operation, including transport wrappers. */
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError')) return true;
  return error instanceof Error && error.cause !== undefined && error.cause !== error && isCancellation(error.cause, signal);
}

/** Ordered results with bounded work; failure aborts siblings and drains them before returning. */
export async function mapConcurrent<T, R>(items: readonly T[], run: (item: T, signal: AbortSignal) => Promise<R>, signal?: AbortSignal, concurrency = 6): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('Concurrency must be a positive integer.');
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const independentFailures: unknown[] = [];

  async function worker(): Promise<void> {
    while (!combined.aborted && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await run(items[index], combined); }
      catch (error) {
        if (!failed) { failed = true; failure = error; controller.abort(error); }
        else if (!isCancellation(error, combined)) independentFailures.push(error);
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (independentFailures.length) throw new AggregateError([failure, ...independentFailures], 'Multiple OneDrive workers failed.');
  if (failed) throw failure;
  combined.throwIfAborted();
  return results;
}
