export type Canceler = () => void;

export type CancelToken = {
    /** true si ya fue cancelado */
    readonly isCancelled: () => boolean;

    /**
     * Registra un callback que se ejecuta cuando se cancela.
     * Si ya estaba cancelado, lo ejecuta inmediatamente.
     * Devuelve un "unsubscribe" para desregistrar.
     */
    readonly onCancel: (f: Canceler) => Canceler;
};

/** Implementación simple de CancelToken */
export function makeCancelToken(): CancelToken & { cancel: Canceler } {
    let cancelled = false;
    const listeners = new Set<Canceler>();

    const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        // ejecuta y limpia
        for (const f of listeners) {
            try { f(); } catch { /* opcional: log */ }
        }
        listeners.clear();
    };

    return {
        isCancelled: () => cancelled,
        onCancel: (f: Canceler) => {
            if (cancelled) {
                // si ya está cancelado, ejecuta inmediatamente
                try { f(); } catch { /* opcional */ }
                return () => {};
            }
            listeners.add(f);
            return () => { listeners.delete(f); };
        },
        cancel,
    };
}

/**
 * Helper: conecta un AbortController a un CancelToken.
 * Devuelve una función para desenganchar (unsubscribe).
 */
export function linkAbortController(token: CancelToken, ac: AbortController): Canceler {
    return token.onCancel(() => ac.abort());
}
