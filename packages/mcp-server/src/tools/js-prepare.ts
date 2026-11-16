/**
 * Prepare zotero_execute_js code for Firefox's evaluateJSAsync.
 *
 * The console actor evaluates the text as a script. It does not support
 * top-level `await` or `return` on its own: the DevTools frontend rewrites
 * such code before sending it, and `mapped: { await: true }` only tells the
 * server that this rewrite already happened. So this module does the rewrite.
 *
 * The code is parsed with acorn (not scanned for braces), so `return` inside
 * a `try`/`if` block and `await` anywhere outside a nested function are both
 * found exactly.
 */

import { parse } from "acorn";

export interface PreparedCode {
  /** The text to send to evaluateJSAsync. */
  code: string;
  /**
   * Global property the wrapper stores a rejection reason in, or null when
   * the code is sent unwrapped. Firefox reports a rejected evaluation only as
   * `topLevelAwaitRejected: true`, without the reason, so the wrapper keeps
   * it for a follow-up read.
   */
  rejectionKey: string | null;
  /** False when acorn could not parse the code (it is then sent as-is). */
  parsed: boolean;
}

interface TopLevelScan {
  hasAwait: boolean;
  hasReturn: boolean;
}

/** Node types that open their own function scope. */
const FUNCTION_NODES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const POSITION_KEYS = new Set(["type", "start", "end", "loc", "range"]);

/** Find `await`/`return` that belong to the top level, not a nested function. */
function scanTopLevel(node: unknown, scan: TopLevelScan): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) scanTopLevel(child, scan);
    return;
  }
  const n = node as Record<string, unknown>;
  if (typeof n.type !== "string") return;
  if (FUNCTION_NODES.has(n.type)) return;

  if (n.type === "AwaitExpression") scan.hasAwait = true;
  if (n.type === "ForOfStatement" && n.await === true) scan.hasAwait = true;
  if (n.type === "ReturnStatement") scan.hasReturn = true;

  for (const key of Object.keys(n)) {
    if (!POSITION_KEYS.has(key)) scanTopLevel(n[key], scan);
  }
}

/**
 * Wrap a function body in an async IIFE whose rejection reason is kept in
 * `globalThis[rejectionKey]`. `.catch` (not try/catch inside the body) also
 * catches a rejected promise the body returns.
 */
export function wrapBody(body: string, rejectionKey: string): string {
  const key = JSON.stringify(rejectionKey);
  return (
    `(async () => {\n${body}\n})()` +
    `.catch((e) => { globalThis[${key}] = e; throw e; })`
  );
}

/**
 * Turn user code into something evaluateJSAsync accepts.
 *
 * - No top-level `await` or `return`: sent unchanged, so the console's own
 *   completion value is the result and top-level `var`s persist between calls.
 * - Otherwise: wrapped in an async IIFE. Without a top-level `return`, a final
 *   expression statement becomes the return value, matching the console.
 */
export function prepareCode(code: string, rejectionKey: string): PreparedCode {
  let program: ReturnType<typeof parse>;
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    return { code, rejectionKey: null, parsed: false };
  }

  const scan: TopLevelScan = { hasAwait: false, hasReturn: false };
  scanTopLevel(program.body, scan);
  if (!scan.hasAwait && !scan.hasReturn) {
    return { code, rejectionKey: null, parsed: true };
  }

  let body = code;
  const last = program.body[program.body.length - 1];
  if (!scan.hasReturn && last?.type === "ExpressionStatement") {
    const expr = last.expression;
    body =
      code.slice(0, last.start) +
      `return (${code.slice(expr.start, expr.end)});` +
      code.slice(last.end);
  }

  return { code: wrapBody(body, rejectionKey), rejectionKey, parsed: true };
}

/**
 * Read-and-delete expression for a stored rejection reason. It evaluates to
 * a JSON string `{name, message, stack}`, or null when nothing was stored.
 */
export function rejectionReadCode(rejectionKey: string): string {
  const key = JSON.stringify(rejectionKey);
  return `(() => {
  const k = ${key};
  if (!Object.prototype.hasOwnProperty.call(globalThis, k)) return null;
  const e = globalThis[k];
  delete globalThis[k];
  const str = (v) => { try { return String(v); } catch { return Object.prototype.toString.call(v); } };
  const isErr = e !== null && typeof e === "object" && "message" in e;
  return JSON.stringify({
    name: isErr && e.name ? str(e.name) : null,
    message: isErr ? str(e.message) : str(e),
    stack: isErr && e.stack ? str(e.stack) : null,
  });
})()`;
}
