/**
 * Regression tests for zotero_execute_js code preparation.
 *
 * Three defects, each reproduced against Zotero 10 (Firefox 140) over RDP:
 *
 * 1. `try { const x = await p; return x; } catch {}` failed with
 *    "await is only valid in async functions": the brace-counting heuristic
 *    saw no depth-0 `return`, so it didn't wrap, and the retry only matched
 *    "return not in function".
 * 2. A bare top-level `await` failed the same way. `mapped: { await: true }`
 *    does nothing unless the client has already rewritten the code.
 * 3. A rejected promise came back as `topLevelAwaitRejected: true` with no
 *    exception, which the tool printed as "Result: undefined".
 *
 * The unit cases run the prepared code in a Node `vm` context behind a fake
 * client that returns the reply shapes Firefox sends (a value, an exception,
 * or `topLevelAwaitRejected`). The live cases skip unless a Zotero with the
 * bridge answers on ZOTERO_RDP_PORT (default 6100).
 */
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeJsWithClient, type ExecuteJsClient } from "../src/tools/execute.js";
import { prepareCode } from "../src/tools/js-prepare.js";
import { createClient, type RDPClient } from "../src/rdp/index.js";
import type { EvaluateJSResponse, GripValue } from "../src/rdp/index.js";

const RDP_PORT = Number(process.env.ZOTERO_RDP_PORT ?? "6100");

interface VmClient extends ExecuteJsClient {
  calls: string[];
  context: vm.Context;
}

/** Evaluates like the console actor: awaits a returned promise, reports a rejection without its reason. */
function vmClient(): VmClient {
  const context = vm.createContext({});
  const calls: string[] = [];
  return {
    calls,
    context,
    async evaluateJS(code: string): Promise<EvaluateJSResponse> {
      calls.push(code);
      let value: unknown;
      try {
        value = vm.runInContext(code, context);
      } catch (e) {
        const err = e as Error;
        return {
          from: "fake",
          hasException: true,
          exception: { type: "object", class: err.name } as unknown as GripValue,
          exceptionMessage: `${err.name}: ${err.message}`,
        };
      }
      if (value !== null && typeof (value as Promise<unknown>)?.then === "function") {
        try {
          value = await value;
        } catch {
          return { from: "fake", hasException: false, topLevelAwaitRejected: true };
        }
      }
      return { from: "fake", result: value as GripValue };
    },
    async gripToValueAsync(grip: GripValue) {
      return grip;
    },
  };
}

async function run(client: ExecuteJsClient, code: string): Promise<string> {
  const content = await executeJsWithClient(client, { code });
  expect(content).toHaveLength(1);
  return content[0].text;
}

function strayRejectionKeys(context: vm.Context): string[] {
  return Object.keys(context).filter((k) => k.startsWith("__zoteroMcpRejection_"));
}

