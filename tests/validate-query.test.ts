import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Index, makeRepository, Search } from "../src";
import { isDeweyError } from "../src/error";
import type { EsFieldMapping } from "../src/mappings";
import { validateQuery } from "../src/validate-query";

const nested = (properties: Record<string, EsFieldMapping>, opts: object = {}): EsFieldMapping => ({
  type: "nested",
  ...opts,
  properties,
});

const makeProperties = (
  opts: { outer?: object; inner?: object } = {},
): Record<string, EsFieldMapping> => ({
  name: { type: "keyword" },
  meta: {
    type: "object",
    properties: { tags: { type: "object", properties: { key: { type: "keyword" } } } },
  },
  blocks: nested(
    {
      blockId: { type: "keyword" },
      response: nested(
        { statementId: { type: "keyword" }, choiceId: { type: "keyword" } },
        opts.inner,
      ),
    },
    opts.outer,
  ),
});

const expectInvalid = (
  query: unknown,
  properties: Record<string, EsFieldMapping>,
  message: RegExp,
  dynamic?: boolean | "strict" | "runtime",
) => {
  try {
    validateQuery(query, { properties, dynamic });
  } catch (err) {
    expect(isDeweyError(err)).toBe(true);
    if (isDeweyError(err)) {
      expect(err.details.type).toBe("VALIDATION");
      expect(err.message).toMatch(message);
    }
    return;
  }
  throw new Error("expected a DeweyError");
};

const matrix = {
  blocks: {
    $elemMatch: {
      blockId: "M",
      response: { $elemMatch: { statementId: "S1", choiceId: { $nin: ["A"] } } },
    },
  },
};

