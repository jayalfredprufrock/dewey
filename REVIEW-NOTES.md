# Dewey — code review backlog

Findings from the high-effort code review (2026-07-08). Grouped into the batches
we agreed to tackle in order. `[verdict]` = CONFIRMED unless noted. File:line refs
are approximate — confirm before editing.

---

## Batch A — publish blocker (do first)

- [ ] **NPM_TOKEN not in release env** — `.github/workflows/release.yml` (Tag and Release step).
      The `Configure npm auth` step writes `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`
      to `~/.npmrc`, but the `Tag and Release` step's `env:` only sets `GITHUB_TOKEN`.
      So `${NPM_TOKEN}` can't expand → pnpm 10 errors / npm 401. **Fix:** add
      `NPM_TOKEN: ${{ secrets.NPM_TOKEN }}` to that step's `env`.

---

## Batch B — runtime correctness

- [ ] **`scroll()` leaks `from` into the PIT/`search_after` body + drops `routing`** — `src/repo.ts` (scroll).
      `{ ...options }` is spread into `buildSearchBody`, so `from` (and `aggs`/`highlight`)
      flow into a search_after request → OpenSearch 400 `[from] cannot be used with [search_after]`.
      Also calls `db.search("", body)` with no opts, so `routing` is silently dropped (search() wires it).
      **Fix:** only forward the fields scroll supports (query/sort/source/size/routing); never `from`/`aggs`;
      build the body once outside the loop and mutate `search_after` per page (also addresses the
      per-page `convertQuery` recompute noted below).

- [ ] **Error normalization only wraps get/index/create/update/delete** — `src/search.ts`.
      `search`/`count`/`bulk`/`updateByQuery`/`deleteByQuery` + all index-admin bypass `run()`, so
      raw driver `ResponseError` leaks instead of `DeweyError` (e.g. updateByQuery 409 never becomes
      VERSION_CONFLICT; deleteIndex/search 404 stays raw). **Fix:** route every op through `run()`
      with an appropriate `op` (search/count/bulk/admin). Decide the op-kind mapping for by-query/admin.

- [ ] **Search hits' `seqNo`/`primaryTerm`/`version` always `undefined`** — `src/build.ts` (buildSearchBody).
      `seq_no_primary_term: true` is never set, so the read-seqNo → conditional-write OCC flow silently
      becomes unconditional even though `SearchHits` promises those fields. **Fix:** set
      `seq_no_primary_term: true` (and `version: true` if we want `_version`) in the search body —
      possibly gated by an option to avoid the overhead when not needed.

- [ ] **`deriveMappings` silently drops/mis-maps common typebox shapes** — `src/mappings.ts`.
      Verified via node: `Type.Record` → `{type:'object',properties:{}}`; `Type.Tuple` → field dropped
      (`items` is an array, read as a single node); `Type.Intersect`/`Type.Composite` (allOf) → empty
      properties; object-valued unions at field level → dropped. With `dynamic:false` these are unindexed
      (queries return nothing); with `dynamic:'strict'` writes are rejected. **Fix:** handle `items` arrays
      (tuple), `patternProperties` (record → probably a typed `object`/flattened or documented limitation),
      `allOf` (merge like a union but intersecting), and root schemas that aren't object/union. At minimum,
      throw/warn instead of silently emitting `{}`.

