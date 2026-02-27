import { describe, expect, it, vi } from "vitest";

const uuidMock = vi.hoisted(() => vi.fn(() => "req-123"));

vi.mock("uuid", () => ({
    v4: uuidMock
}));

import { withRequestContext, withRequestContextStream } from "#root/core/utils/WithRequestContext.js";

describe("WithRequestContext", () => {
    it("withRequestContext injects request context and appends response metadata", async () => {
        const req: any = {
            input: "x",
            context: {
                metadata: {
                    caller: "test"
                }
            }
        };

        const response = await withRequestContext(req, async (r) => {
            expect(r.context?.requestId).toBe("req-123");
            expect(r.context?.metadata?.startTime).toBeTypeOf("number");
            expect(r.context?.metadata?.caller).toBe("test");
            return {
                output: "ok",
                metadata: {
                    provider: "openai"
                }
            } as any;
        });

        expect(response.metadata?.provider).toBe("openai");
        expect(response.metadata?.requestId).toBe("req-123");
        expect(response.metadata?.timestamp).toBeTypeOf("number");
        expect(response.metadata?.requestTimeMs).toBeTypeOf("number");
    });

    it("withRequestContext works when request has no initial context", async () => {
        const req: any = { input: "x" };
        const response = await withRequestContext(req, async () => ({ output: "ok" } as any));

        expect(req.context.requestId).toBe("req-123");
        expect(req.context.metadata.startTime).toBeTypeOf("number");
        expect(response.metadata?.requestId).toBe("req-123");
    });

    it("withRequestContextStream injects context and annotates each chunk", async () => {
        const req: any = {
            input: "stream",
            context: {
                metadata: {
                    source: "suite"
                }
            }
        };

        async function* providerStream(r: any) {
            expect(r.context.requestId).toBe("req-123");
            expect(r.context.metadata.source).toBe("suite");

            yield { delta: "a", done: false } as any;
            yield {
                delta: "b",
                done: true,
                metadata: { chunkTag: "last" }
            } as any;
        }

        const out: any[] = [];
        for await (const chunk of withRequestContextStream(req, providerStream)) {
            out.push(chunk);
        }

        expect(out).toHaveLength(2);
        expect(out[0].metadata.requestId).toBe("req-123");
        expect(out[0].metadata.requestStartTime).toBeTypeOf("number");
        expect(out[0].metadata.requestTimeMs).toBeTypeOf("number");
        expect(out[1].metadata.chunkTag).toBe("last");
        expect(out[1].metadata.requestId).toBe("req-123");
    });

    it("withRequestContextStream handles empty streams", async () => {
        const req: any = { input: "stream" };

        async function* providerStream() {
            return;
        }

        const out: any[] = [];
        for await (const chunk of withRequestContextStream(req, providerStream as any)) {
            out.push(chunk);
        }

        expect(out).toEqual([]);
        expect(req.context.requestId).toBe("req-123");
    });
});
