// ringBuffer.ts
export const enum PushStatus {
    Ok = 0,
    Grew = 1 << 0,
    Dropped = 1 << 1,
}

export class RingBuffer<T> {
    private buf: (T | undefined)[];
    private head = 0;
    private tail = 0;
    private size_ = 0;

    // nuevo
    private readonly maxCap: number;

    constructor(initialCapacity: number = 1024, maxCapacity: number = initialCapacity) {
        // Inline nextPow2: operaciones de bits directas en lugar de método separado
        let initPow = Math.max(2, initialCapacity);
        initPow--;
        initPow |= initPow >>> 1;
        initPow |= initPow >>> 2;
        initPow |= initPow >>> 4;
        initPow |= initPow >>> 8;
        initPow |= initPow >>> 16;
        initPow++;

        let maxPow = Math.max(initPow, maxCapacity);
        maxPow--;
        maxPow |= maxPow >>> 1;
        maxPow |= maxPow >>> 2;
        maxPow |= maxPow >>> 4;
        maxPow |= maxPow >>> 8;
        maxPow |= maxPow >>> 16;
        maxPow++;

        this.buf = new Array<T | undefined>(initPow);
        this.maxCap = maxPow;
    }

    get length(): number { return this.size_; }
    get capacity(): number { return this.buf.length; }
    isEmpty(): boolean { return this.size_ === 0; }

    push(value: T): PushStatus {
        if (this.size_ === this.buf.length) {
            // lleno
            if (this.buf.length >= this.maxCap) {
                return PushStatus.Dropped;
            }
            this.grow(); // crece (hasta maxCap)
            // ojo: grow() ajusta head/tail/buf
            this.buf[this.tail] = value;
            this.tail = (this.tail + 1) & (this.buf.length - 1);
            this.size_++;
            return (PushStatus.Ok | PushStatus.Grew);
        }

        this.buf[this.tail] = value;
        this.tail = (this.tail + 1) & (this.buf.length - 1);
        this.size_++;
        return PushStatus.Ok;
    }

    shift(): T | undefined {
        if (this.size_ === 0) return undefined;
        const value = this.buf[this.head];
        this.buf[this.head] = undefined;
        this.head = (this.head + 1) & (this.buf.length - 1);
        this.size_--;
        return value;
    }

    clear(): void {
        // No hacer buf.fill(undefined) - los valores se sobrescriben en push
        this.head = 0;
        this.tail = 0;
        this.size_ = 0;
    }

    private grow(): void {
        const old = this.buf;
        const nextLen = Math.min(old.length * 2, this.maxCap);
        const newBuf = new Array<T | undefined>(nextLen);

        for (let i = 0; i < this.size_; i++) {
            newBuf[i] = old[(this.head + i) & (old.length - 1)];
        }

        this.buf = newBuf;
        this.head = 0;
        this.tail = this.size_;
    }
}
