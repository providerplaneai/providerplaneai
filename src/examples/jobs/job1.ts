import fs from "fs";
import path from "path";
import { CapabilityKeyType, ClientChatRequest, JobChunk, JobManager, JobSnapshot, MultiModalExecutionContext, NormalizedChatMessage } from "#root/index.js";
import { AIClient } from "#root/index.js";

const JOB_FILE = path.resolve("test_data/.jobs.json");

export function persistJobs(snapshots: JobSnapshot<any, any>[]) {
    fs.writeFileSync(JOB_FILE, JSON.stringify(snapshots, null, 2), "utf8");
}

export function loadPersistedJobs(): JobSnapshot<any, any>[] {
    if (!fs.existsSync(JOB_FILE)) return [];
    return JSON.parse(fs.readFileSync(JOB_FILE, "utf8"));
}

export const job1_example = async () => {

    const jobManager = new JobManager({
        persistJobs,
        loadPersistedJobs,
        hooks: {
            onStart: job => console.log("Job started:", job.id),
            onProgress: (chunk, job) => console.log("Chunk:", chunk, job.id),
            onComplete: job => console.log("Job completed:", job.id),
            onError: (err, job) => console.error("Job failed:", job.id, err)
        }
    });

    const client = new AIClient(jobManager);

    const request: ClientChatRequest = {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Explain quantum mechanics in 10 sentences" }]
            }
        ]
    };


    const job = client.createCapabilityJob(
        "chat",
        { input: request },
        { streaming: false }
    );

    // Run it
    const ctx = new MultiModalExecutionContext();

    jobManager.runJob(job.id, ctx);

    return await job.getCompletionPromise();
}

export const job1_streaming_example = async () => {

    const jobManager = new JobManager({
        persistJobs,
        loadPersistedJobs,
        hooks: {
            onStart: job => console.log("Job started:", job.id),
            //onProgress: (chunk, job) => console.log("Chunk:", chunk, job.id),
            onComplete: job => console.log("Job completed:", job.id),
            onError: (err, job) => console.error("Job failed:", job.id, err)
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


    const request: ClientChatRequest = {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Explain quantum mechanics in 10 sentences" }]
            }
        ]
    };


    const job1 = client.createCapabilityJob<CapabilityKeyType, ClientChatRequest, NormalizedChatMessage>(
        "chatStream",
        { input: request },
        { streaming: true }
    );

    const ctx1 = new MultiModalExecutionContext();

    jobManager.runJob(job1.id, ctx1, (chunk: JobChunk<NormalizedChatMessage>) => {
        console.log("Received chunk:", chunk);
        if (chunk.delta) {
            process.stdout.write(
                (chunk.delta.content?.[0] as any).text ?? ""
            );
        }
        if (chunk.final) {
            console.log("\n\nFinal message received");
        }
    });

    await job1.getCompletionPromise();

    // Second job (demonstrates persistence / reuse)

    const request2: ClientChatRequest = {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Tell me a story about a cat in 4 lines" }]
            }
        ]
    };

    const job2 = client.createCapabilityJob<CapabilityKeyType, ClientChatRequest, NormalizedChatMessage>(
        "chatStream",
        { input: request2 },
        { streaming: true }
    );

    const ctx2 = new MultiModalExecutionContext();

    jobManager.runJob(job2.id, ctx2, (chunk: JobChunk<NormalizedChatMessage>) => {
        if (chunk.delta) {
            process.stdout.write(
                (chunk.delta.content?.[0] as any).text ?? ""
            );
        }
        if (chunk.final) {
            console.log("\n\nFinal message received");
        }
    });

    const result2 = await job2.getCompletionPromise();
    return result2;
}

/**
 * Demonstrates:
 * - background job execution
 * - live progress via subscribe()
 * - streaming chunks
 * - awaiting completion separately
 */