- [ ] **By-query refresh broken** — `src/search.ts:~109` (updateByQuery/deleteByQuery).
      Default `config.refresh` is not applied (no `this.refresh()` call), and `refresh:'wait_for'`
      (allowed by `ByQueryOptions.refresh: Refresh`) is forwarded to `_update_by_query`, which only
      accepts a boolean → 400. **Fix:** apply `this.refresh()`; restrict/translate the by-query refresh
      type to `boolean` (wait_for isn't valid there).

- [ ] **`resolveVersion` → `NaN` for ISO-string version fields** — `src/build.ts` (resolveVersion).
      `Number("2026-07-07T…")` = NaN → `version: NaN` sent (the doc suggests `updatedAt`, often an ISO
      string). **Fix:** if the field is a date string, parse to epoch millis (`Date.parse`); reject/guard NaN
      with a clear DeweyError; and/or tighten the VersionStrategy doc + accept `Date`/string→millis.

- [ ] **Union-merge conflict check is order-sensitive** — `src/mappings.ts:~187`.
      Compares field mappings with `JSON.stringify`, so two variants mapping a shared object field with
      sub-properties in different key order throw a spurious `DATA_INTEGRITY` error, blocking `ensureIndex`.
      **Fix:** deep-equal that's key-order-insensitive (sort keys, or compare structurally).

- [ ] **`put()` merges external version with caller `ifSeqNo`/`ifPrimaryTerm`** — `src/repo.ts` (put). `[PLAUSIBLE]`
      On a versioned index, `put(doc, { ifSeqNo, ifPrimaryTerm })` sends both version+version_type and
      if_seq_no+if_primary_term → OpenSearch 400. **Fix:** if the caller supplies seq-no CAS params, drop
      the derived external version (caller intent wins); document precedence.

- [ ] **External version `0` is sent** — `src/repo.ts` (versionFor). `[PLAUSIBLE, niche]`
      A version field/fn returning `0` passes the `=== undefined` guard → external version 0, which OS may
      reject. **Fix:** decide whether 0 is valid; guard if not.

---

## Batch C — union type ergonomics (separate pass; touches type machinery)

- [ ] **`countBy`/`average`/field-path types reject variant-specific fields over a union** —
      `src/repo.types.ts` (RepoFieldPath = DotPath over the union = shared keys only). `repo.countBy('radius')`
      on a Circle|Square union is a compile error though it's a valid aggregation. **Fix:** field paths should
      distribute over the union (allow any variant's field).

- [ ] **`$eq`/`$in` discriminator form doesn't narrow (only bare-literal shorthand does)** — `src/types.ts`
      (ExtractDiscriminatorValue). `query({ kind: { $eq: 'circle' } })` returns the full union; `query({ kind: 'circle' })`
      narrows. Verified via tsgo. **Fix:** also extract the literal from `{ $eq }`/`{ $in: [lit] }` forms.

- [x] **Variant-only `discriminator` accepted silently** — `src/search-index.ts` (IndexDef.discriminator
      is `AllKeys<T>`, not shared keys). `discriminator: 'radius'` type-checks but silently disables narrowing. _Resolved: the discriminator now comes from `DiscriminatedUnion`, which requires a literal in every variant._
      **Fix:** constrain to shared keys (`AllKeys<T> & keyof …` intersection across variants), like IdStrategy.

---

## Notable lower-severity (real, not yet triaged)

- [ ] **Bulk swallows per-item failures** — `bulkGroups` returns `{ errors, items }` and never throws;
      the `BULK` `DeweyError` variant (`error.ts`) is never constructed. Consider a throw-on-error option or
      `*OrThrow` variants, or at least document that callers must inspect `result.errors`.
- [ ] **`update`/`upsert` bypass `transformInput` + `validate`** — only `put`/`create` run `prepare()`.
      Decide whether partial updates should transform/validate (signature is full-doc, so needs thought).
- [ ] **`source`-filtered reads still run `transformOutput` over partial `_source`** typed as the full doc
      — a `transformOutput` reading absent fields gets `undefined`/throws. Document or guard.
- [ ] **`publishConfig.exports` has no `types` condition** — under node16/nodenext/bundler, consumers may get
      no declarations. May be papered over by vite-plus `pack.exports.devExports`; verify what vp actually
      publishes, then add `types` conditions if needed.
- [ ] **`checkout` has no `fetch-depth: 0`** — semantic-release wants full history + tags. Mirrors dinah
      (which omits it), so verify whether releases compute correctly before changing.
- [ ] **`average()` returns `0` for no-match** — `null ?? 0` makes "no docs" indistinguishable from a real 0.
      Consider returning `undefined`/`null`.
- [ ] **Duplicated version-param converters** — `pickVersionParams` + `snakeVersion` (repo.ts) + `versionParams`
      (search-client.ts) are three copies of the same VersionParams shape. Consolidate to one helper.
- [ ] **Exported `Simplify<T>` is unused** — `src/types.ts`. Wire it into result display types or remove.
- [ ] **`exists()` uses a full `count()`** — a `size:0` + `terminate_after:1` search is cheaper for presence.
- [ ] **`scroll()` rebuilds the query body every page** — build once, mutate `search_after` (folds into the
      scroll fix in Batch B).
