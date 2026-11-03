/*
 * A small JSON Schema validator for the config schema.
 *
 * Supports the subset Brainstem's schema uses: type (one or a list),
 * properties, required, additionalProperties (boolean or schema),
 * items, enum, const, minimum, maximum, exclusiveMinimum,
 * minLength, maxLength, pattern, minItems, maxItems, uniqueItems,
 * oneOf, anyOf, not and local $ref ("#/$defs/name"). Unknown
 * keywords (title, description, default, ...) are ignored, as JSON
 * Schema requires.
 *
 *   validate(schema, value) -> [{ path, message }]   (empty: valid)
 */
export function validate(schema, value) {
  const errors = [];
  check(schema, value, "", schema, errors);
  return errors;
}

function check(schema, value, path, root, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push({ path, message: "is not allowed" });
    return;
  }

  if (schema.$ref) {
    check(resolveRef(root, schema.$ref), value, path, root, errors);
    return;
  }

  const fail = message => errors.push({ path: path || "/", message });

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => isType(value, type))) {
      fail(`must be ${types.join(" or ")}`);
      return;
    }
  }

  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    fail(`must be ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum && !schema.enum.some(item => deepEqual(item, value))) {
    fail(`must be one of ${schema.enum.map(item => JSON.stringify(item)).join(", ")}`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      fail(`must be > ${schema.exclusiveMinimum}`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(`must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(`must be at most ${schema.maxLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      fail(`must match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`must have at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`must have at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map(item => JSON.stringify(item)));
      if (seen.size !== value.length) fail("must not contain duplicates");
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => check(schema.items, item, `${path}/${index}`, root, errors));
    }
  }

  if (isType(value, "object")) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) fail(`must have property '${name}'`);
    }

    for (const [name, item] of Object.entries(value)) {
      const childPath = `${path}/${escapePointer(name)}`;

      if (schema.properties && Object.hasOwn(schema.properties, name)) {
        check(schema.properties[name], item, childPath, root, errors);
      }
      else if (schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) {
          errors.push({ path: childPath, message: "is not a known property" });
        }
        else {
          check(schema.additionalProperties, item, childPath, root, errors);
        }
      }
    }
  }

  if (schema.anyOf && !schema.anyOf.some(option => validate({ ...option, $defs: root.$defs }, value).length === 0)) {
    fail(schema.errorMessage ?? "does not match any allowed form");
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter(option => validate({ ...option, $defs: root.$defs }, value).length === 0);
    if (matches.length !== 1) fail(schema.errorMessage ?? "must match exactly one allowed form");
  }

  if (schema.not && validate({ ...schema.not, $defs: root.$defs }, value).length === 0) {
    fail("matches a form that is not allowed");
  }
}

function resolveRef(root, ref) {
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  const target = match ? root.$defs?.[match[1]] : undefined;

  if (target === undefined) throw new Error(`Unsupported or unknown $ref '${ref}'`);

  return target;
}

function isType(value, type) {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: throw new Error(`Unsupported JSON Schema type '${type}'`);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function escapePointer(name) {
  return String(name).replaceAll("~", "~0").replaceAll("/", "~1");
}
