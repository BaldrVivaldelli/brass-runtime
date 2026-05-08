// src/http/prewarm/validation.ts — Origin string validation and normalization.

/**
 * Validates and normalizes an origin string.
 *
 * A valid origin is: scheme + host + optional port (e.g., "https://api.example.com" or "http://localhost:3000").
 * Trailing slashes are stripped. Paths, query strings, and fragments are rejected.
 *
 * @param origin - The origin string to validate.
 * @returns The normalized origin string.
 * @throws Error if the origin is invalid.
 */
export function validateOrigin(origin: string): string {
  if (!origin || typeof origin !== "string") {
    throw new Error(`validateOrigin: origin must be a non-empty string, got "${origin}"`);
  }

  const trimmed = origin.trim();
  if (!trimmed) {
    throw new Error(`validateOrigin: origin must be a non-empty string, got "${origin}"`);
  }

  // Strip trailing slashes for normalization
  const stripped = trimmed.replace(/\/+$/, "");

  // Must have a scheme
  if (!/^https?:\/\//i.test(stripped)) {
    throw new Error(
      `validateOrigin: invalid origin "${origin}" — must start with http:// or https://`,
    );
  }

  // Parse with URL to validate structure
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    throw new Error(
      `validateOrigin: invalid origin "${origin}" — must be a valid URL origin (scheme + host + optional port)`,
    );
  }

  // Reject if there's a path beyond "/"
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `validateOrigin: invalid origin "${origin}" — must not contain a path`,
    );
  }

  // Reject query strings
  if (parsed.search) {
    throw new Error(
      `validateOrigin: invalid origin "${origin}" — must not contain query parameters`,
    );
  }

  // Reject fragments
  if (parsed.hash) {
    throw new Error(
      `validateOrigin: invalid origin "${origin}" — must not contain a fragment`,
    );
  }

  // Return the normalized origin (scheme + host + port)
  return parsed.origin;
}
