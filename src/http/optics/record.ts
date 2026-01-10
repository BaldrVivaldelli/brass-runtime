// src/http/optics/record.ts
import { Lens } from "./lens"

export const atKey = (key: string) =>
    Lens.make<Record<string, string>, string | undefined>(
        (r) => r[key],
        (v) => (r) => {
            if (v === undefined) {
                const { [key]: _, ...rest } = r
                return rest
            }
            return { ...r, [key]: v }
        }
    )
