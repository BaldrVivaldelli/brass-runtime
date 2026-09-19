import type { HttpBody } from "./client";

export function httpBodyByteLength(body: HttpBody | undefined): number {
  if (body === undefined) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return body.byteLength;
}

export function httpBodyToBuffer(body: HttpBody): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

export function httpBodyKeyPart(body: HttpBody | undefined): string {
  if (body === undefined) return "";
  if (typeof body === "string") return body;
  return `base64:${bytesToBase64(httpBodyToBuffer(body))}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const maybeBuffer = (globalThis as typeof globalThis & {
    Buffer?: { from(value: Uint8Array): { toString(encoding: "base64"): string } };
  }).Buffer;
  if (maybeBuffer) return maybeBuffer.from(bytes).toString("base64");

  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
