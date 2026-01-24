import { describe, it, expect } from 'vitest';
import { withRequestContext, withRequestContextStream } from '#root/core/utils/WithRequestContext.js';

describe('WithRequestContext', () => {
    it('withRequestContext attaches metadata and requestId', async () => {
        const req: any = { input: 'x' };
        const fn = async (r: any) => {
            // ensure requestId injected
            expect(r.context).toBeDefined();
            expect(r.context.requestId).toBeDefined();
            return { output: 'ok' } as any;
        };

        const resp = await withRequestContext(req, fn);
        expect(resp.metadata).toBeDefined();
        expect(resp.metadata?.requestId).toBeDefined();
        expect(req.context.requestId).toBe(resp.metadata?.requestId);
        expect(typeof resp.metadata?.requestTimeMs).toBe('number');
    });

    it('withRequestContextStream yields chunks with metadata and sets req.context', async () => {
        const req: any = { input: 'stream' };

        async function* providerStream(r: any) {
            // provider should see injected requestId
            expect(r.context.requestId).toBeDefined();
            yield { delta: 'a', done: false } as any;
            yield { delta: 'b', done: true } as any;
        }

        const chunks: any[] = [];
        for await (const c of withRequestContextStream(req, providerStream)) {
            expect(c.metadata).toBeDefined();
            expect(c.metadata?.requestId).toBeDefined();
            expect(typeof c.metadata?.requestTimeMs).toBe('number');
            chunks.push(c);
        }

        expect(chunks.length).toBe(2);
    });
});
