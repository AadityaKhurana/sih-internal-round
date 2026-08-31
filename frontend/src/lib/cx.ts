/** Minimal className joiner — drops falsy values. */
export function cx(
  ...parts: Array<string | false | null | undefined>
): string | undefined {
  const out = parts.filter(Boolean).join(' ');
  return out.length > 0 ? out : undefined;
}
