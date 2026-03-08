import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProviderType, BaseProvider, ProviderRef, StreamingExecutor } from "#root/index.js";

async function loadClient() {
    vi.doUnmock("#root/index.js");
    vi.resetModules();
    const root = await import("#root/index.js");
    const { AIClient } = await import("#root/client/AIClient.js");
    return { AIClient, root };
}

function makeProvider(
    capabilitySupport: (capability: string) => boolean = () => false,
    initialized = false
): BaseProvider & {
    init: ReturnType<typeof vi.fn>;
    setClientExecutors: ReturnType<typeof vi.fn>;
} {
    return {
        isInitialized: vi.fn(() => initialized),
        init: vi.fn(),
        hasCapability: vi.fn((capability: string) => capabilitySupport(capability)),
        getCapability: vi.fn(() => ({})),
        setClientExecutors: vi.fn()
    } as unknown as BaseProvider & {
        init: ReturnType<typeof vi.fn>;
        setClientExecutors: ReturnType<typeof vi.fn>;
    };
}

describe("AIClient", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("wires app config limits into an injected JobManager when unset", async () => {
        const { AIClient, root } = await loadClient();
        const manager = new root.JobManager();
        const client = new AIClient(manager, new root.CapabilityExecutorRegistry());

        expect(client.jobManager).toBe(manager);
        expect(manager.getMaxConcurrency()).toBe(128);
        expect(manager.getMaxQueueSize()).toBe(1024);
        expect(manager.getMaxStoredResponseChunks()).toBe(1024);
        expect(manager.getStoreRawResponses()).toBe(true);
        expect(manager.getStripBinaryPayloadsInSnapshotsAndTimeline()).toBe(true);
        expect(manager.getMaxRawBytesPerJob()).toBe(1048576);
    });

    it("does not overwrite injected JobManager limits when already set", async () => {
        const { AIClient, root } = await loadClient();
        const manager = new root.JobManager({
            maxConcurrency: 99,
            maxQueueSize: 199,
            maxStoredResponseChunks: 299,
            storeRawResponses: true,
            stripBinaryPayloadsInSnapshotsAndTimeline: true,
            maxRawBytesPerJob: 8192
        });

        new AIClient(manager, new root.CapabilityExecutorRegistry());

        expect(manager.getMaxConcurrency()).toBe(99);
        expect(manager.getMaxQueueSize()).toBe(199);
        expect(manager.getMaxStoredResponseChunks()).toBe(299);
        expect(manager.getStoreRawResponses()).toBe(true);
        expect(manager.getStripBinaryPayloadsInSnapshotsAndTimeline()).toBe(true);
        expect(manager.getMaxRawBytesPerJob()).toBe(8192);
    });

    it("setLifecycleHooks can only be called once", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        client.setLifecycleHooks({});

        expect(() => client.setLifecycleHooks({})).toThrow("Lifecycle hooks already set");
    });

    it("registerProvider initializes uninitialized provider and sets client executors", async () => {
        const { AIClient, root } = await loadClient();
        const executors = new root.CapabilityExecutorRegistry();
        const client = new AIClient(new root.JobManager(), executors);
        const provider = makeProvider();

        client.registerProvider(provider, root.AIProvider.OpenAI, "fallback");

        expect(provider.init).toHaveBeenCalledTimes(1);
        expect(provider.setClientExecutors).toHaveBeenCalledWith(executors.getExecutors());
        expect(client.getProvider(root.AIProvider.OpenAI, "fallback")).toBe(provider);
    });

    it("registerProvider does not call init if provider is already initialized", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const provider = makeProvider(() => false, true);

        client.registerProvider(provider, root.AIProvider.OpenAI, "fallback");

        expect(provider.init).not.toHaveBeenCalled();
    });

    it("registerProvider throws DuplicateProviderRegistrationError for duplicate registration", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const providerA = makeProvider();
        const providerB = makeProvider();

        client.registerProvider(providerA, root.AIProvider.OpenAI, "fallback");

        expect(() => client.registerProvider(providerB, root.AIProvider.OpenAI, "fallback")).toThrow(
            root.DuplicateProviderRegistrationError
        );
    });

    it("registerProvider throws ExecutionPolicyError when provider connection config is missing", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const provider = makeProvider();

        expect(() => client.registerProvider(provider, root.AIProvider.OpenAI, "missing")).toThrow(root.ExecutionPolicyError);
    });

    it("getProvider throws for unknown provider type", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());

        expect(() => client.getProvider("unknown-provider" as AIProviderType)).toThrow("No providers registered for unknown-provider");
    });

    it("findProvidersByCapability returns only providers that support the capability", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const cap = "custom:search";

        const supporting = makeProvider((c) => c === cap);
        client.registerProvider(supporting, root.AIProvider.OpenAI, "fallback");

        const found = client.findProvidersByCapability(cap as any);
        expect(found).toContain(supporting);
        expect(found.length).toBeGreaterThanOrEqual(1);
    });

    it("registerCapabilityExecutor propagates executor map to registered providers and blocks duplicates", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const provider = makeProvider();
        const capability = "custom:ingest";

        client.registerProvider(provider, root.AIProvider.OpenAI, "fallback");

        const executor = {
            streaming: false as const,
            invoke: vi.fn(async () => ({ output: { ok: true } }))
        };

        client.registerCapabilityExecutor(capability as any, executor);
        expect(provider.setClientExecutors).toHaveBeenCalledTimes(2); // once on provider registration, once on executor registration

        expect(() => client.registerCapabilityExecutor(capability as any, executor)).toThrow(
            `Executor for capability ${capability} is already registered`
        );
    });

    it("createCapabilityJob respects addToManager and stores capability/providerChain metadata in snapshot", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const capability = "custom:workflow";
        const providerChain: ProviderRef[] = [{ providerType: root.AIProvider.OpenAI, connectionName: "default" }];

        client.registerCapabilityExecutor(capability as any, {
            streaming: false as const,
            invoke: vi.fn(async () => ({ output: { ok: true } }))
        });

        const detachedJob = client.createCapabilityJob(capability as any, { input: { step: 1 } } as any, {
            addToManager: false,
            providerChain
        });

        const baseJobCount = client.jobManager.listJobs().length;
        expect(client.jobManager.listJobs().length).toBe(baseJobCount);
        expect(detachedJob.toSnapshot().capability).toBe(capability);
        expect(detachedJob.toSnapshot().providerChain).toEqual(providerChain);

        client.createCapabilityJob(capability as any, { input: { step: 2 } } as any);
        expect(client.jobManager.listJobs().length).toBe(baseJobCount + 1);
    });

    it("createCapabilityJob non-streaming builds fallback multimodal artifacts when result has output only", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager());
        const executeWithPolicySpy = vi.spyOn(client as any, "executeWithPolicy").mockResolvedValue({
            output: [{ vector: [1, 2, 3] }],
            metadata: { source: "test" }
        });

        const job = client.createCapabilityJob(root.CapabilityKeys.EmbedCapabilityKey, { input: { text: "hello" } } as any, {
            addToManager: false
        });

        await job.run(new root.MultiModalExecutionContext());

        expect(executeWithPolicySpy).toHaveBeenCalledTimes(1);
        expect(job.status).toBe("completed");
        expect(job.response?.multimodalArtifacts?.embeddings).toEqual([{ vector: [1, 2, 3] }]);
    });

    it("createCapabilityJob non-streaming preserves multimodalArtifacts returned from policy result", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        vi.spyOn(client as any, "executeWithPolicy").mockResolvedValue({
            output: "ignored-for-custom",
            multimodalArtifacts: { custom: [{ id: "artifact-1" }] }
        });

        const customCap = "custom:artifact-pass-through";
        client.registerCapabilityExecutor(customCap as any, {
            streaming: false as const,
            invoke: vi.fn(async () => ({ output: "x" }))
        });

        const job = client.createCapabilityJob(customCap as any, { input: { x: 1 } } as any, { addToManager: false });
        await job.run(new root.MultiModalExecutionContext());

        expect(job.status).toBe("completed");
        expect(job.response?.multimodalArtifacts).toEqual({ custom: [{ id: "artifact-1" }] });
    });

    it("createCapabilityJob streaming emits delta/final chunks and uses final chunk id/raw/metadata", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const customCap = "custom:stream-job";
        const streamExec: StreamingExecutor<any, unknown, string> = {
            streaming: true as const,
            invoke: (async function* (_capability, _input, _ctx, _signal) {
                yield { output: "unused" } as any;
            }) as StreamingExecutor<any, unknown, string>["invoke"]
        };
        client.registerCapabilityExecutor(customCap as any, streamExec);

        vi.spyOn(client as any, "executeWithPolicyStream").mockImplementation(async function* () {
            yield { delta: "hel", metadata: { stage: 1 } };
            yield { delta: "lo", metadata: { stage: 2 } };
            yield { output: "hello", id: "final-id", raw: { body: "raw-final" }, metadata: { stage: 3 } };
        });

        const emitted: any[] = [];
        const job = client.createCapabilityJob(customCap as any, { input: { p: 1 } } as any, { addToManager: false });
        await job.run(new root.MultiModalExecutionContext(), undefined, (chunk) => emitted.push(chunk));

        expect(job.status).toBe("completed");
        expect(emitted).toEqual([{ delta: "hel" }, { delta: "lo" }, { final: "hello" }]);
        expect(job.response?.id).toBe("final-id");
        expect(job.response?.rawResponse).toEqual({ body: "raw-final" });
        expect(job.response?.metadata).toMatchObject({ stage: 3 });
    });

    it("createCapabilityJob streaming errors when stream completes without final output", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const customCap = "custom:stream-no-final";
        const streamExec: StreamingExecutor<any, unknown, string> = {
            streaming: true as const,
            invoke: (async function* (_capability, _input, _ctx, _signal) {
                yield { output: "unused" } as any;
            }) as StreamingExecutor<any, unknown, string>["invoke"]
        };
        client.registerCapabilityExecutor(customCap as any, streamExec);

        vi.spyOn(client as any, "executeWithPolicyStream").mockImplementation(async function* () {
            yield { delta: "partial" };
        });

        const job = client.createCapabilityJob(customCap as any, { input: { p: 1 } } as any, { addToManager: false });
        await job.run(new root.MultiModalExecutionContext());
        await job.getCompletionPromise().catch(() => undefined);

        expect(job.status).toBe("error");
        expect(job.error?.message).toContain("stream completed without final output");
    });

    it("createCapabilityJob applies job-level retention options over manager defaults", async () => {
        const { AIClient, root } = await loadClient();
        const manager = new root.JobManager({
            maxStoredResponseChunks: 1,
            storeRawResponses: false,
            maxRawBytesPerJob: 1_000_000
        });
        const client = new AIClient(manager, new root.CapabilityExecutorRegistry());
        const customCap = "custom:stream-retention";
        const streamExec: StreamingExecutor<any, unknown, string> = {
            streaming: true as const,
            invoke: (async function* (_capability, _input, _ctx, _signal) {
                yield { output: "unused" } as any;
            }) as StreamingExecutor<any, unknown, string>["invoke"]
        };
        client.registerCapabilityExecutor(customCap as any, streamExec);

        vi.spyOn(client as any, "executeWithPolicyStream").mockImplementation(async function* () {
            yield { delta: "a", raw: { c: 1 } };
            yield { delta: "b", raw: { c: 2 } };
            yield { output: "done", raw: { c: 3 } };
        });

        const job = client.createCapabilityJob(
            customCap as any,
            { input: { x: 1 } } as any,
            {
                addToManager: false,
                maxStoredResponseChunks: 2,
                storeRawResponses: true
            }
        );
        await job.run(new root.MultiModalExecutionContext());

        expect(job.status).toBe("completed");
        expect(job.responseChunks).toHaveLength(2);
        expect(job.response?.rawResponse).toEqual({ c: 3 });
    });

    it("createCapabilityJob streaming builds fallback artifacts when stream returns final output without artifacts", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager());

        vi.spyOn(client as any, "executeWithPolicyStream").mockImplementation(async function* () {
            yield { output: { role: "assistant", content: [] }, id: "chat-final" };
        });

        const job = client.createCapabilityJob(
            root.CapabilityKeys.ChatStreamCapabilityKey,
            { input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } } as any,
            { addToManager: false }
        );

        await job.run(new root.MultiModalExecutionContext());

        expect(job.status).toBe("completed");
        expect(job.response?.id).toBe("chat-final");
        expect(job.response?.multimodalArtifacts?.chat).toEqual([{ role: "assistant", content: [] }]);
    });
});

