import { describe, it, expect } from "vitest";
import { parseSeverity, isSignificant } from "./severity";

describe("parseSeverity — exact importance dictionary", () => {
  it("maps the Russian importance tags", () => {
    expect(parseSeverity("[Критично] fix now")).toBe("critical");
    expect(parseSeverity("[Существенно] tighten")).toBe("major");
    expect(parseSeverity("[Незначительно] nit")).toBe("minor");
  });

  it("maps the English equivalents and is case-insensitive", () => {
    expect(parseSeverity("[Critical] x")).toBe("critical");
    expect(parseSeverity("[MAJOR] x")).toBe("major");
    expect(parseSeverity("[minor] x")).toBe("minor");
    expect(parseSeverity("[критично] x")).toBe("critical");
  });

  it("treats fact-checker verdicts as unknown, NOT a severity", () => {
    expect(parseSeverity("[Неверно] this is wrong")).toBe("unknown");
    expect(parseSeverity("[Не проверено] can't verify")).toBe("unknown");
    expect(parseSeverity("[Непроверяемо] x")).toBe("unknown");
    expect(parseSeverity("[Это мнение] x")).toBe("unknown");
  });

  it("treats a typo'd / unrecognised tag as unknown (never falls back to minor)", () => {
    expect(parseSeverity("[Существенное] typo ending")).toBe("unknown");
    expect(parseSeverity("[whatever] x")).toBe("unknown");
  });

  it("returns unknown for no tag or empty input", () => {
    expect(parseSeverity("plain body, no tag")).toBe("unknown");
    expect(parseSeverity("")).toBe("unknown");
  });

  it("finds the recognised importance tag even after a leading verdict tag", () => {
    expect(parseSeverity("[Неверно] [Существенно] body")).toBe("major");
  });
});

describe("isSignificant", () => {
  it("counts only major and critical", () => {
    expect(isSignificant("critical")).toBe(true);
    expect(isSignificant("major")).toBe(true);
    expect(isSignificant("minor")).toBe(false);
    expect(isSignificant("unknown")).toBe(false);
  });
});
