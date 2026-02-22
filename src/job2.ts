import path from "path";
import fs from "fs";

import { AIClient, AIClientTelemetryAggregator, AIRequest, AIResponse, CapabilityKeyType, ClientChatRequest, JobChunk, JobManager, JobSnapshot, logProviderAttempts, logRawBudgetDiagnostics, MultiModalExecutionContext, NormalizedChatMessage, summarizeSnapshot } from "#root/index.js";

const JOB_FILE = path.resolve("test_data/.jobs.json");

function persistJobs(snapshots: JobSnapshot<any, any>[]) {
    fs.writeFileSync(JOB_FILE, JSON.stringify(snapshots, null, 2), "utf8");
}

function loadPersistedJobs(): JobSnapshot<any, any>[] {
    if (!fs.existsSync(JOB_FILE)) {return [];}
    return JSON.parse(fs.readFileSync(JOB_FILE, "utf8"));
}



/**
 * Phase 1: Start jobs and simulate a crash.
 */
export const crashRecovery_example = async () => {
    console.log("=== Phase 1: Start jobs and simulate crash ===");

    const jobManager = new JobManager({
        persistJobs,
        loadPersistedJobs,
        hooks: {
            onStart: job => console.log(`[JobManager] started ${job.id}`),
            onProgress: (_chunk, job) => console.log(`[JobManager] job ${job.id} chunk`),
            onComplete: job => console.log(`[JobManager] completed ${job.id}`),
            onError: (err, job) => console.error(`[JobManager] error ${job.id}`, err)
        }
    });

    const client = new AIClient(jobManager);
    const ctx = new MultiModalExecutionContext();

    const prompts = [
        "Explain recursion in simple terms",
        "Write a limerick about TypeScript",
        "Summarize what a job queue is",
        "Give an analogy for async programming"
    ];

    const jobs = prompts.map((text, index) => {
        const request: ClientChatRequest = {
            messages: [{ role: "user", content: [{ type: "text", text }] }]
        };

        const job = client.createCapabilityJob("chatStream", { input: request });

        // Subscribe to status updates
        jobManager.subscribe(job.id, snapshot => {
            switch (snapshot.status) {
                case "pending":
                    console.log(`[Job ${index}] pending`);
                    break;
                case "running":
                    if (snapshot.streaming?.started) {
                        console.log(`[Job ${index}] running (chunks=${snapshot.streaming.chunksEmitted})`);
                    }
                    break;
                case "completed":
                    console.log(`[Job ${index}] COMPLETED`);
                    break;
                case "error":
                    console.error(`[Job ${index}] ERROR`, snapshot.error);
                    break;
                case "aborted":
                    console.warn(`[Job ${index}] ABORTED`);
                    break;
                case "interrupted":
                    console.warn(`[Job ${index}] INTERRUPTED`);
                    break;
            }
        });

        return job;
    });

    // Fire-and-forget: start all jobs concurrently
    for (const job of jobs) {
        jobManager.runJob(job.id, ctx, (chunk: JobChunk<NormalizedChatMessage>) => {
            if (chunk.delta?.content?.[0]?.type === "text") {
                process.stdout.write(chunk.delta.content[0].text);
            }
            if (chunk.final) {
                console.log("\n[Stream] Final chunk received");
            }
        });
    }

    console.log("All jobs started concurrently. Simulating crash in 9.1s...");

     //Simulate a SIGTERM / crash mid-execution
     setTimeout(() => {
         console.log("\n[SIMULATED CRASH] Process terminated unexpectedly!\n");
         process.exit(1);
     }, 9100);
};

/**
 * Phase 2: Restart process and recover incomplete jobs
 */
