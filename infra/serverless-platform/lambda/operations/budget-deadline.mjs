export const budgetAbort = () => Object.assign(new Error("Budget operation deadline exceeded."), { name: "AbortError" });

// Race as well as signal: an injected dependency may never settle on abort.
// The callback must pass the signal to every subsequent side effect.
export async function withBudgetDeadline(operation, { abortSignal, timeoutMs = 2_000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new TypeError("Invalid budget deadline.");
  abortSignal?.throwIfAborted();
  const controller = new AbortController();
  let timer;
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => { controller.abort(budgetAbort()); reject(budgetAbort()); };
    abortSignal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }), stopped]);
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", abort);
  }
}

export function boundedBudgetDynamo(dynamo, abortSignal) {
  return { send(command, options = {}) {
    return withBudgetDeadline(signal => dynamo.send(command, { ...options, abortSignal: signal }),
      { abortSignal: abortSignal && options.abortSignal
        ? AbortSignal.any([abortSignal, options.abortSignal]) : abortSignal ?? options.abortSignal });
  } };
}