describe("validateQuery", () => {
  it("allows $elemMatch on nested fields and dot paths through object fields", () => {
    const properties = makeProperties();
    expect(() => validateQuery(matrix, { properties })).not.toThrow();
    expect(() =>
      validateQuery({ "meta.tags.key": "x", name: { $ne: "y" } }, { properties }),
    ).not.toThrow();
  });

  it("rejects dot paths that cross a nested field without include_in_parent", () => {
    const properties = makeProperties();
    expectInvalid({ "blocks.blockId": "M" }, properties, /crosses nested field "blocks"/);
    expectInvalid(
      { $or: [{ name: "x" }, { "blocks.blockId": { $ne: "M" } }] },
      properties,
      /"blocks"/,
    );
    expectInvalid(
      { blocks: { $elemMatch: { "response.choiceId": "A" } } },
      properties,
      /crosses nested field "blocks.response"/,
    );
  });

  it("allows dot paths through nested fields with include_in_parent at every crossed level", () => {
    const properties = makeProperties({
      outer: { include_in_parent: true },
      inner: { include_in_parent: true },
    });
    expect(() => validateQuery({ "blocks.blockId": "M" }, { properties })).not.toThrow();
    expect(() =>
      validateQuery({ "blocks.response.choiceId": { $all: ["A", "B"] } }, { properties }),
    ).not.toThrow();
    expect(() =>
      validateQuery({ blocks: { $elemMatch: { "response.choiceId": "A" } } }, { properties }),
    ).not.toThrow();
  });

  it("checks every crossed nested level", () => {
    const properties = makeProperties({ outer: { include_in_parent: true } });
    expect(() => validateQuery({ "blocks.blockId": "M" }, { properties })).not.toThrow();
    expectInvalid({ "blocks.response.choiceId": "A" }, properties, /"blocks.response"/);
  });

  it("only honors include_in_root for paths starting at the document root", () => {
    const properties = makeProperties({
      outer: { include_in_root: true },
      inner: { include_in_root: true },
    });
    expect(() => validateQuery({ "blocks.response.choiceId": "A" }, { properties })).not.toThrow();
    expectInvalid(
      { blocks: { $elemMatch: { "response.choiceId": "A" } } },
      properties,
      /crosses nested field "blocks.response"/,
    );
  });

  it("rejects $elemMatch on fields that aren't nested", () => {
    expectInvalid(
      { meta: { $elemMatch: { "tags.key": "x" } } },
      makeProperties(),
      /"meta" to be mapped as nested/,
    );
    expectInvalid({ $not: { name: { $elemMatch: { a: 1 } } } }, makeProperties(), /"name"/);
  });

  it("allows unmapped fields when the mapping is dynamic", () => {
    const properties = makeProperties();
    for (const dynamic of [undefined, true, "runtime"] as const) {
      expect(() =>
        validateQuery(
          { "unknown.path": 1, other: { $elemMatch: { a: 1 } } },
          { properties, dynamic },
        ),
      ).not.toThrow();
      expect(() =>
        validateQuery({ blocks: { $elemMatch: { "extra.field": 1 } } }, { properties, dynamic }),
      ).not.toThrow();
    }
  });

  it("rejects unmapped fields when the mapping isn't dynamic", () => {
    const properties = makeProperties();
    for (const dynamic of [false, "strict"] as const) {
      const mappings = { properties, dynamic };
      expectInvalid({ nmae: "x" }, properties, /"nmae" isn't in the index mapping/, dynamic);
      expectInvalid(
        { $or: [{ name: "x" }, { "meta.tag.key": "y" }] },
        properties,
        /"meta.tag.key"/,
        dynamic,
      );
      expectInvalid(
        { blocks: { $elemMatch: { blokId: "M" } } },
        properties,
        /"blocks.blokId" isn't in the index mapping/,
        dynamic,
      );
      expect(() => validateQuery({ name: "x", "meta.tags.key": "y" }, mappings)).not.toThrow();
      // $ids targets document ids, not a mapped field
      expect(() => validateQuery({ _id: { $ids: ["a"] } }, mappings)).not.toThrow();
    }
  });

  it("honors object-level dynamic overrides and multi-fields", () => {
    const properties: Record<string, EsFieldMapping> = {
      bio: { type: "text", fields: { keyword: { type: "keyword" } } },
      extra: { type: "object", dynamic: true, properties: {} },
      strictObj: { type: "object", dynamic: "strict", properties: { a: { type: "keyword" } } },
    };
    expect(() =>
      validateQuery({ "bio.keyword": "x", "extra.anything": 1 }, { properties, dynamic: false }),
    ).not.toThrow();
    expectInvalid({ "strictObj.b": 1 }, properties, /"strictObj.b"/, true);
  });

  describe("repositories", () => {
    const Survey = Type.Object({
      id: Type.String(),
      meta: Type.Object({ key: Type.String() }),
      blocks: Type.Array(
        Type.Object({
          blockId: Type.String(),
          response: Type.Array(Type.Object({ choiceId: Type.String() })),
        }),
      ),
    });

    const makeRepo = (includeInParent?: boolean) => {
      const index = new Index(Survey, {
        name: "surveys",
        id: "id",
        mapping: { policy: { nested: ["blocks", "blocks.response"], includeInParent } },
      });
      // validation happens before any request, so the client is never used
      const Repo = makeRepository(index);
      return new Repo(new Search({} as never));
    };

    it("validate queries against the derived mapping before sending them", async () => {
      await expect(
        makeRepo().query({ meta: { $elemMatch: { key: "x" } } } as never),
      ).rejects.toSatisfy(isDeweyError);
      await expect(makeRepo(false).count({ "blocks.blockId": "M" } as never)).rejects.toSatisfy(
        isDeweyError,
      );
      await expect(
        makeRepo(false).deleteByQuery({ "blocks.response.choiceId": "A" } as never),
      ).rejects.toThrow(/crosses nested field "blocks"/);
      // repositories derive non-dynamic mappings by default, so unknown fields are rejected
      await expect(makeRepo().count({ "meta.kye": "x" } as never)).rejects.toThrow(
        /"meta.kye" isn't in the index mapping/,
      );
    });
  });
});
