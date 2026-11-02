import { Client } from "@opensearch-project/opensearch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { deriveMappings } from "../src/mappings";
import { convertQuery, makeFilter } from "../src/query";
import { validateQuery } from "../src/validate-query";

// Opt-in: only runs when DEWEY_OS_URL points at a reachable OpenSearch cluster.
// Every query is run both in-memory (makeFilter) and against OpenSearch (convertQuery)
// over the same documents, and the matching ids must be identical.
const NODE = process.env.DEWEY_OS_URL;

const index = `dewey_parity_${Date.now()}`;
const byId = (a: string, b: string) => a.localeCompare(b);

// Mappings are derived from a schema the same way repositories do (nested fields get
// include_in_parent by default), so dot paths through nested fields are covered too.
const Response = Type.Object({ statementId: Type.String(), choiceId: Type.String() });
const Block = Type.Object({ blockId: Type.String(), response: Type.Array(Response) });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const Schema = Type.Object({
  id: Type.String(),
  name: Nullable(Type.String()),
  age: Type.Union([Type.Integer(), Type.Null(), Type.Array(Nullable(Type.Integer()))]),
  born: Type.String({ format: "date-time" }),
  tags: Nullable(Type.Array(Nullable(Type.String()))),
  loc: Type.Array(Type.Number()),
  blocks: Type.Union([Type.Array(Nullable(Block)), Block]),
});

const mappings = deriveMappings(Schema, {
  dynamic: "strict",
  policy: { nested: ["blocks", "blocks.response"] },
  properties: { loc: { type: "geo_point" } },
});

const docs: Record<string, any>[] = [
  {
    id: "ravel",
    name: "Ravel",
    age: 62,
    born: "1875-03-07",
    tags: ["impressionist", "french"],
    loc: [2.35, 48.85],
    blocks: [
      {
        blockId: "M",
        response: [
          { statementId: "S1", choiceId: "B" },
          { statementId: "S2", choiceId: "A" },
        ],
      },
    ],
  },
  {
    id: "debussy",
    name: "Debussy",
    age: 55,
    born: "1862-08-22",
    tags: ["impressionist"],
    blocks: [
      {
        blockId: "M",
        response: [
          { statementId: "S1", choiceId: "A" },
          { statementId: "S2", choiceId: "B" },
        ],
      },
    ],
  },
  {
    // multi-valued field within a single nested doc
    id: "satie",
    name: "Satie",
    age: 59,
    tags: [],
    blocks: [{ blockId: "M", response: [{ statementId: "S1", choiceId: ["A", "B"] }] }],
  },
  {
    // skipped statement S1, single nested object instead of an array
    id: "faure",
    name: "Fauré",
    age: null,
    tags: [null, "french"],
    blocks: { blockId: "M", response: [{ statementId: "S2", choiceId: "A" }] },
  },
  {
    // statement S1 present but unanswered
    id: "chopin",
    name: "",
    age: [null, 39],
    tags: null,
    blocks: [{ blockId: "M", response: [{ statementId: "S1" }] }],
  },
  {
    id: "bach",
    tags: [null],
    blocks: [],
  },
  {
    id: "brahms",
    name: " Brahms ",
  },
  {
    id: "handel",
    name: "   ",
    tags: ["a*b", "a?c"],
  },
  {
    id: "liszt",
    name: null,
    age: [74, 20],
    blocks: [{ blockId: "X", response: [{ statementId: "S1", choiceId: "A" }] }, null],
  },
];

const matrix = (choiceExp: unknown) => ({
  blocks: {
    $elemMatch: {
      blockId: { $eq: "M" },
      response: { $elemMatch: { statementId: { $eq: "S1" }, choiceId: choiceExp } },
    },
  },
});