export const job_background_example = async () => {
    const jobManager = new JobManager({
        maxConcurrency: 1,
        hooks: {
            onStart: job => console.log("[JobManager] Started:", job.id),
            onComplete: job => console.log("[JobManager] Completed:", job.id),
            onError: (err, job) =>
                console.error("[JobManager] Failed:", job.id, err)
        }
    });

    const client = new AIClient(jobManager);

    const request = {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Explain black holes in 5 sentences" }]
            }
        ]
    };

    const job = client.createCapabilityJob(
        "chatStream",
        { input: request },
        { streaming: true }
    );

    const ctx = new MultiModalExecutionContext();

    // 🔔 Subscribe BEFORE starting the job
    const unsubscribe = jobManager.subscribe(job.id, snapshot => {
        console.log(
            `[Subscriber] Job ${snapshot.id} → ${snapshot.status}`
        );

        if (snapshot.streaming?.chunksEmitted !== undefined) {
            console.log(
                `  chunks: ${snapshot.streaming.chunksEmitted}`
            );
        }
    });

    // 🚀 Start job in the background (NON-BLOCKING)
    jobManager.runJob(job.id, ctx, (chunk: JobChunk<unknown>) => {
        const delta = chunk.delta as NormalizedChatMessage | undefined;
        if (delta?.content?.[0]?.type === "text") {
            process.stdout.write(delta.content[0].text);
        }

        if (chunk.final) {
            console.log("\n\n[Stream] Final chunk received");
        }
    });

    console.log("[Main] Job started in background — doing other work...\n");

    // ⏳ Await completion explicitly (optional)
    //const result = await job.getCompletionPromise();

    console.log("\n[Main] Job finished with result:");
    // console.dir(result, { depth: null });

    //unsubscribe();

    // return result;
};

/**
 * Example: Launch several background jobs concurrently.
 * No awaits on completion. All jobs run in parallel.
 */
export const multiple_background_jobs_example = async () => {
    const jobManager = new JobManager({
        hooks: {
            onStart: job => console.log(`[JobManager] started ${job.id}`),
            onComplete: job => console.log(`[JobManager] completed ${job.id}`),
            onError: (err, job) => console.error(`[JobManager] error ${job.id}`, err),
        }
    });

    const client = new AIClient(jobManager);
    const ctx = new MultiModalExecutionContext();

    const prompts = [
        "Explain recursion in simple terms",
        "Write a limerick about TypeScript",
        "Summarize what a job queue is",
        "Give an analogy for async programming",
    ];

    const jobs = prompts.map((text, index) => {
        const request: ClientChatRequest = {
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text }]
                }
            ]
        };

        const job = client.createCapabilityJob(
            "chatStream",
            { input: request },
            { streaming: true }
        );

        jobManager.subscribe(job.id, (snapshot: JobSnapshot<any, any>) => {
            switch (snapshot.status) {
                case "pending":
                    console.log(`[Job ${index}] pending`);
                    break;

                case "running":
                    if (snapshot.streaming?.started) {
                        console.log(
                            `[Job ${index}] running (chunks=${snapshot.streaming.chunksEmitted})`
                        );
                    }
                    break;

                case "completed":
                    console.log(`\n[Job ${index}] COMPLETED`);
                    console.dir(snapshot.output, { depth: null });
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

    // 🚀 Fire-and-forget: start all jobs concurrently
    for (const job of jobs) {
        jobManager.runJob(job.id, ctx);
    }

    console.log("All background jobs launched concurrently.");
}

export const background_job_cancellation_example = async () => {
    const jobManager = new JobManager({
        hooks: {
            onStart: job => console.log(`[JobManager] started ${job.id}`),
            onComplete: job => console.log(`[JobManager] completed ${job.id}`),
            onError: (err, job) => console.error(`[JobManager] error ${job.id}`, err),
        }
    });

    const client = new AIClient(jobManager);
    const ctx = new MultiModalExecutionContext();

    const request: ClientChatRequest = {
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Write a very long, detailed explanation of how compilers work, step by step"
                    }
                ]
            }
        ]
    };

    const job = client.createCapabilityJob(
        "chatStream",
        { input: request },
        { streaming: true }
    );

    // Observe job lifecycle
    jobManager.subscribe(job.id, (snapshot: JobSnapshot<any, any>) => {
        switch (snapshot.status) {
            case "pending":
                console.log("[Job] pending");
                break;

            case "running":
                console.log(
                    `[Job] running (chunks=${snapshot.streaming?.chunksEmitted ?? 0})`
                );
                break;

            case "completed":
                console.log("[Job] COMPLETED (unexpected)");
                break;

            case "aborted":
                console.warn("[Job] ABORTED as expected");
                break;

            case "error":
                console.error("[Job] ERROR", snapshot.error);
                break;
        }
    });

    // 🚀 Start job in background
    jobManager.runJob(job.id, ctx, (chunk: JobChunk<unknown>) => {
        const delta = chunk.delta as NormalizedChatMessage | undefined;
        if (delta?.content?.[0]?.type === "text") {
            process.stdout.write(delta.content[0].text);
        }

        if (chunk.final) {
            console.log("\n\n[Stream] Final chunk received");
        }
    });

    // ⏱ Abort after a short delay (mid-stream)
    setTimeout(() => {
        console.log("\n>>> ABORTING JOB <<<\n");
        jobManager.abortJob(job.id, "User requested cancellation");
    }, 25000);
};