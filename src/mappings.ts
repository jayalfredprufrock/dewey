import type { TSchema } from "typebox";
import { flattenVariants } from "./discriminated-union";
import { DeweyError } from "./error";
import type { AllKeys, Obj } from "./types";

export type EsType =
  | "keyword"
  | "text"
  | "long"
  | "integer"
  | "short"
  | "byte"
  | "double"
  | "float"
  | "boolean"
  | "date"
  | "object"
  | "nested"
  | "geo_point"
  | "ip"
  // allow any other ES/OS field type without losing autocomplete on the common ones
  | (string & {});

export interface EsFieldMapping extends Obj {
  type?: EsType;
  // e.g. properties, fields, analyzer, format, index, doc_values, …
}

/** Tunable defaults for how a typebox schema is translated into ES/OS field mappings. */
export interface MappingPolicy {
  /** Default ES type for schema strings. Default `"keyword"`. */
  string?: "keyword" | "text";
  /** Add a `.keyword` subfield to `text` fields (for sort/agg). Default `true` when `string === "text"`. */
  stringSubfield?: boolean;
  /** Default ES type for schema integers. Default `"long"`. */
  integer?: "long" | "integer" | "short" | "byte";
  /** Default ES type for non-integer schema numbers. Default `"double"`. */
  number?: "double" | "float";
  /** Object / array-of-object fields to map as `nested` rather than `object`. */
  nested?: readonly string[];
  /**
   * Set `include_in_parent` on `nested` fields so their values are also indexed on the parent
   * document. Dot-path queries through nested fields (e.g. `"blocks.blockId"`) then match the
   * same documents in OpenSearch as they do in memory (`makeFilter`), at the cost of indexing
   * nested values once more per nesting level. `$elemMatch` still matches within a single
   * nested element. Default `true`.
   */
  includeInParent?: boolean;
  /** Detect dates from typebox `format: "date-time"` (and epoch-millis number heuristics). Default `true`. */
  detectDates?: boolean;
}

export interface MappingConfig<T = any> {
  policy?: MappingPolicy;
  /** How ES treats fields not present in the mapping. Default `false` (ignore). */
  dynamic?: boolean | "strict" | "runtime";
  /** Explicit per-field mappings, deep-merged OVER the derived mapping (explicit wins). */
  properties?: Partial<Record<AllKeys<T> | (string & {}), EsFieldMapping>>;
  /** Raw index settings (number_of_shards, analysis, …). */
  settings?: Obj;
}

export interface DerivedMappings {
  dynamic: boolean | "strict" | "runtime";
  properties: Record<string, EsFieldMapping>;
}

interface ResolvedPolicy {
  string: "keyword" | "text";
  stringSubfield: boolean;
  integer: "long" | "integer" | "short" | "byte";
  number: "double" | "float";
  nested: readonly string[];
  includeInParent: boolean;
  detectDates: boolean;
}

const resolvePolicy = (policy?: MappingPolicy): ResolvedPolicy => {
  const string = policy?.string ?? "keyword";
  return {
    string,
    stringSubfield: policy?.stringSubfield ?? string === "text",
    integer: policy?.integer ?? "long",
    number: policy?.number ?? "double",
    nested: policy?.nested ?? [],
    includeInParent: policy?.includeInParent ?? true,
    detectDates: policy?.detectDates ?? true,
  };
};

// Minimal structural view of the parts of a typebox/JSON schema we introspect.
interface SchemaNode {
  type?: string | string[];
  format?: string;
  const?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  anyOf?: SchemaNode[];
}

const stringMapping = (node: SchemaNode, policy: ResolvedPolicy): EsFieldMapping => {
  if (policy.detectDates && node.format === "date-time") return { type: "date" };
  if (policy.string === "text" && policy.stringSubfield) {
    return { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } };
  }
  return { type: policy.string };
};

const inferScalarType = (node: SchemaNode): string | undefined => {
  const type = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
  if (type) return type;
  if (node.const !== undefined)
    return typeof node.const === "number" ? "number" : typeof node.const;
  return undefined;
};

const deriveField = (
  node: SchemaNode,
  policy: ResolvedPolicy,
  path: string,
): EsFieldMapping | undefined => {
  // union at the field level (e.g. literal enums, nullable): derive members and
  // require agreement, otherwise fall through to dynamic mapping.
  if (node.anyOf?.length) {
    const derived = node.anyOf
      .map((member) => deriveField(member, policy, path))
      .filter((m): m is EsFieldMapping => m !== undefined);
    const unique = new Map(derived.map((m) => [JSON.stringify(m), m]));
    return unique.size === 1 ? [...unique.values()][0] : undefined;
  }

  const asObject = (): EsFieldMapping => {
    const properties = deriveProperties(node.properties ?? {}, policy, path);
    if (!policy.nested.includes(path)) return { type: "object", properties };
    return policy.includeInParent
      ? { type: "nested", include_in_parent: true, properties }
      : { type: "nested", properties };
  };

  const type = inferScalarType(node);
  switch (type) {
    case "string":
      return stringMapping(node, policy);
    case "integer":
      return { type: policy.integer };
    case "number":
      return { type: policy.number };
    case "boolean":
      return { type: "boolean" };
    case "object":
      return asObject();
    case "array":
      return node.items ? deriveField(node.items, policy, path) : undefined;
    default:
      return undefined; // null / unknown / any → rely on `dynamic`
  }
};

const deriveProperties = (
  properties: Record<string, SchemaNode>,
  policy: ResolvedPolicy,
  prefix: string,
): Record<string, EsFieldMapping> => {
  const result: Record<string, EsFieldMapping> = {};
  for (const [key, node] of Object.entries(properties)) {
    const mapping = deriveField(node, policy, prefix ? `${prefix}.${key}` : key);
    if (mapping !== undefined) result[key] = mapping;
  }
  return result;
};

const isPlainObject = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const deepMerge = (base: Obj, override: Obj): Obj => {
  const result: Obj = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
};

/**
 * Derive an ES/OS mapping from a typebox schema per `config.policy`, then deep-merge
 * `config.properties` on top (explicit wins). Union schemas (`Type.Union([...])`,
 * nested unions included) merge every variant's properties into one flat superset; same-named fields whose
 * derived types conflict throw a `DeweyError({ type: "DATA_INTEGRITY" })`.
 */
export const deriveMappings = (schema: TSchema, config?: MappingConfig): DerivedMappings => {
  const policy = resolvePolicy(config?.policy);
  const node = schema as unknown as SchemaNode;

  let properties: Record<string, EsFieldMapping> = {};
  if (node.anyOf?.length) {
    for (const variant of flattenVariants(schema) as unknown as SchemaNode[]) {
      const variantProps = deriveProperties(variant.properties ?? {}, policy, "");
      for (const [field, mapping] of Object.entries(variantProps)) {
        const existing = properties[field];
        if (existing && JSON.stringify(existing) !== JSON.stringify(mapping)) {
          throw new DeweyError({
            type: "DATA_INTEGRITY",
            message: `Union variants map field "${field}" to conflicting types (${existing.type} vs ${mapping.type}). Provide an explicit mapping override.`,
          });
        }
        properties[field] = mapping;
      }
    }
  } else if (node.properties) {
    properties = deriveProperties(node.properties, policy, "");
  }

  if (config?.properties) {
    properties = deepMerge(properties, config.properties as Obj) as Record<string, EsFieldMapping>;
  }

  return { dynamic: config?.dynamic ?? false, properties };
};