describe("AIClient private policy execution", () => {
    it("executeWithPolicy returns first successful result and appends providerAttempts metadata", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const capability = "custom:policy";
        const ctx = new root.MultiModalExecutionContext();

        vi.spyOn(root, "withRequestContext").mockImplementation(async (_req, fn) => fn(_req));
        client.registerProvider(makeProvider((c) => c === capability), root.AIProvider.OpenAI, "fallback");
        const chain: ProviderRef[] = [{ providerType: root.AIProvider.OpenAI, connectionName: "fallback" }];

        const executeFn = vi.fn(async () => ({
            output: { ok: true },
            metadata: { requestTag: "x" }
        }));

        const hooks = {
            onExecutionStart: vi.fn(),
            onAttemptStart: vi.fn(),
            onAttemptSuccess: vi.fn(),
            onExecutionFailure: vi.fn(),
            onExecutionEnd: vi.fn()
        };
        client.setLifecycleHooks(hooks);

        const result = await (client as any).executeWithPolicy(capability, { input: { a: 1 } }, ctx, executeFn, chain);

        expect(executeFn).toHaveBeenCalledTimes(1);
        expect(result.output).toEqual({ ok: true });
        expect(result.metadata?.providerAttempts).toHaveLength(1);
        expect(hooks.onExecutionStart).toHaveBeenCalledTimes(1);
        expect(hooks.onAttemptStart).toHaveBeenCalledTimes(1);
        expect(hooks.onAttemptSuccess).toHaveBeenCalledTimes(1);
        expect(hooks.onExecutionFailure).not.toHaveBeenCalled();
        expect(hooks.onExecutionEnd).toHaveBeenCalledTimes(1);
    });

    it("executeWithPolicy throws ExecutionPolicyError when provider chain is empty", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const ctx = new root.MultiModalExecutionContext();

        await expect(
            (client as any).executeWithPolicy("custom:no-chain", { input: {} }, ctx, vi.fn(async () => ({ output: "x" })), [])
        ).rejects.toThrow(root.ExecutionPolicyError);
    });

    it("executeWithPolicy falls back to later provider when earlier attempt fails", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const capability = "custom:policy-fallback";
        const ctx = new root.MultiModalExecutionContext();

        vi.spyOn(root, "withRequestContext").mockImplementation(async (_req, fn) => fn(_req));
        client.registerProvider(makeProvider((c) => c === capability), root.AIProvider.OpenAI, "fallback");

        const chain: ProviderRef[] = [
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" },
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" }
        ];

        const executeFn = vi
            .fn()
            .mockRejectedValueOnce(new Error("p1 failed"))
            .mockResolvedValueOnce({ output: "ok-from-p2", metadata: {} });

        const result = await (client as any).executeWithPolicy(capability, { input: { a: 1 } }, ctx, executeFn, chain);

        expect(executeFn).toHaveBeenCalledTimes(2);
        expect(result.output).toBe("ok-from-p2");
        expect(result.metadata?.providerAttempts).toHaveLength(2);
    });

    it("executeWithPolicy preserves structured errorCode in sanitized providerAttempts metadata", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const ctx = new root.MultiModalExecutionContext();
        const capability = "custom:audio-code";

        vi.spyOn(root, "withRequestContext").mockImplementation(async (_req, fn) => fn(_req));
        client.registerProvider(makeProvider((c) => c === capability), root.AIProvider.OpenAI, "fallback");
        const chain: ProviderRef[] = [
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" },
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" }
        ];

        const audioErr = Object.assign(new Error("no audio"), { code: "AUDIO_EMPTY_RESPONSE" });
        const executeFn = vi
            .fn()
            .mockRejectedValueOnce(audioErr)
            .mockResolvedValueOnce({ output: "ok", metadata: {} });
        const result = await (client as any).executeWithPolicy(capability, { input: {} }, ctx, executeFn, chain);
        const attempts = result.metadata?.providerAttempts as Array<Record<string, unknown>>;

        expect(executeFn).toHaveBeenCalledTimes(2);
        expect(attempts).toHaveLength(2);
        expect(attempts[0].error).toBe("Provider attempt failed");
        expect(attempts[0].errorCode).toBe("AUDIO_EMPTY_RESPONSE");
        expect(attempts[1].error).toBeUndefined();
    });

    it("executeWithPolicy throws AllProvidersFailedError when all attempts fail", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const capability = "custom:policy-all-fail";
        const ctx = new root.MultiModalExecutionContext();

        vi.spyOn(root, "withRequestContext").mockImplementation(async (_req, fn) => fn(_req));
        client.registerProvider(makeProvider((c) => c === capability), root.AIProvider.OpenAI, "fallback");

        const chain: ProviderRef[] = [
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" },
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" }
        ];

        const executeFn = vi.fn(async () => {
            throw new Error("all failed");
        });

        await expect((client as any).executeWithPolicy(capability, { input: {} }, ctx, executeFn, chain)).rejects.toThrow(
            root.AllProvidersFailedError
        );
    });

    it("executeWithPolicyStream yields chunks and annotates final chunk with providerAttempts metadata", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const capability = "custom:stream";
        const ctx = new root.MultiModalExecutionContext();

        vi.spyOn(root, "withRequestContextStream").mockImplementation(async function* (_req, fn) {
            yield* fn(_req);
        });
        client.registerProvider(makeProvider((c) => c === capability), root.AIProvider.OpenAI, "fallback");
        const chain: ProviderRef[] = [{ providerType: root.AIProvider.OpenAI, connectionName: "fallback" }];

        const executeFn = vi.fn(async function* () {
            yield { delta: "hello " };
            yield { output: { done: true }, done: true, metadata: { source: "p1" } };
        });

        const chunks: any[] = [];
        for await (const chunk of (client as any).executeWithPolicyStream(capability, { input: {} }, ctx, executeFn, chain)) {
            chunks.push(chunk);
        }

        expect(chunks).toHaveLength(2);
        expect(chunks[0].delta).toBe("hello ");
        expect(chunks[1].output).toEqual({ done: true });
        expect(chunks[1].metadata?.providerAttempts).toHaveLength(1);
    });

    it("executeWithPolicyStream throws ExecutionPolicyError when provider chain is empty", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const ctx = new root.MultiModalExecutionContext();

        const collect = async () => {
            for await (const _chunk of (client as any).executeWithPolicyStream(
                "custom:no-chain-stream",
                { input: {} },
                ctx,
                vi.fn(async function* () {}),
                []
            )) {
                void _chunk;
            }
        };

        await expect(collect()).rejects.toThrow(root.ExecutionPolicyError);
    });

    it("executeWithPolicyStream falls back mid-stream and preserves emitted chunks", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const capability = "custom:stream-fallback";
        const ctx = new root.MultiModalExecutionContext();

        vi.spyOn(root, "withRequestContextStream").mockImplementation(async function* (_req, fn) {
            yield* fn(_req);
        });
        client.registerProvider(makeProvider((c) => c === capability), root.AIProvider.OpenAI, "fallback");

        const chain: ProviderRef[] = [
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" },
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" }
        ];

        const executeFn = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield { delta: "a" };
                throw new Error("stream broke");
            })
            .mockImplementationOnce(async function* () {
                yield { delta: "b" };
                yield { output: "final", done: true };
            });

        const chunks: any[] = [];
        for await (const chunk of (client as any).executeWithPolicyStream(capability, { input: {} }, ctx, executeFn, chain)) {
            chunks.push(chunk);
        }

        expect(chunks.map((c) => c.delta ?? c.output)).toEqual(["a", "b", "final"]);
        expect(chunks[2].metadata?.providerAttempts).toHaveLength(2);
    });

    it("executeWithPolicyStream throws AllProvidersFailedError when all stream attempts fail", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const capability = "custom:stream-all-fail";
        const ctx = new root.MultiModalExecutionContext();

        vi.spyOn(root, "withRequestContextStream").mockImplementation(async function* (_req, fn) {
            yield* fn(_req);
        });
        client.registerProvider(makeProvider((c) => c === capability), root.AIProvider.OpenAI, "fallback");

        const chain: ProviderRef[] = [
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" },
            { providerType: root.AIProvider.OpenAI, connectionName: "fallback" }
        ];

        const executeFn = vi.fn(async function* () {
            throw new Error("stream failed");
        });

        const collect = async () => {
            for await (const _chunk of (client as any).executeWithPolicyStream(capability, { input: {} }, ctx, executeFn, chain)) {
                void _chunk;
            }
        };

        await expect(collect()).rejects.toThrow(root.AllProvidersFailedError);
        expect(executeFn).toHaveBeenCalledTimes(2);
    });

    it("executeWithPolicy skips providers without capability and succeeds on next provider", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const capability = "custom:skip-no-cap";
        const ctx = new root.MultiModalExecutionContext();

        vi.spyOn(root, "withRequestContext").mockImplementation(async (_req, fn) => fn(_req));
        vi.spyOn(client.getProvider<any>(root.AIProvider.Gemini, "default"), "hasCapability").mockReturnValue(false);
        vi.spyOn(client.getProvider<any>(root.AIProvider.OpenAI, "default"), "hasCapability").mockImplementation((c) => c === capability);

        const executeFn = vi.fn(async () => ({ output: "ok", metadata: {} }));
        const result = await (client as any).executeWithPolicy(
            capability,
            { input: {} },
            ctx,
            executeFn,
            [
                { providerType: root.AIProvider.Gemini, connectionName: "default" },
                { providerType: root.AIProvider.OpenAI, connectionName: "default" }
            ]
        );

        expect(executeFn).toHaveBeenCalledTimes(1);
        expect(result.output).toBe("ok");
    });

    it("executeWithPolicyStream skips providers without capability and handles chunk-level errors with fallback", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry());
        const capability = "custom:stream-skip-and-error";
        const ctx = new root.MultiModalExecutionContext();

        vi.spyOn(root, "withRequestContextStream").mockImplementation(async function* (_req, fn) {
            yield* fn(_req);
        });
        vi.spyOn(client.getProvider<any>(root.AIProvider.Gemini, "default"), "hasCapability").mockReturnValue(false);
        vi.spyOn(client.getProvider<any>(root.AIProvider.OpenAI, "default"), "hasCapability").mockImplementation((c) => c === capability);
        vi.spyOn(client.getProvider<any>(root.AIProvider.Anthropic, "default"), "hasCapability").mockImplementation((c) => c === capability);

        const executeFn = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield { error: new Error("chunk error") };
            })
            .mockImplementationOnce(async function* () {
                yield { output: "final", done: true };
            });

        const chunks: any[] = [];
        for await (const chunk of (client as any).executeWithPolicyStream(
            capability,
            { input: {} },
            ctx,
            executeFn,
            [
                { providerType: root.AIProvider.Gemini, connectionName: "default" },
                { providerType: root.AIProvider.OpenAI, connectionName: "default" },
                { providerType: root.AIProvider.Anthropic, connectionName: "default" }
            ]
        )) {
            chunks.push(chunk);
        }

        expect(executeFn).toHaveBeenCalledTimes(2);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].output).toBe("final");
        expect(chunks[0].metadata?.providerAttempts).toHaveLength(2);
    });
});

