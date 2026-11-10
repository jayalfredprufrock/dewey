import { Type } from "typebox";
import type { Static } from "typebox";
import { describe, expectTypeOf, test } from "vitest";
import { DiscriminatedUnion, Index, makeRepository, Search } from "../src";
import type { QueryFor, RepoQuery } from "../src";

const Answer = Type.Object({ statementId: Type.String(), choiceId: Type.String() });
const Block = Type.Object({
  blockId: Type.String(),
  meta: Type.Object({ order: Type.Integer() }),
  response: Type.Array(Answer),
});
const Submission = Type.Object({
  id: Type.String(),
  email: Type.String(),
  respondent: Type.Object({ age: Type.Integer(), blocks: Type.Array(Block) }),
  notes: Type.Array(Type.Object({ author: Type.String() })),
});

const SubmissionIndex = new Index(Submission, {
  name: "submissions",
  id: "id",
  mapping: { policy: { nested: ["respondent.blocks", "respondent.blocks.response", "notes"] } },
});
class SubmissionRepo extends makeRepository(SubmissionIndex) {}
const repo = new SubmissionRepo(new Search({} as never));

describe("query types", () => {
  test("$elemMatch is typed against the element, at any depth", () => {
    void repo.query({
      "respondent.blocks": {
        $elemMatch: {
          blockId: { $eq: "M" },
          "meta.order": { $lt: 3 },
          response: { $elemMatch: { statementId: "S1", choiceId: { $nin: ["A"] } } },
        },
      },
    });
    void repo.query({ $or: [{ notes: { $elemMatch: { author: "bob" } } }, { email: "x" }] });
    void repo.query({ "respondent.blocks.response": { $elemMatch: { choiceId: "A" } } });

    // @ts-expect-error unknown field inside $elemMatch
    void repo.query({ "respondent.blocks": { $elemMatch: { nope: 1 } } });
    // @ts-expect-error wrong operand type inside $elemMatch
    void repo.query({ "respondent.blocks": { $elemMatch: { "meta.order": { $lt: true } } } });
    void repo.query({
      // @ts-expect-error wrong operand type inside a nested $elemMatch
      "respondent.blocks": { $elemMatch: { response: { $elemMatch: { choiceId: 5 } } } },
    });
    // @ts-expect-error $elemMatch on a scalar field
    void repo.query({ email: { $elemMatch: { a: 1 } } });
  });

  test("$elemMatch is limited to the index's nested paths", () => {
    // @ts-expect-error "respondent" is an object, but isn't mapped as nested
    void repo.query({ respondent: { $elemMatch: { age: 1 } } });
    void repo.query({
      // @ts-expect-error "meta" (within respondent.blocks) isn't mapped as nested
      "respondent.blocks": { $elemMatch: { meta: { $elemMatch: { order: 1 } } } },
    });

    // without a nested policy (e.g. QueryFor over a plain type), any object path is allowed
    expectTypeOf({ respondent: { $elemMatch: { age: 1 } } }).toExtend<
      QueryFor<Static<typeof Submission>>
    >();
    expectTypeOf<{ respondent: { $elemMatch: { age: 1 } } }>().not.toExtend<
      RepoQuery<SubmissionRepo["$self"]>
    >();
  });

  test("dot paths through arrays of objects resolve at any depth", () => {
    void repo.query({ "respondent.blocks.meta.order": { $in: [1, 2] } });
    void repo.query({ "respondent.blocks.response.choiceId": { $all: ["A", "B"] } });
    // @ts-expect-error wrong operand type
    void repo.query({ "respondent.blocks.response.choiceId": { $in: [1] } });
  });

  test("$empty/$nempty apply to string fields", () => {
    void repo.query({ email: { $empty: true } });
    void repo.query({ $nor: [{ email: { $nempty: false } }] });
    // @ts-expect-error not a string field
    void repo.query({ "respondent.age": { $empty: true } });
  });

  describe("union schemas", () => {
    const Media = DiscriminatedUnion("kind", [
      Type.Object({
        id: Type.String(),
        kind: Type.Literal("photo"),
        width: Type.Integer(),
        exif: Type.Object({ camera: Type.String() }),
      }),
      Type.Object({
        id: Type.String(),
        kind: Type.Literal("video"),
        durationSec: Type.Integer(),
        chapters: Type.Array(Type.Object({ title: Type.String() })),
      }),
      Type.Object({ id: Type.String(), kind: Type.Literal("audio"), durationSec: Type.Number() }),
    ]);
    const MediaIndex = new Index(Media, {
      name: "media",
      id: "id",
      mapping: { policy: { nested: ["chapters"] } },
    });
    class MediaRepo extends makeRepository(MediaIndex) {}
    const media = new MediaRepo(new Search({} as never));

    test("variant-specific fields can be queried and aggregated", () => {
      void media.query({ width: { $gt: 100 } });
      void media.query({ $or: [{ width: { $gt: 100 } }, { durationSec: { $lt: 60 } }] });
      void media.query({ "exif.camera": "x", chapters: { $elemMatch: { title: "intro" } } });
      void media.countBy("exif.camera");
      void media.average("durationSec");

      // @ts-expect-error wrong operand type for a variant field
      void media.query({ width: { $gt: true } });
      // @ts-expect-error unknown field path
      void media.countBy("nope");
    });

    test("narrows results by the discriminator ($eq shorthand, $eq and $in)", async () => {
      expectTypeOf(await media.query({ kind: "photo" })).toEqualTypeOf<
        Extract<Static<typeof Media>, { kind: "photo" }>[]
      >();
      expectTypeOf(await media.query({ kind: { $eq: "video" } })).toEqualTypeOf<
        Extract<Static<typeof Media>, { kind: "video" }>[]
      >();
      expectTypeOf(await media.query({ kind: { $in: ["video", "audio"] } })).toEqualTypeOf<
        Extract<Static<typeof Media>, { kind: "video" | "audio" }>[]
      >();
      expectTypeOf(await media.query({ id: "x" })).toEqualTypeOf<Static<typeof Media>[]>();
    });

    test("the discriminator must be a literal in every variant", () => {
      const Photo = Type.Object({
        id: Type.String(),
        kind: Type.Literal("photo"),
        width: Type.Integer(),
      });
      const Audio = Type.Object({ id: Type.String(), kind: Type.Literal("audio") });
      void DiscriminatedUnion("kind", [Photo, Audio]);
      // @ts-expect-error "width" only exists on the photo variant
      void DiscriminatedUnion("width", [Photo, Audio]);
      // @ts-expect-error "id" is shared but not a literal
      void DiscriminatedUnion("id", [Photo, Audio]);
    });

    test("nested variant groups: the discriminator spans every leaf", async () => {
      const Photo = Type.Object({ kind: Type.Literal("photo"), width: Type.Integer() });
      const Video = Type.Object({ kind: Type.Literal("video"), durationSec: Type.Integer() });
      const Doc = Type.Object({ kind: Type.Literal("doc"), pages: Type.Integer() });
      const Nested = DiscriminatedUnion("kind", [Type.Union([Photo, Video]), Doc]);
      class NestedRepo extends makeRepository(new Index(Nested, { name: "nested" })) {}
      const nested = new NestedRepo(new Search({} as never));
      expectTypeOf(await nested.query({ kind: "video" })).toEqualTypeOf<Static<typeof Video>[]>();
    });

    test("a plain union does not narrow", async () => {
      const Plain = Type.Union([
        Type.Object({ kind: Type.Literal("a"), x: Type.Integer() }),
        Type.Object({ kind: Type.Literal("b"), y: Type.Integer() }),
      ]);
      class PlainRepo extends makeRepository(new Index(Plain, { name: "plain" })) {}
      const plain = new PlainRepo(new Search({} as never));
      expectTypeOf(await plain.query({ kind: "a" })).toEqualTypeOf<Static<typeof Plain>[]>();
    });
  });

  describe("multi-valued (array) fields are queried by their values", () => {
    test("any operator applies to the values", () => {
      void repo.query({ "notes.author": "bob" });
      void repo.query({ "notes.author": { $ne: "bob" } });
      void repo.query({ "notes.author": { $prefix: "b" } });
      void repo.query({ "respondent.blocks.meta.order": { $between: [1, 3] } });
      void repo.query({ "respondent.blocks.response.choiceId": { $nin: ["A"] } });
    });

    test("array operands are still rejected for equality", () => {
      // @ts-expect-error exact array matching isn't supported
      void repo.query({ "notes.author": ["bob", "amy"] });
      // @ts-expect-error exact array matching isn't supported
      void repo.query({ "notes.author": { $ne: ["bob"] } });
      // @ts-expect-error element type is still enforced
      void repo.query({ "respondent.blocks.meta.order": { $in: ["x"] } });
    });
  });

  describe("unknown keys are rejected at any depth", () => {
    test("query", () => {
      // @ts-expect-error unknown key alongside a known one
      void repo.query({ email: "x", nope: 1 });
      // @ts-expect-error unknown key in $or
      void repo.query({ $or: [{ email: "x" }, { nope: 1 }] });
      // @ts-expect-error unknown key in $and
      void repo.query({ $and: [{ email: "x", nope: 1 }] });
      // @ts-expect-error unknown key in $not
      void repo.query({ $not: { email: "x", nope: 1 } });
      void repo.query({
        // @ts-expect-error unknown key alongside known ones in $elemMatch
        "respondent.blocks": { $elemMatch: { blockId: "M", nope: 1 } },
      });
      void repo.query({
        "respondent.blocks": {
          // @ts-expect-error unknown key in a nested $elemMatch
          $elemMatch: { blockId: "M", response: { $elemMatch: { choiceId: "A", nope: 1 } } },
        },
      });
      // @ts-expect-error typo in a dot path
      void repo.query({ email: "x", "respondent.blocks.blokId": "M" });
    });

    test("search and scroll", () => {
      // @ts-expect-error unknown key
      void repo.search({ email: "x", nope: 1 });
      // @ts-expect-error unknown key
      void repo.scroll({ email: "x", nope: 1 });
    });
  });
});
