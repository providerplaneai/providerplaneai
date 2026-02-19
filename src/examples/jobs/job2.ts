import path from "path";
import fs from "fs";

import { AIClient, AIProvider, AIResponse, CapabilityKeys, CapabilityKeyType, ClientChatRequest, JobChunk, JobManager, JobSnapshot, MultiModalExecutionContext, NormalizedChatMessage } from "#root/index.js";
import { OpenAI } from "openai";

const JOB_FILE = path.resolve("test_data/.jobs.json");

function persistJobs(snapshots: JobSnapshot<any, any>[]) {
    fs.writeFileSync(JOB_FILE, JSON.stringify(snapshots, null, 2), "utf8");
}

function loadPersistedJobs(): JobSnapshot<any, any>[] {
    if (!fs.existsSync(JOB_FILE)) return [];
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
            onProgress: (chunk, job) => console.log(`[JobManager] job ${job.id} chunk`),
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

    // Simulate a SIGTERM / crash mid-execution
    /* setTimeout(() => {
         console.log("\n[SIMULATED CRASH] Process terminated unexpectedly!\n");
         process.exit(1);
     }, 9100);*/
};

/**
 * Phase 2: Restart process and recover incomplete jobs
 */
export const jobRecovery_example = async () => {
    console.log("=== Phase 2: Restart process and recover jobs ===");

    const jobManager = new JobManager({
        persistJobs,
        loadPersistedJobs,
        hooks: {
            onStart: job => console.log(`[Recovery] started ${job.id}`),
            onProgress: (chunk, job) => console.log(`[Recovery] job ${job.id} chunk`),
            onComplete: job => console.log(`[Recovery] completed ${job.id}`),
            onError: (err, job) => console.error(`[Recovery] error ${job.id}`, err)
        }
    });

    const client = new AIClient(jobManager);
    const ctx = new MultiModalExecutionContext();

    console.log("Jobs loaded from previous session:");
    for (const snapshot of jobManager.listJobs()) {
        console.log(`- Job ${snapshot.id}: status=${snapshot.status}, streaming=${snapshot.streaming?.enabled ? `chunksEmitted=${snapshot.streaming?.chunksEmitted}, completed=${snapshot.streaming?.completed}` : "n/a"}`);
    }

    // Restart all incomplete jobs
    for (const snapshot of jobManager.listJobs()) {
        if (snapshot.status !== "completed" && snapshot.status !== "error" && snapshot.status !== "aborted") {
            console.log(`[Recovery] restarting job ${snapshot.id}`);

            const job = jobManager.getJob(snapshot.id)!;

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
};

export const runCustomCapabilityJob_example = async () => {
    console.log("=== Run a custom capability job ===");

    const jobManager = new JobManager({
        persistJobs,
        loadPersistedJobs,
        hooks: {
            onStart: job => console.log(`[Custom] started ${job.id}`),
            onProgress: (chunk, job) => console.log(`[Custom] job ${job.id} chunk`),
            onComplete: job => console.log(`[Custom] completed ${job.id}`),
            onError: (err, job) => console.error(`[Custom] error ${job.id}`, err)
        }
    });

    const client = new AIClient(jobManager);

    client.setLifeCycleHooks({
        onChunkEmitted: (ctx) => console.log(`[AI] Emitted ${ctx.chunkIndex} → ${ctx.providerType}`),
        onExecutionStart: (ctx) => console.log(`[AI] Execution Start ${ctx}`),
        onExecutionFailure: (ctx) => console.log(`[AI] Execution Failure ${ctx}`),
        onExecutionEnd: (ctx) => console.log(`[AI] Execution End ${ctx}`),
        onAttemptStart: (ctx) => console.log(`[AI] Attempt ${ctx.attemptIndex} → ${ctx.providerType}`),
        onAttemptSuccess: (ctx) => console.log(`[AI] Success ${ctx.providerType} in ${ctx.durationMs}ms`),
        onAttemptFailure: (ctx) => console.warn(`[AI] Failure ${ctx.providerType}: ${ctx.error}`)
    });


    const ctx = new MultiModalExecutionContext();

    client.registerCapabilityExecutor("customEcho", {
        streaming: false,
        async invoke(_, input, ctx, signal): Promise<AIResponse<any>> {
            console.log(`[CustomExecutor] Received input:`, input);

            // Return normalized response shape expected by callers
            return {
                output: "Echo!",
                rawResponse: {content: "Hello from custom executor!"} as any,
                id: `customEcho-${Date.now()}`,
                metadata: {
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
            input: { message: "Hello from custom capability 👋" }
        }
    );

    console.log(`[Example] Created job ${job.id}`);

    /* ---------------------------------------------
       RUN THE JOB 🚀
       --------------------------------------------- */

    jobManager.runJob(job.id, ctx);

    const result = await job.getCompletionPromise();

    console.log(`[Example] Job result:`, result);

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
        { providerChain: [{ providerType: "gemini", connectionName: "default" }] }
    );

    jobManager.runJob(job1.id, ctx);

    const result2 = await job1.getCompletionPromise();

    console.log(`[Example] Gemini Chat result:`, result2);

    console.log(`[Example] Done`);
};