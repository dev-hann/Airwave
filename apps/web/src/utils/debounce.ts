/**
 * Returns a debounced function that delays invocation until after `ms` milliseconds
 * have elapsed since the last call.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}