describe("AIClient private helpers", () => {
    it("constructor without injected JobManager initializes internal manager", async () => {
        const { AIClient } = await loadClient();
        const client = new AIClient();
        expect(client.jobManager).toBeDefined();
    });

    it("createExecutionSignal reuses caller signal when no timeout and forwards abort", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry()) as any;

        const directController = new AbortController();
        const same = client.createExecutionSignal({ input: {}, signal: directController.signal });
        expect(same).toBe(directController.signal);

        const upstream = new AbortController();
        const forwarded = client.createExecutionSignal({ input: {}, signal: upstream.signal, timeoutMs: 1000 });
        expect(forwarded.aborted).toBe(false);
        upstream.abort("boom");
        expect(forwarded.aborted).toBe(true);

        const alreadyAborted = new AbortController();
        alreadyAborted.abort("already");
        const preAbortedForwarded = client.createExecutionSignal({
            input: {},
            signal: alreadyAborted.signal,
            timeoutMs: 1000
        });
        expect(preAbortedForwarded.aborted).toBe(true);
    });

    it("createExecutionSignal enforces timeout abort", async () => {
        vi.useFakeTimers();
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry()) as any;
        const signal: AbortSignal = client.createExecutionSignal({ input: {}, timeoutMs: 5 });

        expect(signal.aborted).toBe(false);
        vi.advanceTimersByTime(10);
        expect(signal.aborted).toBe(true);
        vi.useRealTimers();
    });

    it("helper methods cover modality, usage extraction, context application, artifact building, and artifact merge", async () => {
        const { AIClient, root } = await loadClient();
        const client = new AIClient(new root.JobManager(), new root.CapabilityExecutorRegistry()) as any;

        expect(client.modalityForCapability(root.CapabilityKeys.EmbedCapabilityKey)).toBe("embedding");
        expect(client.modalityForCapability(root.CapabilityKeys.ChatCapabilityKey)).toBe("chat");
        expect(client.modalityForCapability(root.CapabilityKeys.AudioTranscriptionCapabilityKey)).toBe("audio");
        expect(client.modalityForCapability(root.CapabilityKeys.VideoGenerationCapabilityKey)).toBe("video");
        expect(client.modalityForCapability(root.CapabilityKeys.VideoAnalysisCapabilityKey)).toBe("video");
        expect(client.modalityForCapability(root.CapabilityKeys.VideoDownloadCapabilityKey)).toBe("video");
        expect(client.modalityForCapability(root.CapabilityKeys.VideoExtendCapabilityKey)).toBe("video");
        expect(client.modalityForCapability(root.CapabilityKeys.VideoRemixCapabilityKey)).toBe("video");
        expect(client.modalityForCapability(root.CapabilityKeys.ModerationCapabilityKey)).toBe("moderation");
        expect(client.modalityForCapability(root.CapabilityKeys.ImageGenerationCapabilityKey)).toBe("image");
        expect(client.modalityForCapability(root.CapabilityKeys.ImageEditCapabilityKey)).toBe("image");
        expect(client.modalityForCapability(root.CapabilityKeys.ImageAnalysisCapabilityKey)).toBe("image");
        expect(client.modalityForCapability("custom:abc")).toBe("custom");

        expect(client.extractRawUsage(null)).toEqual({});
        expect(client.extractRawUsage({ usage: { total_tokens: 3 } })).toEqual({ total_tokens: 3 });
        expect(client.extractRawUsage({ usageMetadata: { totalTokenCount: 4 } })).toEqual({ totalTokenCount: 4 });
        expect(client.extractRawUsage({ any: "value" })).toEqual({});

        const extracted = client.extractAttemptUsage(
            { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimatedCost: 0.1 },
            { usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 } }
        );
        expect(extracted).toMatchObject({ inputTokens: 1, outputTokens: 2, totalTokens: 3, estimatedCost: 0.1 });

        const extractedFallback = client.extractAttemptUsage(
            {},
            { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8, totalTokenCount: 15 } }
        );
        expect(extractedFallback).toMatchObject({ inputTokens: 7, outputTokens: 8, totalTokens: 15 });

        const ctx = {
            applyAssistantMessage: vi.fn(),
            attachArtifacts: vi.fn()
        };
        client.applyOutputToContext(root.CapabilityKeys.ChatCapabilityKey, { role: "assistant", content: [] }, ctx);
        client.applyOutputToContext(root.CapabilityKeys.EmbedCapabilityKey, [{ vector: [1] }], ctx);
        client.applyOutputToContext(
            root.CapabilityKeys.AudioTranscriptionCapabilityKey,
            [{ kind: "transcription", mimeType: "audio/wav", transcript: "hello" }],
            ctx
        );
        client.applyOutputToContext(root.CapabilityKeys.ModerationCapabilityKey, [{ flagged: false }], ctx);
        client.applyOutputToContext(root.CapabilityKeys.VideoGenerationCapabilityKey, [{ id: "v", mimeType: "video/mp4" }], ctx);
        client.applyOutputToContext(root.CapabilityKeys.VideoAnalysisCapabilityKey, [{ id: "va", summary: "scene" }], ctx);
        client.applyOutputToContext(root.CapabilityKeys.VideoDownloadCapabilityKey, [{ id: "vd", mimeType: "video/mp4" }], ctx);
        client.applyOutputToContext(root.CapabilityKeys.VideoExtendCapabilityKey, [{ id: "ve", mimeType: "video/mp4" }], ctx);
        client.applyOutputToContext(root.CapabilityKeys.VideoRemixCapabilityKey, [{ id: "vr", mimeType: "video/mp4" }], ctx);
        client.applyOutputToContext(root.CapabilityKeys.ImageGenerationCapabilityKey, [{ id: "i" }], ctx);
        client.applyOutputToContext(root.CapabilityKeys.ImageAnalysisCapabilityKey, [{ id: "a" }], ctx);
        client.applyOutputToContext(root.CapabilityKeys.ImageEditStreamCapabilityKey, [{ id: "m" }], ctx);
        client.applyOutputToContext("custom:unknown", { any: true }, ctx);
        expect(ctx.applyAssistantMessage).toHaveBeenCalledTimes(1);
        expect(ctx.attachArtifacts).toHaveBeenCalledTimes(10);

        expect(client.buildArtifactsFromOutput(root.CapabilityKeys.ChatCapabilityKey, { role: "assistant", content: [] })).toHaveProperty("chat");
        expect(client.buildArtifactsFromOutput(root.CapabilityKeys.EmbedCapabilityKey, [{ vector: [1] }])).toHaveProperty("embeddings");
        expect(
            client.buildArtifactsFromOutput(root.CapabilityKeys.AudioTextToSpeechCapabilityKey, [
                { kind: "tts", mimeType: "audio/mpeg", base64: "AQID" }
            ])
        ).toHaveProperty("tts");
        expect(
            client.buildArtifactsFromOutput(root.CapabilityKeys.VideoGenerationCapabilityKey, [
                { id: "v", mimeType: "video/mp4" }
            ])
        ).toHaveProperty("video");
        expect(
            client.buildArtifactsFromOutput(root.CapabilityKeys.VideoAnalysisCapabilityKey, [
                { id: "va", summary: "scene" }
            ])
        ).toHaveProperty("videoAnalysis");
        expect(
            client.buildArtifactsFromOutput(root.CapabilityKeys.VideoDownloadCapabilityKey, [
                { id: "vd", mimeType: "video/mp4" }
            ])
        ).toHaveProperty("video");
        expect(
            client.buildArtifactsFromOutput(root.CapabilityKeys.VideoExtendCapabilityKey, [
                { id: "ve", mimeType: "video/mp4" }
            ])
        ).toHaveProperty("video");
        expect(
            client.buildArtifactsFromOutput(root.CapabilityKeys.VideoRemixCapabilityKey, [
                { id: "vr", mimeType: "video/mp4" }
            ])
        ).toHaveProperty("video");
        expect(client.buildArtifactsFromOutput(root.CapabilityKeys.ModerationCapabilityKey, [{ flagged: false }])).toHaveProperty("moderation");
        expect(client.buildArtifactsFromOutput(root.CapabilityKeys.ImageGenerationCapabilityKey, [{ id: "i" }])).toHaveProperty("images");
        expect(client.buildArtifactsFromOutput(root.CapabilityKeys.ImageAnalysisCapabilityKey, [{ id: "a" }])).toHaveProperty("imageAnalysis");
        expect(client.buildArtifactsFromOutput(root.CapabilityKeys.ImageEditStreamCapabilityKey, [{ id: "i" }])).toBeUndefined();
        expect(client.buildArtifactsFromOutput("custom:unknown", { a: 1 })).toBeUndefined();

        const target = { images: [{ id: "x" }] } as any;
        client.mergeTimelineArtifacts(target, {
            images: [{ id: "y" }],
            embeddings: [{ vector: [1] }],
            moderation: []
        });
        expect(target.images).toHaveLength(2);
        expect(target.embeddings).toHaveLength(1);

        const coded = client.extractAttemptErrorCode(Object.assign(new Error("no audio"), { code: "AUDIO_EMPTY_RESPONSE" }));
        const parsed = client.extractAttemptErrorCode(new Error("[AUDIO_OUTPUT_TOO_LARGE] too big"));
        expect(coded).toBe("AUDIO_EMPTY_RESPONSE");
        expect(parsed).toBe("AUDIO_OUTPUT_TOO_LARGE");
    });
});
