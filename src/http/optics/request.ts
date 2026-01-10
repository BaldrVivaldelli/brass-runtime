import type { HttpRequest } from "../client"
import { Lens } from "./lens"

export const Request = {
    headers: Lens.make<HttpRequest, Record<string, string>>(
        (req) => req.headers ?? {},
        (headers) => (req) => ({ ...req, headers })
    ),
}

// Helpers “DX”, usando la lens
export const setHeader =
    (k: string, v: string) =>
        (req: HttpRequest): HttpRequest =>
            Lens.over(Request.headers, (h) => ({ ...h, [k]: v }))(req)

export const removeHeader =
    (k: string) =>
        (req: HttpRequest): HttpRequest =>
            Lens.over(Request.headers, (h) => {
                const { [k]: _, ...rest } = h
                return rest
            })(req)

export const mergeHeaders =
    (extra: Record<string, string>) =>
        (req: HttpRequest): HttpRequest =>
            Lens.over(Request.headers, (h) => ({ ...h, ...extra }))(req)


export const mergeHeadersUnder =
    (under: Record<string, string>) =>
        (req: HttpRequest): HttpRequest =>
            Lens.over(Request.headers, (h) => ({ ...under, ...h }))(req)


export const setHeaderIfMissing =
    (k: string, v: string) =>
        (req: HttpRequest): HttpRequest =>
            Lens.over(Request.headers, (h) => (h[k] ? h : { ...h, [k]: v }))(req)
