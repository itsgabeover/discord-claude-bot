import { z } from 'zod';

/**
 * Convert a JSON Schema tool definition into the Zod "raw shape" the Agent
 * SDK's `tool()` helper expects.
 *
 * The SDK accepts only Zod for tool inputs — unlike the Messages API, raw JSON
 * Schema is rejected. Converting at runtime rather than hand-rewriting all 21
 * schemas is deliberate: PACKS in ./index.js stays the single source of truth
 * for every tool, so a tool added there works on both the Messages API path and
 * the Agent SDK path with no second definition to keep in sync. A hand-port
 * would have been ~250 lines of duplicated schema that silently drifts.
 *
 * Only the subset of JSON Schema the tool definitions actually use is handled:
 * a flat object of string/number/integer/boolean properties, with `description`
 * and `required`. Anything unrecognised falls back to `z.unknown()` rather than
 * throwing, so an exotic new schema degrades to a loosely-typed tool instead of
 * taking the whole bot down at startup.
 *
 * @param {object} schema - A JSON Schema object from a PACKS tool definition
 * @returns {Record<string, z.ZodTypeAny>} Raw shape for `tool()`
 */
export function jsonSchemaToZodShape(schema) {
  const shape = {};
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);

  for (const [key, spec] of Object.entries(properties)) {
    let field;

    switch (spec?.type) {
      case 'string':
        field = z.string();
        break;
      case 'integer':
        field = z.number().int();
        break;
      case 'number':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      default:
        console.warn(
          `[zod-schema] Unhandled JSON Schema type "${spec?.type}" for property ` +
            `"${key}" — falling back to unknown.`,
        );
        field = z.unknown();
    }

    // Descriptions are load-bearing, not decoration: they are the only guidance
    // the model gets on what a parameter means, and several of these tools have
    // parameters (background_tolerance, format) that are unusable without them.
    if (spec?.description) field = field.describe(spec.description);

    if (!required.has(key)) field = field.optional();

    shape[key] = field;
  }

  return shape;
}
