export async function* abortableStream<T>(iterable: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
    const iterator = iterable[Symbol.asyncIterator]();

    const onAbort = () => {
        // nothing — just cancel next race
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error("Stream aborted");
            }

            const result = await Promise.race([
                iterator.next(),
                new Promise<never>((_, reject) => {
                    if (signal?.aborted) {
                        reject(new Error("Stream aborted"));
                    }
                })
            ]);

            if ((result as IteratorResult<T>).done) {
                break;
            }
            yield (result as IteratorResult<T>).value;
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
        if (iterator.return) {
            await iterator.return(); // close underlying stream
        }
    }
}
