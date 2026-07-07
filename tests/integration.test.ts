import { Client } from "@opensearch-project/opensearch";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Index, isDeweyError, makeRepository, openSearch, Search } from "../src";

// Opt-in: only runs when DEWEY_OS_URL points at a reachable OpenSearch cluster.
const NODE = process.env.DEWEY_OS_URL;

const MediaSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    kind: Type.Literal("photo"),
    title: Type.String(),
    width: Type.Integer(),
    ver: Type.Integer(),
  }),
  Type.Object({
    id: Type.String(),
    kind: Type.Literal("video"),
    title: Type.String(),
    durationSec: Type.Integer(),
    ver: Type.Integer(),
  }),
]);

const MediaIndex = new Index(MediaSchema, {
  name: `dewey_it_media_${Date.now()}`,
  id: "id",
  version: "ver",
  discriminator: "kind",
});

class MediaRepo extends makeRepository(MediaIndex, { validate: true }) {}

describe.runIf(NODE)("integration: OpenSearch", () => {
  let search: Search;
  let repo: MediaRepo;

  beforeAll(async () => {
    const client = new Client({ node: NODE });
    search = new Search(openSearch(client), { refresh: true });
    repo = new MediaRepo(search);
    await repo.ensureIndex();
  });

  afterAll(async () => {
    await search.deleteIndex(MediaIndex.def.name).catch(() => {});
  });

  it("puts and gets a document", async () => {
    const res = await repo.put({ id: "p1", kind: "photo", title: "Sunset", width: 800, ver: 1 });
    expect(res.result).toBe("created");
    const got = await repo.get("p1");
    expect(got).toMatchObject({ id: "p1", kind: "photo", width: 800 });
  });

  it("rejects an invalid document via validation", async () => {
    await expect(
      // @ts-expect-error width must be a number
      repo.put({ id: "bad", kind: "photo", title: "x", width: "nope", ver: 1 }),
    ).rejects.toSatisfy(isDeweyError);
  });

  it("enforces external versioning", async () => {
    await repo.put({ id: "p2", kind: "photo", title: "v5", width: 100, ver: 5 });
    // stale version is rejected as a version conflict
    await expect(
      repo.put({ id: "p2", kind: "photo", title: "stale", width: 100, ver: 3 }),
    ).rejects.toSatisfy(isDeweyError);
    // newer version wins
    const res = await repo.put({ id: "p2", kind: "photo", title: "v9", width: 100, ver: 9 });
    expect(res.result).toBe("updated");
    expect((await repo.get("p2"))?.title).toBe("v9");
  });

  it("bulk indexes, then queries with discriminator narrowing", async () => {
    const bulk = await repo.bulkPut([
      { id: "b1", kind: "photo", title: "A", width: 640, ver: 1 },
      { id: "b2", kind: "photo", title: "B", width: 1024, ver: 1 },
      { id: "b3", kind: "video", title: "C", durationSec: 30, ver: 1 },
    ]);
    expect(bulk.errors).toBe(false);

    const bigPhotos = await repo.query({ kind: "photo", width: { $gte: 1000 } });
    expect(bigPhotos.map((p) => p.id).sort()).toContain("b2");
    // narrowed to the photo variant at the type level
    expect(bigPhotos.every((p) => p.kind === "photo")).toBe(true);

    const videos = await repo.query({ kind: "video" });
    expect(videos.some((v) => v.id === "b3")).toBe(true);
  });

  it("counts and aggregates", async () => {
    const total = await repo.count();
    expect(total).toBeGreaterThan(0);
    const byKind = await repo.countBy("kind");
    expect(byKind.photo).toBeGreaterThan(0);
    expect(byKind.video).toBeGreaterThan(0);
  });

  it("updates and deletes", async () => {
    await repo.update("p1", { title: "Sunset II" });
    expect((await repo.get("p1"))?.title).toBe("Sunset II");
    await repo.delete("p1");
    expect(await repo.get("p1")).toBeUndefined();
  });

  it("scrolls all documents", async () => {
    const ids: string[] = [];
    for await (const doc of repo.scroll({}, { size: 2 })) ids.push(doc.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });
});
