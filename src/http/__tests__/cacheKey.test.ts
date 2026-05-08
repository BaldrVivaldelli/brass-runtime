import { describe, expect, it } from "vitest";
import {
  computeCacheKey,
  parseCacheKey,
  SEPARATOR,
  DEFAULT_CACHE_RELEVANT_HEADERS,
  type CacheKeyComponents,
} from "../lifecycle/cacheKey";
import type { HttpRequest } from "../client";

describe("cacheKey", () => {
  const baseUrl = "https://api.example.com";

  describe("computeCacheKey", () => {
    it("serializes method, resolved URL, headers, and body with null separator", () => {
      const req: HttpRequest = {
        method: "GET",
        url: "/users",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: undefined,
      };

      const key = computeCacheKey(req, baseUrl);
      const parts = key.split(SEPARATOR);

      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe("GET");
      expect(parts[1]).toBe("https://api.example.com/users");
      // headers sorted alphabetically by key
      expect(parts[2]).toBe("accept:application/json,content-type:application/json");
      expect(parts[3]).toBe("");
    });

    it("uppercases the method", () => {
      const req: HttpRequest = { method: "GET", url: "/test" };
      const key = computeCacheKey(req, baseUrl);
      expect(key.startsWith("GET")).toBe(true);
    });

    it("resolves relative URL against baseUrl", () => {
      const req: HttpRequest = { method: "GET", url: "/path" };
      const key = computeCacheKey(req, baseUrl);
      expect(key).toContain("https://api.example.com/path");
    });

    it("treats undefined headers as empty record", () => {
      const req: HttpRequest = { method: "GET", url: "/test" };
      const key = computeCacheKey(req, baseUrl);
      const parts = key.split(SEPARATOR);
      expect(parts[2]).toBe("");
    });

    it("treats undefined body as empty string", () => {
      const req: HttpRequest = { method: "GET", url: "/test" };
      const key = computeCacheKey(req, baseUrl);
      const parts = key.split(SEPARATOR);
      expect(parts[3]).toBe("");
    });

    it("includes body when present", () => {
      const req: HttpRequest = {
        method: "POST",
        url: "/test",
        body: '{"name":"test"}',
      };
      const key = computeCacheKey(req, baseUrl);
      const parts = key.split(SEPARATOR);
      expect(parts[3]).toBe('{"name":"test"}');
    });

    it("filters out non-relevant headers", () => {
      const req: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: {
          "content-type": "application/json",
          "x-custom": "value",
          "x-request-id": "123",
        },
      };
      const key = computeCacheKey(req, baseUrl);
      const parts = key.split(SEPARATOR);
      expect(parts[2]).toBe("content-type:application/json");
      expect(parts[2]).not.toContain("x-custom");
      expect(parts[2]).not.toContain("x-request-id");
    });

    it("includes extra headers when specified", () => {
      const req: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: {
          "content-type": "application/json",
          "x-api-key": "secret",
        },
      };
      const key = computeCacheKey(req, baseUrl, ["X-Api-Key"]);
      const parts = key.split(SEPARATOR);
      expect(parts[2]).toContain("x-api-key:secret");
    });

    it("sorts headers alphabetically", () => {
      const req: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: {
          "content-type": "text/plain",
          authorization: "Bearer token",
          accept: "text/html",
        },
      };
      const key = computeCacheKey(req, baseUrl);
      const parts = key.split(SEPARATOR);
      expect(parts[2]).toBe(
        "accept:text/html,authorization:Bearer token,content-type:text/plain"
      );
    });

    it("produces identical keys regardless of header insertion order", () => {
      const req1: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: { accept: "json", "content-type": "text/plain" },
      };
      const req2: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: { "content-type": "text/plain", accept: "json" },
      };
      expect(computeCacheKey(req1, baseUrl)).toBe(computeCacheKey(req2, baseUrl));
    });
  });

  describe("parseCacheKey", () => {
    it("reconstructs components from a cache key string", () => {
      const req: HttpRequest = {
        method: "GET",
        url: "/users",
        headers: { accept: "application/json", "content-type": "text/plain" },
        body: "hello",
      };
      const key = computeCacheKey(req, baseUrl);
      const parsed = parseCacheKey(key);

      expect(parsed.method).toBe("GET");
      expect(parsed.resolvedUrl).toBe("https://api.example.com/users");
      expect(parsed.headers).toEqual({
        accept: "application/json",
        "content-type": "text/plain",
      });
      expect(parsed.body).toBe("hello");
    });

    it("handles empty headers string", () => {
      const key = `GET${SEPARATOR}https://example.com${SEPARATOR}${SEPARATOR}body`;
      const parsed = parseCacheKey(key);
      expect(parsed.headers).toEqual({});
      expect(parsed.body).toBe("body");
    });

    it("handles body containing null characters", () => {
      const bodyWithSeparator = `part1${SEPARATOR}part2`;
      const key = `POST${SEPARATOR}https://example.com${SEPARATOR}content-type:json${SEPARATOR}${bodyWithSeparator}`;
      const parsed = parseCacheKey(key);
      expect(parsed.body).toBe(bodyWithSeparator);
    });

    it("round-trips with computeCacheKey", () => {
      const req: HttpRequest = {
        method: "POST",
        url: "/api/data",
        headers: { "content-type": "application/json", accept: "*/*" },
        body: '{"key":"value"}',
      };
      const key = computeCacheKey(req, baseUrl);
      const parsed = parseCacheKey(key);

      expect(parsed.method).toBe("POST");
      expect(parsed.resolvedUrl).toBe("https://api.example.com/api/data");
      expect(parsed.body).toBe('{"key":"value"}');
    });
  });

  describe("DEFAULT_CACHE_RELEVANT_HEADERS", () => {
    it("contains accept, authorization, and content-type", () => {
      expect(DEFAULT_CACHE_RELEVANT_HEADERS).toEqual([
        "accept",
        "authorization",
        "content-type",
      ]);
    });
  });

  describe("SEPARATOR", () => {
    it("is the null character", () => {
      expect(SEPARATOR).toBe("\u0000");
    });
  });
});
