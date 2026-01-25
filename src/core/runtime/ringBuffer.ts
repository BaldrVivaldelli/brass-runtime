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
        const init = Math.max(2, this.nextPow2(initialCapacity));
        const max = Math.max(init, this.nextPow2(maxCapacity));
        this.buf = new Array<T | undefined>(init);
        this.maxCap = max;
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
        this.buf.fill(undefined);
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

    private nextPow2(n: number): number {
        let x = 1;
        while (x < n) x <<= 1;
        return x;
    }
}
