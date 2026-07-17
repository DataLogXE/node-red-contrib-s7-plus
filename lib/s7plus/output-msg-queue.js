'use strict';

/**
 * Bounded queue of ready Node-RED output messages ({ payload, timestamp }).
 *
 * Notifications are decoded synchronously; only node.send is deferred and
 * batched via setImmediate as node.send([...]).
 */

const DEFAULT_MAX_QUEUE = 100;

class OutputMsgQueue {
    /**
     * @param {(batch: object[]) => void} flushFn
     * @param {object} [opts]
     * @param {number} [opts.maxQueue]
     * @param {(info: { dropped: number, remaining: number }) => void} [opts.onOverflow]
     */
    constructor(flushFn, opts = {}) {
        this._flush = flushFn;
        this._maxQueue = opts.maxQueue > 0 ? opts.maxQueue : DEFAULT_MAX_QUEUE;
        this._onOverflow = typeof opts.onOverflow === 'function' ? opts.onOverflow : null;
        /** @type {object[]} */
        this._queue = [];
        this._drainScheduled = false;
        this.totalEnqueued = 0;
        this.totalFlushed = 0;
        this.droppedByHalf = 0;
        this.maxQueueDepth = 0;
    }

    get queueDepth() {
        return this._queue.length;
    }

    /**
     * Queue one output message for batched send.
     * @param {{ payload: *, timestamp: Date }} msg
     */
    enqueue(msg) {
        if (!msg) return;
        if (this._queue.length >= this._maxQueue) {
            const dropCount = Math.floor(this._queue.length / 2);
            if (dropCount > 0) {
                this._queue.splice(0, dropCount);
                this.droppedByHalf += dropCount;
                if (this._onOverflow) {
                    this._onOverflow({ dropped: dropCount, remaining: this._queue.length });
                }
            }
        }
        this._queue.push(msg);
        this.totalEnqueued++;
        if (this._queue.length > this.maxQueueDepth) {
            this.maxQueueDepth = this._queue.length;
        }
        this._scheduleDrain();
    }

    /** Drop pending messages (node close / unsubscribe). */
    reset() {
        this._queue.length = 0;
        this._drainScheduled = false;
    }

    _scheduleDrain() {
        if (this._drainScheduled) return;
        this._drainScheduled = true;
        setImmediate(() => this._drain());
    }

    _drain() {
        this._drainScheduled = false;
        if (this._queue.length === 0) return;

        const batch = this._queue.splice(0);
        try {
            this._flush(batch);
            this.totalFlushed += batch.length;
        } catch {
            /* ignore — same as endpoint notification callback */
        }
        if (this._queue.length) this._scheduleDrain();
    }
}

module.exports = { OutputMsgQueue, DEFAULT_MAX_QUEUE };
