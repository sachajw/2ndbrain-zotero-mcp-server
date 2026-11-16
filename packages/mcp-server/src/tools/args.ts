/**
 * Tool argument validation.
 *
 * The MCP SDK does not check arguments against a tool's inputSchema, so a
 * value declared as a number can arrive as any JSON value. Many tools build
 * JavaScript source from their arguments and run it in Zotero's privileged
 * chrome context, so every argument that reaches that source is checked here
 * (numbers) or embedded with JSON.stringify (strings).
 */

type Args = Record<string, unknown>;

interface NumberOptions {
  integer?: boolean;
  min?: number;
  max?: number;
}

function checkNumber(name: string, value: unknown, opts: NumberOptions): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: expected a number, got ${JSON.stringify(value)}`);
  }
  if (opts.integer && !Number.isInteger(value)) {
    throw new Error(`Invalid ${name}: expected an integer, got ${value}`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`Invalid ${name}: must be at least ${opts.min}, got ${value}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`Invalid ${name}: must be at most ${opts.max}, got ${value}`);
  }
  return value;
}

/** A number argument, or `fallback` when it is absent (undefined or null). */
export function numberArg(
  args: Args,
  name: string,
  fallback: number,
  opts: NumberOptions = {}
): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  return checkNumber(name, value, opts);
}

/** An optional number argument: undefined when absent. */
export function optionalNumberArg(
  args: Args,
  name: string,
  opts: NumberOptions = {}
): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  return checkNumber(name, value, opts);
}

/** A string argument restricted to `allowed`, or `fallback` when absent. */
export function enumArg<T extends string>(
  args: Args,
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = args[name];
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid ${name}: expected one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`
    );
  }
  return value as T;
}

/** A JavaScript string literal for `value`, safe to splice into evaluated code. */
export function jsString(value: string): string {
  return JSON.stringify(value);
}
