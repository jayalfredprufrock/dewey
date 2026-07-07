import { describe, expect, it } from "vitest";
import { buildQuery, buildSearchBody, resolveId, resolveVersion } from "../src/build";

describe("resolveId", () => {
  it("returns undefined with no strategy", () => {
    expect(resolveId(undefined, { a: 1 })).toBeUndefined();
  });
  it("resolves a single field to a string", () => {
    expect(resolveId("userId", { userId: 42 })).toBe("42");
  });
  it("joins composite fields", () => {
    expect(resolveId<{ a: string; b: string }>(["a", "b"], { a: "x", b: "y" })).toBe("x#y");
  });
  it("returns undefined when a composite part is missing", () => {
    expect(
      resolveId<{ a: string; b: string }>(["a", "b"], { a: "x" } as { a: string; b: string }),
    ).toBeUndefined();
  });
  it("supports a function strategy", () => {
    expect(resolveId((d: { a: string }) => `id-${d.a}`, { a: "z" })).toBe("id-z");
  });
});

describe("resolveVersion", () => {
  it("reads a numeric field", () => {
    expect(resolveVersion("v", { v: 7 })).toBe(7);
  });
  it("supports a function strategy", () => {
    expect(resolveVersion((d: { updatedAt: number }) => d.updatedAt, { updatedAt: 123 })).toBe(123);
  });
  it("returns undefined without a strategy", () => {
    expect(resolveVersion(undefined, { v: 1 })).toBeUndefined();
  });
});

describe("buildQuery", () => {
  it("returns match_all for an empty query", () => {
    expect(buildQuery(undefined)).toEqual({ match_all: {} });
    expect(buildQuery({})).toEqual({ match_all: {} });
  });
  it("wraps a converted query in filter context by default", () => {
    const q = buildQuery({ role: "admin" });
    expect(q).toHaveProperty("bool.filter");
  });
  it("returns the raw DSL when filterContext is false", () => {
    const q = buildQuery({ role: "admin" }, false);
    expect(q).not.toHaveProperty("bool.filter");
  });
  it("converts operators", () => {
    const q = buildQuery({ age: { $gte: 18 } }, false) as any;
    expect(JSON.stringify(q)).toContain("range");
  });
});

describe("buildSearchBody", () => {
  it("maps read options to ES body fields", () => {
    const body = buildSearchBody(
      { role: "admin" },
      {
        size: 10,
        from: 5,
        sort: [{ createdAt: "desc" }],
        trackTotalHits: true,
        source: ["role"],
      },
    );
    expect(body).toMatchObject({
      size: 10,
      from: 5,
      sort: [{ createdAt: "desc" }],
      track_total_hits: true,
      _source: ["role"],
    });
    expect(body.query).toHaveProperty("bool.filter");
  });
});
