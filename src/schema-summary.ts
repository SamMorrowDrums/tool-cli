type JsonSchema = Record<string, unknown>;

/** Format a JSON Schema as a deterministic, nested human-readable summary. */
export function formatSchema(schema: JsonSchema): string {
  const properties = asSchemaMap(schema.properties);
  if (!properties || Object.keys(properties).length === 0) {
    return properties ? "  (no parameters)" : `  (${describeSchema(schema)})`;
  }

  return renderProperties(schema, 1).join("\n");
}

function renderProperties(schema: JsonSchema, depth: number): string[] {
  const properties = asSchemaMap(schema.properties);
  if (!properties) return [];

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const lines: string[] = [];

  for (const name of Object.keys(properties).sort((a, b) =>
    a.localeCompare(b),
  )) {
    const property = properties[name];
    const requirement = required.has(name) ? "required" : "optional";
    const description =
      typeof property.description === "string"
        ? `: ${property.description}`
        : "";
    lines.push(
      `${"  ".repeat(depth)}${name} (${describeSchema(property)}, ${requirement})${description}`,
    );

    const nestedProperties = asSchemaMap(property.properties);
    if (nestedProperties) {
      lines.push(...renderProperties(property, depth + 1));
      continue;
    }

    const items = asSchema(property.items);
    if (items && asSchemaMap(items.properties)) {
      lines.push(`${"  ".repeat(depth + 1)}items:`);
      lines.push(...renderProperties(items, depth + 2));
    }
  }

  return lines;
}

function describeSchema(schema: JsonSchema): string {
  if (Array.isArray(schema.enum)) {
    return `enum ${schema.enum.map((value) => JSON.stringify(value)).join(" | ")}`;
  }

  if (schema.const !== undefined) {
    return `const ${JSON.stringify(schema.const)}`;
  }

  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives) {
    const keyword = Array.isArray(schema.oneOf) ? "oneOf" : "anyOf";
    const labels = alternatives
      .map(asSchema)
      .filter((value): value is JsonSchema => value !== undefined)
      .map(describeSchema);
    return `${keyword}<${labels.join(" | ")}>`;
  }

  if (typeof schema.$ref === "string") {
    return `$ref ${schema.$ref}`;
  }

  const types = Array.isArray(schema.type)
    ? schema.type.filter((value): value is string => typeof value === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];

  if (types.includes("array")) {
    const items = asSchema(schema.items);
    const itemDescription = items ? describeSchema(items) : "unknown";
    const suffix = types.includes("null") ? " | null" : "";
    return `array<${itemDescription}>${suffix}`;
  }

  if (types.length > 0) {
    return types.join(" | ");
  }

  if (asSchemaMap(schema.properties)) return "object";
  return "unknown";
}

function asSchema(value: unknown): JsonSchema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;
}

function asSchemaMap(value: unknown): Record<string, JsonSchema> | undefined {
  const object = asSchema(value);
  if (!object) return undefined;

  const result: Record<string, JsonSchema> = {};
  for (const [key, item] of Object.entries(object)) {
    const schema = asSchema(item);
    if (schema) result[key] = schema;
  }
  return result;
}
