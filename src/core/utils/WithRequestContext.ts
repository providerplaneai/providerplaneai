/**
 * @module core/utils/WithRequestContext.ts
 * @description Helpers for attaching request-scoped tracing metadata to capability calls.
 */
import { v4 as uuidv4 } from "uuid";
import { AIRequest, AIResponse, AIResponseChunk } from "#root/index.js";

/**
 * Wraps a non-streaming provider call with request-scoped tracing metadata.
 *
 * - Generates a unique requestId and start time
 * - Injects request context into the AIRequest
 * - Attaches timing and request metadata to the AIResponse
 *
 * Intended for provider implementations to ensure consistent tracing and observability across
 * capability adapters without duplicating request-timing logic.
 *
 * @template TInput - The input payload type sent to the provider.
 * @template TOutput - The output payload type returned by the provider.
 * @param {AIRequest<TInput>} req - Unified AI request containing input, options, and optional context.
 * @param {(req: AIRequest<TInput>) => Promise<AIResponse<TOutput>>} fn - Provider execution function to wrap.
 * @returns {Promise<AIResponse<TOutput>>} A promise resolving to a unified AIResponse with metadata attached.
 */
export async function withRequestContext<TInput, TOutput>(
    req: AIRequest<TInput>,
    fn: (req: AIRequest<TInput>) => Promise<AIResponse<TOutput>>
): Promise<AIResponse<TOutput>> {
    const requestId = uuidv4();
    const startTime = Date.now();

    // Mutate request context in-place so downstream provider code sees a single
    // consistent request envelope (same object reference across layers).
    req.context = {
        ...(req.context || {}),
        requestId,
        metadata: {
            ...(req.context?.metadata || {}),
            startTime
        }
    };

    const response = await fn(req);

    // Responses inherit the generated request identifier and elapsed timing so callers can correlate
    // provider output with the originating request envelope.
    response.metadata = {
        ...(response.metadata || {}),
        requestId,
        timestamp: startTime,
        requestTimeMs: Date.now() - startTime
    };

    return response;
}

/**
 * Wraps a streaming provider call with request-scoped tracing metadata.
 *
 * This helper:
 * - Generates a unique requestId
 * - Captures start time
 * - Injects request context into the AIRequest
 * - Attaches timing and request metadata to each streamed chunk
 *
 * Designed for streaming chat, image generation, or any provider API that emits incremental
 * results.
 *
 * @template TInput - The input payload type sent to the provider.
 * @template TOutput - The output payload type for each streamed chunk.
 * @param {AIRequest<TInput>} req - Unified AI request containing input, options, and optional context.
 * @param {(req: AIRequest<TInput>) => AsyncGenerator<AIResponseChunk<TOutput>>} fn - Provider streaming execution function to wrap.
 * @returns {AsyncGenerator<AIResponseChunk<TOutput>>} An async generator emitting response chunks with metadata attached.
 */
export async function* withRequestContextStream<TInput, TOutput>(
    req: AIRequest<TInput>,
    fn: (req: AIRequest<TInput>) => AsyncGenerator<AIResponseChunk<TOutput>>
): AsyncGenerator<AIResponseChunk<TOutput>> {
    const requestId = uuidv4();
    const startTime = Date.now();

    // Stream handlers mutate the shared request object for the same reason as the non-streaming
    // variant: all downstream layers should observe the same request envelope.
    req.context = {
        ...(req.context || {}),
        requestId,
        metadata: {
            ...(req.context?.metadata || {}),
            startTime
        }
    };

    // Each chunk receives timing metadata at emission time so consumers can measure stream latency
    // without reconstructing timing information themselves.
    for await (const chunk of fn(req)) {
        const now = Date.now();

        const chunkWithContext: AIResponseChunk<TOutput> = {
            ...chunk,
            metadata: {
                ...(chunk.metadata || {}),
                requestId,
                timestamp: now,
                requestStartTime: startTime,
                requestTimeMs: now - startTime
            }
        };

        yield chunkWithContext;
    }
}
