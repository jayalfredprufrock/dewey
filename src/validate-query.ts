import { DeweyError } from "./error";
import type { DerivedMappings, EsFieldMapping } from "./mappings";
import { isCompoundOperator, isObj } from "./query/util";

type Properties = Record<string, EsFieldMapping>;
type Dynamic = DerivedMappings["dynamic"];

const invalid = (message: string) => new DeweyError({ type: "VALIDATION", message });

/**
 * Check a mongo-style query against an index mapping for queries that OpenSearch would
 * silently evaluate differently than `makeFilter` (or reject outright):
 *
 * - a field missing from the mapping when unmapped fields aren't indexed (`dynamic` is
 *   `false` or `"strict"`), e.g. a typo. OpenSearch would match nothing (or everything,
 *   when negated).
 * - a dot path that crosses into a `nested` field which doesn't index its values on the
 *   parent (`include_in_parent`, or `include_in_root` for paths starting at the document
 *   root). OpenSearch can't see those values, so the condition matches nothing (or
 *   everything, when negated).
 * - `$elemMatch` on a field that isn't mapped as `nested`, which OpenSearch rejects.
 *
 * `dynamic` defaults to `true` (unmapped fields are allowed and not checked).
 */
export const validateQuery = (
  query: unknown,
  mappings: { properties: Properties; dynamic?: Dynamic },
): void => {
  validate(query, mappings.properties, mappings.dynamic ?? true, "", true);
};

const validate = (
  query: unknown,
  properties: Properties,
  dynamic: Dynamic,
  prefix: string,
  atRoot: boolean,
) => {
  if (!isObj(query)) return;

  for (const [key, value] of Object.entries(query)) {
    if (isCompoundOperator(key)) {
      for (const subQuery of [value].flat()) {
        validate(subQuery, properties, dynamic, prefix, atRoot);
      }
      continue;
    }

    // $ids queries document ids, so the field name isn't part of the ES query
    if (isObj(value) && "$ids" in value) continue;

    const resolved = resolveField(key, properties, dynamic, prefix, atRoot);
    if (!resolved) continue;

    const { field, dynamic: fieldDynamic } = resolved;
    if (isObj(value) && "$elemMatch" in value) {
      const path = `${prefix}${key}`;
      if (field.type !== "nested") {
        throw invalid(
          `$elemMatch requires "${path}" to be mapped as nested (add it to the mapping policy's "nested" fields).`,
        );
      }
      validate(value.$elemMatch, field.properties ?? {}, fieldDynamic, `${path}.`, false);
    }
  }
};

// Walk a (possibly dotted) field path through the mapping, throwing if it crosses a nested
// field whose values aren't visible from the current scope, or reaches a field that isn't
// mapped where unmapped fields aren't indexed. Returns the field's mapping (and the dynamic
// setting that applies within it), or undefined if the path is unmapped but allowed.
const resolveField = (
  key: string,
  properties: Properties,
  dynamic: Dynamic,
  prefix: string,
  atRoot: boolean,
): { field: EsFieldMapping; dynamic: Dynamic } | undefined => {
  const segments = key.split(".");
  let current: Properties = properties;
  let currentDynamic = dynamic;

  for (const [i, segment] of segments.entries()) {
    const field: EsFieldMapping | undefined = current[segment];
    if (!field) {
      if (currentDynamic === false || currentDynamic === "strict") {
        throw invalid(
          `"${prefix}${key}" isn't in the index mapping, so it can't match any documents. Check the field name, or add it to the schema or mapping.`,
        );
      }
      return undefined;
    }

    const fieldDynamic: Dynamic = field.dynamic ?? currentDynamic;
    if (i === segments.length - 1) return { field, dynamic: fieldDynamic };

    const visible = field.include_in_parent === true || (atRoot && field.include_in_root === true);
    if (field.type === "nested" && !visible) {
      const nestedPath = `${prefix}${segments.slice(0, i + 1).join(".")}`;
      throw invalid(
        `"${prefix}${key}" crosses nested field "${nestedPath}", whose values aren't indexed on its parent. Use $elemMatch, or enable include_in_parent for "${nestedPath}".`,
      );
    }

    // sub-properties, or multi-fields (e.g. "bio.keyword")
    current = { ...field.fields, ...field.properties };
    currentDynamic = fieldDynamic;
  }

  return undefined;
};