const queries: Record<string, any> = {
  // equality / existence
  "implicit eq": { name: "Ravel" },
  $ne: { name: { $ne: "Ravel" } },
  "eq on multi-valued": { tags: "french" },
  "$exists true": { age: { $exists: true } },
  "$exists false": { age: { $exists: false } },
  "$exists true (tags)": { tags: { $exists: true } },
  "$exists false (tags)": { tags: { $exists: false } },
  "$empty true": { name: { $empty: true } },
  "$empty false": { name: { $empty: false } },
  "$nempty true": { name: { $nempty: true } },

  // ranges
  $gt: { age: { $gt: 50 } },
  $gte: { age: { $gte: 59 } },
  $lt: { age: { $lt: 50 } },
  $lte: { age: { $lte: 55 } },
  $between: { age: { $between: [30, 60] } },
  "$between exclusive": { age: { $between: [39, 59], $exclusive: true } },
  "$gt on date": { born: { $gt: "1870-01-01" } },
  "$lt on date": { born: { $lt: "1870-01-01" } },

  // arrays
  $in: { tags: { $in: ["french", "baroque"] } },
  $nin: { tags: { $nin: ["french"] } },
  $all: { tags: { $all: ["impressionist", "french"] } },
  "$nin on null field": { age: { $nin: [62] } },
  "$in on null field": { age: { $in: [39, 62] } },

  // undefined implicit equals operands
  "undefined operand": { name: undefined, age: { $gt: 50 } },
  "undefined only": { name: undefined },
  "undefined in $and": { $and: [{ name: undefined }] },
  "undefined in $or": { $or: [{ name: undefined }, { age: 62 }] },
  "undefined in $not": { $not: { name: undefined } },
  "undefined in $nor": { $nor: [{ name: undefined }] },

  // compound
  $or: { $or: [{ name: "Ravel" }, { age: { $lt: 40 } }] },
  $nor: { $nor: [{ name: "Ravel" }, { age: { $lt: 40 } }] },
  $not: { $not: { tags: "french" } },

  // nested
  $elemMatch: { blocks: { $elemMatch: { blockId: "M" } } },
  "$elemMatch on X": { blocks: { $elemMatch: { blockId: "X" } } },
  "$elemMatch with $not": { blocks: { $elemMatch: { $not: { blockId: "M" } } } },
  "matrix $in": matrix({ $in: ["A"] }),
  "matrix $nin [A]": matrix({ $nin: ["A"] }),
  "matrix $nin [B]": matrix({ $nin: ["B"] }),
  "matrix $nin [A, B]": matrix({ $nin: ["A", "B"] }),
  "matrix $all [A]": matrix({ $all: ["A"] }),
  "matrix $all [A, B]": matrix({ $all: ["A", "B"] }),
  "matrix $exists false": matrix({ $exists: false }),
  "$nor matrix $in": { $nor: [matrix({ $in: ["A"] })] },

  // dot paths through nested fields (include_in_parent)
  "dot path through nested": { "blocks.blockId": "M" },
  "dot path through nested $ne": { "blocks.blockId": { $ne: "M" } },
  "dot path through two nested levels": { "blocks.response.choiceId": "A" },
  "dot path through two nested levels $nin": { "blocks.response.choiceId": { $nin: ["A"] } },
  "dot path $all across elements": { "blocks.response.choiceId": { $all: ["A", "B"] } },
  "dot path $exists false": { "blocks.response.choiceId": { $exists: false } },
  "dot paths across elements": { "blocks.blockId": "X", "blocks.response.statementId": "S2" },
  "dot path inside $elemMatch": {
    blocks: { $elemMatch: { blockId: "M", "response.choiceId": "A" } },
  },
  "dot path inside $elemMatch $ne": {
    blocks: { $elemMatch: { blockId: "M", "response.choiceId": { $ne: "A" } } },
  },

  // geo
  $near: { loc: { $near: [2.3, 48.8], $maxDistance: "10km" } },

  // strings
  $like: { name: { $like: "D%" } },
  "$like ci": { name: { $like: "d*", $caseInsensitive: true } },
  $unlike: { name: { $unlike: "D%" } },
  $includes: { name: { $includes: "av" } },
  $excludes: { name: { $excludes: "av" } },
  $prefix: { name: { $prefix: "Sa" } },
  $regex: { name: { $regex: "S.*" } },
  "$regex i": { name: { $regex: "s.*", $options: "i" } },
  $ids: { id: { $ids: ["ravel", "bach"] } },
  "$in empty": { tags: { $in: [] } },
  "$nin empty": { tags: { $nin: [] } },
  "$all empty": { tags: { $all: [] } },
  "$empty tags": { tags: { $empty: true } },
  "$nempty tags": { tags: { $nempty: true } },
  "numeric string eq": { age: "62" },
  "numeric string gt": { age: { $gt: "50" } },
  "$ne null field": { age: { $ne: 62 } },
  "date math": { born: { $lt: "now-100y" } },
  "$not $elemMatch": { $not: { blocks: { $elemMatch: { blockId: "M" } } } },
  "$elemMatch $nin": { blocks: { $elemMatch: { blockId: { $nin: ["M"] } } } },
  "$like unanchored": { name: { $like: "e%" } },
  "$like suffix": { name: { $like: "%y" } },
  "$prefix whitespace": { name: { $prefix: "Br" } },
  "$prefix leading space": { name: { $prefix: " Br" } },
  "$includes whitespace": { name: { $includes: "s " } },
  "$eq whitespace": { name: "Brahms" },
  "$regex anchors": { name: { $regex: "^Sa.*e$" } },
  "$regex regexp anchors": { name: { $regex: /^Sa/ } },
  "$regex substring": { name: { $regex: "ussy" } },
  "$empty whitespace": { name: { $empty: true } },
  "$includes literal *": { tags: { $includes: "*" } },
  "$includes literal ?": { tags: { $includes: "a?b" } },
  "$like ?": { tags: { $like: "a?c" } },
};

describe.runIf(NODE)("parity: makeFilter vs OpenSearch", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ node: NODE });
    await client.indices.create({ index, body: { mappings } as any });
    await client.bulk({
      refresh: true,
      body: docs.flatMap((doc) => [{ index: { _index: index, _id: doc.id } }, doc]),
    });
  });

  afterAll(async () => {
    await client?.indices.delete({ index }).catch(() => {});
  });

  it.each(Object.entries(queries))("%s", async (_, query) => {
    // repositories validate queries against the mapping before sending them
    validateQuery(query, mappings);

    const esQuery = convertQuery(query) ?? { match_all: {} };
    const res = await client.search({ index, body: { query: esQuery, size: docs.length } });
    const dbIds = res.body.hits.hits.map((hit: any) => hit._id).sort(byId);

    const filter = makeFilter(query);
    const memoryIds = docs
      .filter((doc) => filter(doc))
      .map((doc) => doc.id)
      .sort(byId);

    expect(memoryIds).toEqual(dbIds);
  });
});