export const jobRecovery_example = async () => {
    console.log("=== Phase 2: Restart process and recover jobs ===");

    // Client used by the jobFactory to rebuild runnable jobs from persisted snapshots.
    const client = new AIClient();

  client.registerCapabilityExecutor("customEcho", {
    streaming: false,
    async invoke(_, input): Promise<AIResponse<any>> {
      return {
        output: "Echo!",
        rawResponse: { content: `Echoed: ${JSON.stringify(input.input)}` } as any,
        id: `customEcho-${Date.now()}`,
        metadata: {}
      };
    }
  });

    const jobManager = new JobManager({
        persistJobs,
        loadPersistedJobs,
        jobFactory: (snapshot) => {
            const capability = snapshot.capability;
            if (!capability) {
                throw new Error(
                    `Recovery snapshot '${snapshot.id}' is missing 'capability'. ` +
                    "Recreate jobs with current schema before attempting recovery."
                );
            }

            return client.createCapabilityJob(
                capability,
                snapshot.input as AIRequest<ClientChatRequest>,
                { addToManager: false, providerChain: snapshot.providerChain }
            );
        },
        hooks: {
            onStart: job => console.log(`[Recovery] started ${job.id}`),
            onProgress: (_chunk, job) => console.log(`[Recovery] job ${job.id} chunk`),
            onComplete: job => console.log(`[Recovery] completed ${job.id}`),
            onError: (err, job) => console.error(`[Recovery] error ${job.id}`, err)
        }
    });

    const ctx = new MultiModalExecutionContext();

    console.log("Jobs loaded from previous session:");
    for (const snapshot of jobManager.listJobs()) {
        const streamInfo = snapshot.streaming?.enabled
            ? `chunksEmitted=${snapshot.streaming?.chunksEmitted}, completed=${snapshot.streaming?.completed}`
            : "n/a";
        console.log(`- ${summarizeSnapshot(snapshot)}, streaming=${streamInfo}`);
    }

    const restarted: string[] = [];

    // Restart all incomplete jobs
    for (const snapshot of jobManager.listJobs()) {
        if (snapshot.status !== "completed" && snapshot.status !== "error" && snapshot.status !== "aborted") {
            console.log(`[Recovery] restarting job ${snapshot.id}`);
            restarted.push(snapshot.id);

            jobManager.runJob(snapshot.id, ctx, (chunk: JobChunk<NormalizedChatMessage>) => {
                const delta = chunk.delta as NormalizedChatMessage | undefined;
                if (delta?.content?.[0]?.type === "text") {
                    process.stdout.write(delta.content[0].text);
                }
                if (chunk.final) {
                    console.log("\n[Stream] Final chunk received");
                }
            });
        }
    }

    if (restarted.length === 0) {
        console.log("[Recovery] no jobs needed restart");
        return;
    }

    await Promise.allSettled(
        restarted
            .map(id => jobManager.getJob(id))
            .filter((job): job is NonNullable<typeof job> => !!job)
            .map(job => job.getCompletionPromise())
    );

    console.log("\n[Recovery] final snapshots:");
    for (const snapshot of jobManager.listJobs()) {
        console.log(`- ${summarizeSnapshot(snapshot)}`);
    }
};

