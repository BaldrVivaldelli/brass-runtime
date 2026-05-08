import type { HttpBody } from "./client";

export function httpBodyByteLength(body: HttpBody | undefined): number {
  if (body === undefined) return 0;
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof ArrayBuffer) return body.byteLength;
  return body.byteLength;
}

export function httpBodyToBuffer(body: HttpBody): Buffer {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(body);
}

export function httpBodyKeyPart(body: HttpBody | undefined): string {
  if (body === undefined) return "";
  if (typeof body === "string") return body;
  return `base64:${httpBodyToBuffer(body).toString("base64")}`;
}

