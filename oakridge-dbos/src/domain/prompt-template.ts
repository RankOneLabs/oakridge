/**
 * The one template form prompts use: `{{ key }}`, filled from named values.
 * The compiler has already refused a key the worker or review does not
 * declare, so an unknown key is left as written.
 */

/** A template value as its reader sees it: text as written, absence as `none`, anything else as JSON. */
export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function renderTemplate(template: string, values: { readonly [key: string]: unknown }): string {
  return template.replace(/\{\{([^}]*)\}\}/g, (placeholder, raw: string) => {
    const key = raw.trim();
    return Object.hasOwn(values, key) ? renderValue(values[key]) : placeholder;
  });
}