export const runCustomCapabilityJob_example = async () => {
    console.log("=== Run a custom capability job ===");

    const jobManager = new JobManager({
        persistJobs,
        loadPersistedJobs,
        hooks: {
            onStart: job => console.log(`[Custom] started ${job.id}`),
            onProgress: (_chunk, job) => console.log(`[Custom] job ${job.id} chunk`),
            onComplete: job => console.log(`[Custom] completed ${job.id}`),
            onError: (err, job) => console.error(`[Custom] error ${job.id}`, err)
        }
    });

    const client = new AIClient(jobManager);

    client.setLifecycleHooks({
        onChunkEmitted: (ctx) => console.log(`[AI] Emitted ${ctx.chunkIndex} -> ${ctx.providerType}`),
        onExecutionStart: (ctx) => console.log(`[AI] Execution Start ${ctx}`),
        onExecutionFailure: (ctx) => console.log(`[AI] Execution Failure ${ctx}`),
        onExecutionEnd: (ctx) => console.log(`[AI] Execution End ${ctx}`),
        onAttemptStart: (ctx) => console.log(`[AI] Attempt ${ctx.attemptIndex} -> ${ctx.providerType}`),
        onAttemptSuccess: (ctx) => console.log(
            `[AI] Success ${ctx.providerType} in ${ctx.durationMs}ms ` +
            `(inputTokens=${ctx.inputTokens ?? "n/a"}, outputTokens=${ctx.outputTokens ?? "n/a"}, ` +
            `totalTokens=${ctx.totalTokens ?? "n/a"}, estimatedCost=${ctx.estimatedCost ?? "n/a"})`
        ),
        onAttemptFailure: (ctx) => console.warn(`[AI] Failure ${ctx.providerType}: ${ctx.error}`)
    });


    const ctx = new MultiModalExecutionContext();

    client.registerCapabilityExecutor("customEcho", {
        streaming: false,
        async invoke(_, input): Promise<AIResponse<any>> {
            console.log(`[CustomExecutor] Received input:`, input);

            // Return normalized response shape expected by callers
            return {
                output: "Echo!",
                rawResponse: { content: "Hello from custom executor!" } as any,
                id: `customEcho-${Date.now()}`,
                metadata: {
                    inputTokens: 12,
                    outputTokens: 4,
                    totalTokens: 16,
                    estimatedCost: 0.00011
                }
            };
        }
    });

    /* ---------------------------------------------
       Create the job
       --------------------------------------------- */

    const job = client.createCapabilityJob(
        "customEcho",
        {
            input: { message: "Hello from custom capability" }
        }
    );

    console.log(`[Example] Created job ${job.id}`);

    /* ---------------------------------------------
       RUN THE JOB
       --------------------------------------------- */

    jobManager.runJob(job.id, ctx);
    const result = await job.getCompletionPromise();

    console.log(`[Example] Job result:`, result);
    logProviderAttempts("Custom capability", job.response?.metadata as Record<string, any> | undefined);

    console.log("=== Gemini Chat ===");

    const request: ClientChatRequest = {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Explain quantum mechanics in 4 sentences" }]
            }
        ]
    };

    const job1 = client.createCapabilityJob<CapabilityKeyType, ClientChatRequest, NormalizedChatMessage>(
        "chat",
        { input: request },
        {
            // Intentionally fail first provider to demonstrate multi-attempt metadata.
            providerChain: [
                { providerType: "openai", connectionName: "missing-connection" },
                { providerType: "gemini", connectionName: "default" }
            ]
        }
    );

    jobManager.runJob(job1.id, ctx);

    const result2 = await job1.getCompletionPromise();

    console.log(`[Example] Gemini Chat result:`, result2);
    logProviderAttempts("Gemini chat with fallback", job1.response?.metadata as Record<string, any> | undefined);

    console.log(`[Example] Done`);
};

