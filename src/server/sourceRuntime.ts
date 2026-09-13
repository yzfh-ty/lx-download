// Timers and requests must have the same lifetime as their custom source VM.
export class SourceRuntime {
    disposed = false
    private timers = new Map<number, ReturnType<typeof setTimeout>>()
    private requests = new Set<() => void>()
    private pending = new Set<(error: Error) => void>()

    private createTimer(repeat: boolean, callback: (...args: any[]) => void, delay?: number, ...args: any[]) {
        if (this.disposed) return undefined
        const timer = (repeat ? setInterval : setTimeout)(() => {
            if (!repeat) this.timers.delete(Number(timer))
            if (!this.disposed) callback(...args)
        }, delay)
        this.timers.set(Number(timer), timer)
        return timer
    }

    setTimeout = (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => (
        this.createTimer(false, callback, delay, ...args)
    )

    setInterval = (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => (
        this.createTimer(true, callback, delay, ...args)
    )

    clearTimer = (timer: ReturnType<typeof setTimeout> | number | string | undefined) => {
        if (timer === undefined) return
        const id = Number(timer)
        const handle = this.timers.get(id)
        if (handle === undefined) return
        this.timers.delete(id)
        clearTimeout(handle)
    }

    trackRequest(cancel: () => void) {
        if (this.disposed) {
            cancel()
            return
        }
        this.requests.add(cancel)
    }

    finishRequest(cancel: () => void) {
        this.requests.delete(cancel)
    }

    // Reject callers when a source is unloaded, including handlers waiting on
    // a timer or HTTP request that disposal will cancel.
    waitFor<T>(result: T | PromiseLike<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (this.disposed) {
                reject(new Error('自定义源已卸载'))
                return
            }
            this.pending.add(reject)
            Promise.resolve(result).then(value => {
                this.pending.delete(reject)
                resolve(value)
            }, error => {
                this.pending.delete(reject)
                reject(error)
            })
        })
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        for (const timer of this.timers.values()) clearTimeout(timer)
        this.timers.clear()
        for (const cancel of this.requests) {
            try { cancel() } catch { /* Continue releasing the remaining requests. */ }
        }
        this.requests.clear()
        for (const reject of this.pending) reject(new Error('自定义源已卸载'))
        this.pending.clear()
    }
}
