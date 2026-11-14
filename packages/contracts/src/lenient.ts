import { z } from 'zod';

/**
 * The same schema, but every object in it drops keys it does not know instead of refusing the whole value.
 *
 * Our schemas are `.strict()` on purpose where the data is ours: a typo in a saved file or an IPC call should fail
 * loudly. A model's reply is different. Models add a field or two that nobody asked for ("technology", "notes"), and
 * refusing a whole good answer over an extra key sends the person an error about nothing. Required fields, value
 * types, lengths and refinements are all still enforced; only unrecognised keys are ignored.
 *
 * Use it where the input is a model's JSON, never where it is a person's or the app's own data.
 */
const cache = new WeakMap<object, z.ZodTypeAny>();

type Def = Record<string, unknown> & { typeName?: string };

export function lenient<T extends z.ZodTypeAny>(schema: T): T {
  const cached = cache.get(schema);
  if (cached) return cached as T;
  const result = rebuild(schema);
  cache.set(schema, result);
  return result as T;
}

function rebuild(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = schema._def as Def;
  switch (def.typeName) {
    case 'ZodObject': {
      const original = (schema as z.AnyZodObject).shape;
      const shape = Object.fromEntries(Object.entries(original as Record<string, z.ZodTypeAny>).map(([key, value]) => [key, lenient(value)]));
      return new z.ZodObject({ ...(def as object), shape: () => shape, unknownKeys: 'strip' } as never);
    }
    case 'ZodArray':
      return new z.ZodArray({ ...(def as object), type: lenient(def.type as z.ZodTypeAny) } as never);
    case 'ZodOptional':
      return new z.ZodOptional({ ...(def as object), innerType: lenient(def.innerType as z.ZodTypeAny) } as never);
    case 'ZodNullable':
      return new z.ZodNullable({ ...(def as object), innerType: lenient(def.innerType as z.ZodTypeAny) } as never);
    case 'ZodDefault':
      return new z.ZodDefault({ ...(def as object), innerType: lenient(def.innerType as z.ZodTypeAny) } as never);
    case 'ZodCatch':
      return new z.ZodCatch({ ...(def as object), innerType: lenient(def.innerType as z.ZodTypeAny) } as never);
    case 'ZodEffects':
      return new z.ZodEffects({ ...(def as object), schema: lenient(def.schema as z.ZodTypeAny) } as never);
    case 'ZodUnion':
      return new z.ZodUnion({ ...(def as object), options: (def.options as z.ZodTypeAny[]).map((option) => lenient(option)) } as never);
    case 'ZodRecord':
      return new z.ZodRecord({ ...(def as object), valueType: lenient(def.valueType as z.ZodTypeAny) } as never);
    case 'ZodTuple':
      return new z.ZodTuple({ ...(def as object), items: (def.items as z.ZodTypeAny[]).map((item) => lenient(item)) } as never);
    case 'ZodIntersection':
      return new z.ZodIntersection({ ...(def as object), left: lenient(def.left as z.ZodTypeAny), right: lenient(def.right as z.ZodTypeAny) } as never);
    case 'ZodLazy':
      return new z.ZodLazy({ ...(def as object), getter: () => lenient((def.getter as () => z.ZodTypeAny)()) } as never);
    case 'ZodDiscriminatedUnion': {
      const options = (def.options as z.ZodObject<z.ZodRawShape>[]).map((option) => lenient(option) as z.ZodObject<z.ZodRawShape>);
      return z.discriminatedUnion(def.discriminator as string, options as unknown as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]]);
    }
    default:
      return schema;
  }
}

/** `lenient` for a schema-shaped value that might not be a zod schema at all (a structural `safeParse` stand-in). */
export function lenientIfZod<T>(schema: T): T {
  return schema && typeof schema === 'object' && '_def' in (schema as object) && typeof (schema as { safeParse?: unknown }).safeParse === 'function'
    ? lenient(schema as unknown as z.ZodTypeAny) as unknown as T
    : schema;
}
