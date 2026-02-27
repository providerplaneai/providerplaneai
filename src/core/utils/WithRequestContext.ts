import { v4 as uuidv4 } from "uuid";
import { AIRequest, AIResponse, AIResponseChunk } from "#root/index.js";

/**
 * Wraps a non-streaming async provider call with request-scoped context metadata.
 *
 * - Generates a unique requestId and start time
 * - Injects request context into the AIRequest
 * - Attaches timing and request metadata to the AIResponse
 *
 * Intended for provider implementations to ensure consistent tracing and observability.
 *
 * @template TInput - The input payload type sent to the provider
 * @template TOutput - The output payload type returned by the provider
 * @param req - Unified AI request containing input, options, and optional context
 * @param fn - Provider execution function to wrap
 * @returns A promise resolving to a unified AIResponse with metadata attached
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

    // Add request metadata to the response
    response.metadata = {
        ...(response.metadata || {}),
        requestId,
        timestamp: startTime,
        requestTimeMs: Date.now() - startTime
    };

    return response;
}

/**
 * Wraps a streaming async provider call (AsyncIterable) with request-scoped context metadata.
 *
 * This helper:
 * - Generates a unique requestId
 * - Captures start time
 * - Injects request context into the AIRequest
 * - Attaches timing and request metadata to each streamed chunk
 *
 * Designed for streaming chat, image generation, or any
 * provider API that emits incremental results.
 *
 * @template TInput - The input payload type sent to the provider
 * @template TOutput - The output payload type for each streamed chunk
 * @param req - Unified AI request containing input, options, and optional context
 * @param fn - Provider streaming execution function to wrap
 * @returns An AsyncGenerator emitting AIResponseChunk objects with metadata attached
 */
export async function* withRequestContextStream<TInput, TOutput>(
    req: AIRequest<TInput>,
    fn: (req: AIRequest<TInput>) => AsyncGenerator<AIResponseChunk<TOutput>>
): AsyncGenerator<AIResponseChunk<TOutput>> {
    const requestId = uuidv4();
    const startTime = Date.now();

    // Inject request context metadata into the request
    req.context = {
        ...(req.context || {}),
        requestId,
        metadata: {
            ...(req.context?.metadata || {}),
            startTime
        }
    };

    // Stream chunks while attaching request metadata
    for await (const chunk of fn(req)) {
        const now = Date.now();

        // Attach request context metadata to each chunk
        const chunkWithContext: AIResponseChunk<TOutput> = {
            ...chunk,
            metadata: {
                ...(chunk.metadata || {}),
                requestId,
                timestamp: now, //When this chunk was produced
                requestStartTime: startTime, // Start of the full request
                requestTimeMs: now - startTime // Time since request start
            }
        };

        yield chunkWithContext;
    }
}