describe("prepareCode", () => {
  it("leaves code without top-level await/return unchanged", () => {
    for (const code of [
      "Zotero.version",
      "var n = 1; n + 1",
      'const s = "return await"; s',
      "const f = async () => { return await 1; }; f()",
      "class A { async m() { return await 1; } } new A()",
    ]) {
      expect(prepareCode(code, "k")).toEqual({ code, rejectionKey: null, parsed: true });
    }
  });

  it("wraps a return nested in try/if, and await in a for-await loop", () => {
    for (const code of [
      "try { return 1; } catch (e) {}",
      "if (true) { return 1 }",
      "for await (const x of []) {}",
    ]) {
      const prepared = prepareCode(code, "k");
      expect(prepared.rejectionKey).toBe("k");
      expect(prepared.code).toMatch(/^\(async \(\) => \{/);
    }
  });

  it("sends unparseable code as-is", () => {
    expect(prepareCode("return 1 +", "k")).toEqual({
      code: "return 1 +",
      rejectionKey: null,
      parsed: false,
    });
  });
});

describe("zotero_execute_js (unit, vm-backed fake client)", () => {
  it("returns from a try block that awaits (defect 1)", async () => {
    const client = vmClient();
    const text = await run(
      client,
      "try { const x = await Promise.resolve(5); return x; } catch (e) { return -1; }"
    );
    expect(text).toBe("Result:\n5");
  });

  it("supports a bare top-level await (defect 2)", async () => {
    expect(await run(vmClient(), "await Promise.resolve(7)")).toBe("Result:\n7");
  });

  it("returns the last expression after awaiting, like the console", async () => {
    expect(await run(vmClient(), "const a = await Promise.resolve(2);\na * 3 // six")).toBe(
      "Result:\n6"
    );
  });

  it("reports a thrown error after await instead of 'undefined' (defect 3)", async () => {
    const client = vmClient();
    const text = await run(client, 'await 1; throw new RangeError("boom")');
    expect(text).toMatch(/^Error executing JavaScript \(promise rejected\):\n\nRangeError: boom/);
    expect(text).toContain("Stack trace:");
    expect(text).not.toContain("undefined");
    expect(strayRejectionKeys(client.context)).toEqual([]);
  });

  it("reports a returned rejected promise with its reason", async () => {
    const text = await run(vmClient(), 'return Promise.reject(new TypeError("bad"))');
    expect(text).toContain("TypeError: bad");
  });

  it("reports a rejected non-Error value", async () => {
    const text = await run(vmClient(), 'await Promise.reject("plain string")');
    expect(text).toMatch(/\n\nplain string$/);
  });

  it("flags an unwrapped rejection even though Zotero sends no reason", async () => {
    const client = vmClient();
    const text = await run(client, 'Promise.reject(new Error("x"))');
    expect(text).toMatch(/^Error executing JavaScript \(promise rejected\)/);
    expect(text).toContain("add `return` or `await`");
    expect(client.calls).toHaveLength(1);
  });

  it("keeps top-level var declarations across calls for unwrapped code", async () => {
    const client = vmClient();
    await run(client, "var counter = 41");
    expect(await run(client, "counter + 1")).toBe("Result:\n42");
  });

  it("reports a synchronous exception unchanged", async () => {
    const text = await run(vmClient(), "null.x");
    expect(text).toMatch(/^Error executing JavaScript:\n\nTypeError/);
  });
});

describe("zotero_execute_js (unit, scripted replies)", () => {
  it("retries wrapped only after a compile-time top-level return/await error", async () => {
    const calls: string[] = [];
    const replies: EvaluateJSResponse[] = [
      {
        from: "fake",
        hasException: true,
        errorMessageName: "JSMSG_BAD_RETURN_OR_YIELD",
        exceptionMessage: "SyntaxError: return not in function",
      },
      { from: "fake", result: 1 as GripValue },
    ];
    const client: ExecuteJsClient = {
      async evaluateJS(code: string) {
        calls.push(code);
        return replies.shift() as EvaluateJSResponse;
      },
      async gripToValueAsync(grip: GripValue) {
        return grip;
      },
    };
    // acorn can't parse it, so it goes raw first; Zotero's compile error
    // proves nothing ran, so the wrapped retry is safe.
    expect(await run(client, "return 1 +")).toBe("Result:\n1");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("return 1 +");
    expect(calls[1]).toMatch(/^\(async \(\) => \{\nreturn 1 \+\n\}\)\(\)\.catch/);
  });

  it("does not retry after a runtime error", async () => {
    const calls: string[] = [];
    const client: ExecuteJsClient = {
      async evaluateJS(code: string) {
        calls.push(code);
        return {
          from: "fake",
          hasException: true,
          errorMessageName: "JSMSG_NOT_DEFINED",
          exceptionMessage: "ReferenceError: nope is not defined",
        };
      },
      async gripToValueAsync(grip: GripValue) {
        return grip;
      },
    };
    expect(await run(client, "nope(")).toMatch(/ReferenceError: nope is not defined/);
    expect(calls).toHaveLength(1);
  });
});

/** Readiness: the port must answer AND `Zotero` must resolve in the target. */
async function zoteroReady(): Promise<{ client: RDPClient | null; reason: string }> {
  const client = createClient({ port: RDP_PORT });
  try {
    await client.connect();
    const r = await client.evaluateJS("typeof Zotero");
    const t = r.exception ? "exception" : await client.gripToValueAsync(r.result as GripValue);
    if (t === "function" || t === "object") return { client, reason: "" };
    client.disconnect();
    return { client: null, reason: `typeof Zotero is ${String(t)} on port ${RDP_PORT}` };
  } catch (e) {
    try {
      client.disconnect();
    } catch {
      /* not connected */
    }
    return { client: null, reason: `no bridge on port ${RDP_PORT}: ${(e as Error).message}` };
  }
}

const ready = await zoteroReady();
if (!ready.client) {
  console.warn(`[execute.test] skipping live cases - ${ready.reason}`);
}

describe.skipIf(!ready.client)("zotero_execute_js (live Zotero)", () => {
  let client: RDPClient;
  beforeAll(() => {
    client = ready.client as RDPClient;
  });
  afterAll(() => {
    client.disconnect();
  });

  it("returns from a try block that awaits", async () => {
    const text = await run(
      client,
      "try { const v = await Promise.resolve(Zotero.version); return typeof v; } catch (e) { return 'E'; }"
    );
    expect(text).toBe("Result:\nstring");
  });

  it("supports a bare top-level await", async () => {
    expect(await run(client, "await Promise.resolve(40 + 2)")).toBe("Result:\n42");
  });

  it("reports the reason of a rejection and leaves no global behind", async () => {
    const text = await run(client, 'await 1; throw new RangeError("live-boom")');
    expect(text).toMatch(/^Error executing JavaScript \(promise rejected\):\n\nRangeError: live-boom/);
    const left = await run(
      client,
      'Object.keys(globalThis).filter((k) => k.startsWith("__zoteroMcpRejection_")).length'
    );
    expect(left).toBe("Result:\n0");
  });
});
