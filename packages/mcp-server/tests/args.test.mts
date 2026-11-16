/**
 * Tool arguments that are spliced into evaluated JavaScript.
 *
 * The MCP SDK does not enforce a tool's inputSchema, so `args.limit as number`
 * used to let a string such as "1); evil(); (" into code that runs in Zotero's
 * chrome context. The pref tools escaped values by replacing `"` only, so a
 * value containing `\"` closed the string literal and ran what followed.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { enumArg, jsString, numberArg, optionalNumberArg } from "../src/tools/args.js";
import { getPrefCode, setPrefCode } from "../src/tools/execute.js";

describe("numberArg / optionalNumberArg", () => {
  it("returns the fallback when absent, the value when valid", () => {
    expect(numberArg({}, "limit", 10)).toBe(10);
    expect(numberArg({ limit: null }, "limit", 10)).toBe(10);
    expect(numberArg({ limit: 3 }, "limit", 10, { integer: true, min: 1 })).toBe(3);
    expect(optionalNumberArg({}, "windowId")).toBeUndefined();
    expect(optionalNumberArg({ windowId: 33 }, "windowId", { integer: true })).toBe(33);
  });

  it("rejects strings, non-integers and out-of-range values", () => {
    expect(() => numberArg({ limit: "1); evil(); (" }, "limit", 10)).toThrow(/Invalid limit: expected a number/);
    expect(() => numberArg({ limit: Number.NaN }, "limit", 10)).toThrow(/expected a number/);
    expect(() => numberArg({ index: 1.5 }, "index", 0, { integer: true })).toThrow(/expected an integer/);
    expect(() => numberArg({ limit: 0 }, "limit", 10, { min: 1 })).toThrow(/at least 1/);
    expect(() => numberArg({ depth: 9 }, "depth", 2, { max: 5 })).toThrow(/at most 5/);
    expect(() => optionalNumberArg({ windowId: "3 || evil()" }, "windowId")).toThrow(/Invalid windowId/);
  });
});

describe("enumArg", () => {
  const levels = ["all", "error", "warning", "info"] as const;

  it("accepts allowed values and falls back when absent", () => {
    expect(enumArg({}, "level", levels, "all")).toBe("all");
    expect(enumArg({ level: "" }, "level", levels, "all")).toBe("all");
    expect(enumArg({ level: "error" }, "level", levels, "all")).toBe("error");
  });

  it("rejects anything else", () => {
    expect(() => enumArg({ level: "error'].test(x)||evil()||x['" }, "level", levels, "all")).toThrow(
      /Invalid level: expected one of all, error, warning, info/
    );
    expect(() => enumArg({ level: 1 }, "level", levels, "all")).toThrow(/Invalid level/);
  });
});

describe("jsString", () => {
  it("produces a literal that evaluates back to the same string", () => {
    for (const s of ['a"b', "a\\\"; evil(); //", "line\nbreak", " ", "</script>"]) {
      expect(vm.runInNewContext(jsString(s))).toBe(s);
    }
  });
});

/** Stubs for the pref APIs that record what they were called with. */
function prefContext() {
  const calls: unknown[][] = [];
  const store = new Map<string, unknown>([["general.str", "s"], ["general.int", 4]]);
  const context = vm.createContext({
    evil: () => calls.push(["EVIL"]),
    Zotero: {
      Prefs: {
        get: (k: string) => (calls.push(["Zotero.get", k]), `z:${k}`),
        set: (k: string, v: unknown) => calls.push(["Zotero.set", k, v]),
      },
    },
    Services: {
      prefs: {
        PREF_STRING: 32,
        PREF_INT: 64,
        PREF_BOOL: 128,
        getPrefType: (k: string) =>
          typeof store.get(k) === "string" ? 32 : typeof store.get(k) === "number" ? 64 : 0,
        getStringPref: (k: string) => store.get(k),
        getIntPref: (k: string) => store.get(k),
        getBoolPref: (k: string) => store.get(k),
        setStringPref: (k: string, v: unknown) => calls.push(["setStringPref", k, v]),
        setIntPref: (k: string, v: unknown) => calls.push(["setIntPref", k, v]),
        setBoolPref: (k: string, v: unknown) => calls.push(["setBoolPref", k, v]),
      },
    },
  });
  return { calls, context };
}

describe("pref code builders", () => {
  // Under the old quote-only escape this closed the literal and ran evil().
  const attack = 'x\\"); evil(); //';

  it("stores a value containing an escaped quote as data, without running it", () => {
    const { calls, context } = prefContext();
    vm.runInContext(setPrefCode("general.str", attack), context);
    vm.runInContext(setPrefCode("extensions.zotero.debug.store", attack), context);
    expect(calls).toEqual([
      ["setStringPref", "general.str", attack],
      ["Zotero.set", "debug.store", attack],
    ]);
    expect(calls.some((c) => c[0] === "EVIL")).toBe(false);
  });

  it("treats a key containing quotes as data", () => {
    const { calls, context } = prefContext();
    const key = 'extensions.zotero.a"); evil(); ("';
    expect(vm.runInContext(getPrefCode(key), context)).toBe('z:a"); evil(); ("');
    vm.runInContext(getPrefCode('general."); evil(); ("'), context);
    vm.runInContext(setPrefCode('general."); evil(); ("', true), context);
    expect(calls.some((c) => c[0] === "EVIL")).toBe(false);
  });

  it("picks the setter from the value type and reads by pref type", () => {
    const { calls, context } = prefContext();
    vm.runInContext(setPrefCode("general.n", 5), context);
    vm.runInContext(setPrefCode("general.b", false), context);
    expect(calls).toEqual([
      ["setIntPref", "general.n", 5],
      ["setBoolPref", "general.b", false],
    ]);
    expect(vm.runInContext(getPrefCode("general.int"), context)).toBe(4);
    expect(vm.runInContext(getPrefCode("general.missing"), context)).toBeNull();
  });

  it("rejects values that are not string, number or boolean", () => {
    expect(() => setPrefCode("general.x", { a: 1 })).toThrow(/Unsupported preference value type: object/);
    expect(() => setPrefCode("extensions.zotero.x", null)).toThrow(/Unsupported preference value type: null/);
  });
});
