import type {
    AgentAction,
    AgentActionType,
    ApprovalCapability,
    ApprovalRequest,
    ApprovalResponse,
} from "./types";

export const DEFAULT_APPROVAL_TTL_MS = 60_000;
export const MAX_APPROVAL_TTL_MS = 5 * 60_000;

const SHA256_ROUND_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, bits: number): number =>
    (value >>> bits) | (value << (32 - bits));

/** Dependency-free SHA-256 for capability binding; works in Node and editor hosts. */
export function sha256Hex(value: string): string {
    const input = new TextEncoder().encode(value);
    const bitLength = input.length * 8;
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(input);
    bytes[input.length] = 0x80;
    const view = new DataView(bytes.buffer);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    view.setUint32(paddedLength - 8, high, false);
    view.setUint32(paddedLength - 4, low, false);

    const state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);

    for (let offset = 0; offset < bytes.length; offset += 64) {
        for (let index = 0; index < 16; index++) {
            words[index] = view.getUint32(offset + index * 4, false);
        }
        for (let index = 16; index < 64; index++) {
            const previous15 = words[index - 15];
            const previous2 = words[index - 2];
            const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
            const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
            words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
        }

        let [a, b, c, d, e, f, g, h] = state;
        for (let index = 0; index < 64; index++) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        state[0] = (state[0] + a) >>> 0;
        state[1] = (state[1] + b) >>> 0;
        state[2] = (state[2] + c) >>> 0;
        state[3] = (state[3] + d) >>> 0;
        state[4] = (state[4] + e) >>> 0;
        state[5] = (state[5] + f) >>> 0;
        state[6] = (state[6] + g) >>> 0;
        state[7] = (state[7] + h) >>> 0;
    }

    return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

const actionPayload = (action: AgentAction): string => {
    switch (action.type) {
        case "fs.readFile": return JSON.stringify([action.type, action.path]);
        case "fs.exists": return JSON.stringify([action.type, action.path]);
        case "fs.searchText": return JSON.stringify([action.type, action.query, action.globs ?? []]);
        case "shell.exec": return JSON.stringify([action.type, action.command, action.cwd ?? null]);
        case "llm.complete": return JSON.stringify([action.type, action.purpose, action.prompt]);
        case "patch.propose": return JSON.stringify([action.type, action.patch]);
        case "patch.apply": return JSON.stringify([action.type, action.patch]);
        case "patch.rollback": return JSON.stringify([action.type, action.patch, action.automatic ?? false, action.reason ?? null]);
        case "agent.finish": return JSON.stringify([action.type, action.summary]);
        case "agent.fail": return JSON.stringify([action.type, action.reason]);
    }
};

export const hashAgentAction = (action: AgentAction): string => sha256Hex(actionPayload(action));

export function makeApprovalCapability(options: {
    readonly action: AgentAction;
    readonly workspaceId: string;
    readonly goalId: string;
    readonly issuedAt: number;
    readonly ttlMs?: number;
}): ApprovalCapability {
    const ttlMs = Math.min(Math.max(1, options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS), MAX_APPROVAL_TTL_MS);
    const operationHash = hashAgentAction(options.action);
    const expiresAt = options.issuedAt + ttlMs;
    const capabilityId = sha256Hex(JSON.stringify([
        options.workspaceId,
        options.goalId,
        options.action.type,
        operationHash,
        options.issuedAt,
        expiresAt,
    ])).slice(0, 32);
    return Object.freeze({
        version: 1,
        capabilityId,
        workspaceId: options.workspaceId,
        goalId: options.goalId,
        actionType: options.action.type,
        operationHash,
        issuedAt: options.issuedAt,
        expiresAt,
    });
}

export const approveApprovalRequest = (request: ApprovalRequest): ApprovalResponse => ({
    type: "approved",
    capability: request.capability,
});

export function validateApprovalCapability(
    response: ApprovalResponse,
    request: ApprovalRequest,
    now: number,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
    if (response.type !== "approved") return { valid: false, reason: response.reason ?? "Approval rejected" };
    const actual = response.capability;
    const expected = request.capability;
    if (actual.version !== 1) return { valid: false, reason: "Unsupported approval capability version" };
    for (const key of ["capabilityId", "workspaceId", "goalId", "actionType", "operationHash", "issuedAt", "expiresAt"] as const) {
        if (actual[key] !== expected[key]) return { valid: false, reason: `Approval capability ${key} mismatch` };
    }
    if (now < actual.issuedAt) return { valid: false, reason: "Approval capability is not active yet" };
    if (now > actual.expiresAt) return { valid: false, reason: "Approval capability expired" };
    if (actual.expiresAt - actual.issuedAt > MAX_APPROVAL_TTL_MS) {
        return { valid: false, reason: "Approval capability lifetime exceeds policy" };
    }
    if (actual.actionType !== request.action.type || actual.operationHash !== hashAgentAction(request.action)) {
        return { valid: false, reason: "Approval capability is not bound to this operation" };
    }
    return { valid: true };
}

export const approvalActionType = (capability: ApprovalCapability): AgentActionType => capability.actionType;
