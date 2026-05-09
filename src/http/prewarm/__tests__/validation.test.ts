import { describe, it, expect } from "vitest";
import { validateOrigin } from "../validation";

describe("Origin Validation Unit Tests", () => {
  it("accepts valid https origin", () => {
    expect(validateOrigin("https://api.example.com")).toBe("https://api.example.com");
  });

  it("accepts valid http origin", () => {
    expect(validateOrigin("http://localhost")).toBe("http://localhost");
  });

  it("accepts origin with port", () => {
    expect(validateOrigin("https://api.example.com:8443")).toBe("https://api.example.com:8443");
  });

  it("accepts http origin with port", () => {
    expect(validateOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("strips trailing slashes", () => {
    expect(validateOrigin("https://api.example.com/")).toBe("https://api.example.com");
    expect(validateOrigin("https://api.example.com///")).toBe("https://api.example.com");
  });

  it("rejects paths", () => {
    expect(() => validateOrigin("https://api.example.com/v1")).toThrow("must not contain a path");
    expect(() => validateOrigin("https://api.example.com/api/users")).toThrow("must not contain a path");
  });

  it("rejects missing scheme", () => {
    expect(() => validateOrigin("api.example.com")).toThrow("must start with http:// or https://");
    expect(() => validateOrigin("ftp://api.example.com")).toThrow("must start with http:// or https://");
  });

  it("rejects empty string", () => {
    expect(() => validateOrigin("")).toThrow("must be a non-empty string");
  });

  it("rejects whitespace-only string", () => {
    expect(() => validateOrigin("   ")).toThrow("must be a non-empty string");
  });

  it("rejects query parameters", () => {
    expect(() => validateOrigin("https://api.example.com?key=value")).toThrow("must not contain query parameters");
  });

  it("rejects fragments", () => {
    expect(() => validateOrigin("https://api.example.com#section")).toThrow("must not contain a fragment");
  });

  it("normalizes to lowercase scheme and host", () => {
    const result = validateOrigin("HTTPS://API.EXAMPLE.COM");
    expect(result).toBe("https://api.example.com");
  });

  it("trims whitespace", () => {
    expect(validateOrigin("  https://api.example.com  ")).toBe("https://api.example.com");
  });
});