export const runCustomRagCapability_example = async () => {
    console.log("=== Run a custom RAG capability job ===");

    const jobManager = new JobManager({
        persistJobs,
        loadPersistedJobs,
        hooks: {
            onStart: job => console.log(`[RAG] started ${job.id}`),
            onProgress: (_chunk, job) => console.log(`[RAG] job ${job.id} chunk`),
            onComplete: job => console.log(`[RAG] completed ${job.id}`),
            onError: (err, job) => console.error(`[RAG] error ${job.id}`, err)
        }
    });

    const client = new AIClient(jobManager);
    const telemetry = new AIClientTelemetryAggregator();
    client.setLifecycleHooks(telemetry.createHooks());
    const ctx = new MultiModalExecutionContext();

    // Test chat

   /* const request: ClientChatRequest = {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "How does provider fallback work with custom capabilities?" }]
            }
        ]
    };
*/
   /* const job1 = client.createCapabilityJob<CapabilityKeyType, ClientChatRequest, NormalizedChatMessage>(
        "chat",
        { input: request },
        {
            // Intentionally fail first provider to demonstrate multi-attempt metadata.
            providerChain: [
                { providerType: "openai", connectionName: "default" },
                { providerType: "gemini", connectionName: "default" }
            ]
        }    
    );
*/

    //const result1 = await job1.getCompletionPromise();


    type RagInput = { query: string; topK?: number };
    type RagDoc = { id: string; text: string };
    type RagOutput = { answer: string; documents: RagDoc[] };

    const docs: RagDoc[] = [
        { id: "doc-1", text: "ProviderPlaneAI supports built-in and custom capabilities." },
        { id: "doc-2", text: "Jobs can be persisted and restored across process restarts." },
        { id: "doc-3", text: "Execution policies allow provider chain fallback behavior." },
        { id: "doc-4", text: "Lifecycle hooks expose attempts, timing, and telemetry metadata." }
    ];

    client.registerCapabilityExecutor("customRagSearch", {
        streaming: false,
        async invoke(_, input): Promise<AIResponse<RagOutput>> {
            const query = String((input.input as RagInput)?.query ?? "").toLowerCase().trim();
            const topK = Number((input.input as RagInput)?.topK ?? 2);
            const queryTerms = query.split(/\s+/).filter(Boolean);

            const ranked = docs
                .map(doc => ({
                    doc,
                    score: queryTerms.reduce((acc, term) => acc + (doc.text.toLowerCase().includes(term) ? 1 : 0), 0)
                }))
                .sort((a, b) => b.score - a.score)
                .slice(0, Math.max(1, topK))
                .map(x => x.doc);

            const answer = ranked.length
                ? `Based on retrieved docs: ${ranked.map(d => d.text).join(" ")}`
                : "No relevant documents were retrieved.";

            return {
                output: { answer, documents: ranked },
                rawResponse: {
                    usage: {
                        prompt_tokens: 42,
                        completion_tokens: 29,
                        total_tokens: 71
                    }
                },
                id: `customRagSearch-${Date.now()}`,
                metadata: {
                    estimatedCost: 0.00042
                }
            };
        }
    });

    const job = client.createCapabilityJob<"customRagSearch", RagInput, RagOutput>(
        "customRagSearch",
        { input: { query: "How does provider fallback work with custom capabilities?", topK: 3 } }
    );

    jobManager.runJob(job.id, ctx);
    const result = await job.getCompletionPromise();

    console.log("[RAG] result:", JSON.stringify(result, null, 2));
    logProviderAttempts("Custom RAG", job.response?.metadata as Record<string, any> | undefined);
    console.log("[RAG] telemetry:", JSON.stringify(telemetry.getSummary(), null, 2));
    console.log(`[RAG] done`);
};

export const runRawPayloadBudget_example = async () => {
    console.log("=== Raw payload retention budget example ===");

    const jobManager = new JobManager({
        storeRawResponses: true,
        maxRawBytesPerJob: 200
    });

    const client = new AIClient(jobManager);
    const ctx = new MultiModalExecutionContext();

    type LargeRawInput = { message: string };
    type LargeRawOutput = { ok: boolean };

    client.registerCapabilityExecutor("customLargeRaw", {
        streaming: false,
        async invoke(_, input): Promise<AIResponse<LargeRawOutput>> {
            const payload = String((input.input as LargeRawInput)?.message ?? "");
            const largeRaw = {
                providerDump: payload.repeat(20)
            };
            return {
                output: { ok: true },
                rawResponse: largeRaw,
                id: `customLargeRaw-${Date.now()}`,
                metadata: {}
            };
        }
    });

    const limitedJob = client.createCapabilityJob<"customLargeRaw", LargeRawInput, LargeRawOutput>(
        "customLargeRaw",
        { input: { message: "abcdefghijklmnopqrstuvwxyz" } },
        {
            maxRawBytesPerJob: 120
        }
    );

    jobManager.runJob(limitedJob.id, ctx);
    await limitedJob.getCompletionPromise();

    console.log(`[RawBudget] limited rawResponse kept: ${limitedJob.response?.rawResponse !== undefined}`);
    logRawBudgetDiagnostics("RawBudget limited", limitedJob.response?.metadata as Record<string, any> | undefined);

    const disabledJob = client.createCapabilityJob<"customLargeRaw", LargeRawInput, LargeRawOutput>(
        "customLargeRaw",
        { input: { message: "abcdefghijklmnopqrstuvwxyz" } },
        {
            storeRawResponses: false
        }
    );

    jobManager.runJob(disabledJob.id, ctx);
    await disabledJob.getCompletionPromise();

    console.log(`[RawBudget] disabled rawResponse kept: ${disabledJob.response?.rawResponse !== undefined}`);
    logRawBudgetDiagnostics("RawBudget disabled", disabledJob.response?.metadata as Record<string, any> | undefined);
};
