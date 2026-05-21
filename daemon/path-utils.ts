import { readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Claude and Cursor both encode project paths by replacing ALL non-alphanumeric
// characters (including '.' and '-') with '-'.
// e.g. /Users/timothy.green/personal/Diktat → -Users-timothy-green-personal-Diktat (Claude)
//                                            →  Users-timothy-green-personal-Diktat (Cursor, no leading -)
// Decoding is lossy so we walk the filesystem to resolve each segment unambiguously.

function resolveEncodedRelative(base: string, relEncoded: string): string {
  if (!relEncoded) return base;
  const remaining = relEncoded.startsWith("-") ? relEncoded.slice(1) : relEncoded;
  if (!remaining) return base;

  try {
    const entries = readdirSync(base);
    const candidates = entries
      .map((name) => ({ name, encoded: name.replace(/[^a-zA-Z0-9]/g, "-") }))
      .filter(({ encoded }) => remaining === encoded || remaining.startsWith(encoded + "-"))
      .sort((a, b) => b.encoded.length - a.encoded.length);

    if (candidates.length > 0) {
      const { name, encoded } = candidates[0];
      const rest = remaining.slice(encoded.length);
      return resolveEncodedRelative(join(base, name), rest);
    }
  } catch { /* not readable */ }

  return join(base, remaining.replace(/-/g, "/"));
}

// Decode a Claude-style encoded path (leading '-' = leading '/')
export function decodeClaudePath(encoded: string): string {
  const home = homedir();
  const homeEncoded = home.replace(/[^a-zA-Z0-9]/g, "-"); // e.g. "-Users-timothy-green"
  if (!encoded.startsWith(homeEncoded)) {
    return "/" + encoded.slice(1).replace(/-/g, "/");
  }
  return resolveEncodedRelative(home, encoded.slice(homeEncoded.length));
}

// Decode a Cursor-style encoded path (no leading '-', root '/' implied)
export function decodeCursorPath(slug: string): string {
  const home = homedir();
  // homeEncoded without leading '-', e.g. "Users-timothy-green"
  const homeEncoded = home.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-/, "");
  if (!slug.startsWith(homeEncoded)) {
    return "/" + slug.replace(/-/g, "/");
  }
  return resolveEncodedRelative(home, slug.slice(homeEncoded.length));
}
