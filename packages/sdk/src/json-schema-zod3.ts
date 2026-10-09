import { z } from "zod/v3";

/**
 * A zod 3 schema for a tool's JSON Schema, for frameworks whose tools are typed with zod 3
 * (Coinbase AgentKit 0.10). It covers what the Arena's tools use (objects of strings with
 * patterns and lengths, numbers, booleans, arrays, enums); anything else is accepted as is, and
 * the gateway checks every call against the real schema anyway.
 */
export function zod3FromJsonSchema(schema: unknown): z.ZodTypeAny {
  const s = (schema ?? {}) as Record<string, unknown>;
  const described = (t: z.ZodTypeAny) =>
    typeof s.description === "string" ? t.describe(s.description) : t;

  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((v) => typeof v === "string"))
    return described(z.enum(s.enum as [string, ...string[]]));
  if ("const" in s && ["string", "number", "boolean"].includes(typeof s.const))
    return described(z.literal(s.const as string | number | boolean));

  switch (s.type) {
    case "object": {
      const properties = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(properties)) {
        const t = zod3FromJsonSchema(value);
        shape[key] = required.has(key) ? t : t.optional();
      }
      const object = z.object(shape);
      return described(s.additionalProperties === false ? object.strict() : object.passthrough());
    }
    case "string": {
      let t = z.string();
      if (typeof s.minLength === "number") t = t.min(s.minLength);
      if (typeof s.maxLength === "number") t = t.max(s.maxLength);
      if (typeof s.pattern === "string") t = t.regex(new RegExp(s.pattern));
      return described(t);
    }
    case "integer":
    case "number": {
      let t = s.type === "integer" ? z.number().int() : z.number();
      if (typeof s.minimum === "number") t = t.min(s.minimum);
      if (typeof s.maximum === "number") t = t.max(s.maximum);
      return described(t);
    }
    case "boolean":
      return described(z.boolean());
    case "array":
      return described(z.array(zod3FromJsonSchema(s.items)));
    default:
      return described(z.any());
  }
}
