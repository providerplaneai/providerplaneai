/* istanbul ignore file */

/**
 * Temporary playground / test script.
 * Will be deleted before publishing for real.
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { AIClient } from "./client/AIClient.js";
import { runMultiImageEdit, runMultiImageEdit2, runMultiImageEdit3, runMultiImageEdit4 } from "./examples/multi/multi.js";
import { openai_image_edit, openai_image_edit_stream } from "./examples/images/edit/openai.imageedit.js";
import { anthropic_chat, anthropic_chat_stream } from "./examples/chat/anthropic.chat.js";
import { gemini_chat, gemini_chat_stream } from "./examples/chat/gemini.chat.js";
import { openai_chat, openai_chat_stream } from "./examples/chat/openai.chat.js";
import { anthropic_embedding } from "./examples/embeddings/anthropic.embed.js";
import { gemini_embedding } from "./examples/embeddings/gemini.embed.js";
import { openai_moderation } from "./examples/moderation/openai.moderation.js";
import { anthropic_moderation } from "./examples/moderation/anthropic.moderation.js";
import { gemini_moderation } from "./examples/moderation/gemini.moderation.js";
import { gemini_image_analysis, gemini_image_analysis_stream } from "./examples/images/analysis/gemini.analysis.js";
import { openai_image_analysis } from "./examples/images/analysis/openai.analysis.js";
import { gemini_image_gen, gemini_image_gen_stream } from "./examples/images/generation/gemini.gen.js";
import { anthropic_image_analysis, anthropic_image_analysis_stream } from "./examples/images/analysis/anthropic.analysis.js";
import { background_job_cancellation_example, job1_example, job1_streaming_example, job_background_example, multiple_background_jobs_example  } from "./examples/jobs/job1.js";
import { ClientChatRequest, GenericJob, JobChunk, JobManager, JobSnapshot, MultiModalExecutionContext, NormalizedChatMessage } from "./index.js";
//import { openai_moderation } from "./examples/moderation/openai.moderation.js";
//import { openai_embedding } from "./examples/embeddings/openai.embed.js";
//import { openai_image_gen, openai_image_gen_stream } from "./examples/images/generation/openai.gen.js";
//import { openai_image_analysis, openai_image_analysis_stream } from "./examples/images/analysis/openai.analysis.js";
//import { openai_image_edit } from "./examples/images/edit/openai.imageedit.js";


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

        const job = client.createCapabilityJob("chatStream", { input: request }, { streaming: true });

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

//crashRecovery_example();
jobRecovery_example();

async function editImageMultiTurn(aiClient: AIClient) {
    // Sample subject image (Base64 or URL)
    //const subjectImage = loadImage(path.join('test_data/sunlit_lounge.png'), "image/png", "subject");
    //const maskImage = loadImage(path.join('test_data/sunlit_mask.png'), "image/png", "mask");


    // generate
    /* const generated = await aiClient.generateImage(
         {
             input: {
                 prompt: "A cinematic photo of a neon-lit cyberpunk street at night with a sneaky and fluffy cat",
                 params: {
                     size: "1536x1024",
                     format: "png",
                     quality: "high",
 
                 }
             }
         },
         session
     );
 
     saveFile(generated, 0);
 
     const genBuffer = generated.output[0].base64;
     const subjectImage: ClientReferenceImage = loadImageFromBuffer(genBuffer!, "image/png", "subject");
 
     // Turn 1
     console.log(`\n=== Turn 1 ===`);
     const turn1 = await aiClient.editImage(
         {
             input: {
                 prompt: "Modify the cat to be white",
                 //referenceImages: [subjectImage, maskImage],
                 referenceImages: [subjectImage],
                 params: { count: 1 }
             }
         },
         session
     );
 
     const turn1CRI: ClientReferenceImage = {
         sourceType: "url",
         url: ensureDataUri(turn1?.output?.[0]?.url || ""),
         id: crypto.randomUUID(),
         base64: turn1?.output?.[0]?.base64,
         mimeType: "image/png"
     };
     /*for (let i = 0; i < turn1.output.length; i++)
         saveFile(turn1, i);
 
     // Turn 2
     console.log(`\n=== Turn 2 ===`);
     const turn2 = await aiClient.editImage({
         input: {
             prompt: "Add a collar to the cat",
             referenceImages: [] // reuse last image from execution context
         }
     }, session);
 
     for (let i = 0; i < turn2.output.length; i++)
         saveFile(turn2, i);*/

    // Turn 3
    /*console.log(`\n=== Turn 3 ===`);
    const turn3 = await aiClient.editImage({
        input: {
            prompt: "Add a rainbow in the window",
            referenceImages: [] // reuse last image from execution context
        }
    }, session);

    for (let i = 0; i < turn3.output.length; i++)
        saveFile(turn3, i);
*/

    /* const analysis = await aiClient.analyzeImage(
         {
             input: { images: [turn1CRI] }
         },
         
     );
     console.log(analysis);
 
     console.log("Done");*/
}
/*
async function editImageMultiTurnStream(aiClient: AIClient) {
    
    const subjectImage = loadImage(path.join("test_data/sunlit_lounge.png"), "image/png", "subject");
   const maskImage = loadImage(path.join("test_data/sunlit_mask.png"), "image/png", "mask");


    async function consume(label: string, req: any) {
        console.log(`\n=== ${label} ===`);

        let i = 0;
    }

    // Turn 1
    await consume("Turn 1", {
        input: {
            prompt: "Make the background a bright sunset",
            referenceImages: [subjectImage, maskImage],
            params: { count: 1 }
        }
    });

    // Turn 2
    await consume("Turn 2", {
        input: {
            prompt: "generate an image of the same sunlit indoor lounge area with a pool but the pool should contain a flamingo",
            referenceImages: []
        }
    });

    // Turn 3
    await consume("Turn 3", {
        input: {
            prompt: "Add a rainbow in the window",
            referenceImages: []
        }
    });

    console.log("Done");
}
*/
async function main() {
    console.log("Starting ProviderPlaneAI application...");

    let result = background_job_cancellation_example ();

    //let result = await openai_chat();
    //let result = await openai_chat_stream();

   // let result = await anthropic_chat();
    //let result = await anthropic_chat_stream();

    //let result = await gemini_chat();
    //let result = await gemini_chat_stream();

    //let result = await openai_moderation();
    //let result = await anthropic_moderation();
   // let result = await gemini_moderation();
    
    //let result = await openai_embedding();
    //let result = await anthropic_embedding();
    //let result = await gemini_embedding();

    //let result = await openai_image_gen();
    //let result = await openai_image_gen_stream();
    
    //let result = await gemini_image_gen();
    //let result = await gemini_image_gen_stream();

   // let result = await openai_image_analysis();
   // console.log(result);
    //result = await openai_image_analysis_stream();

    //let result = await gemini_image_analysis();
    //let result = await gemini_image_analysis_stream();

    //let result = await anthropic_image_analysis();
   // let result = await anthropic_image_analysis_stream();


    //let result = await openai_image_edit();
    //let result = await openai_image_edit_stream();
    //let result = await runMultiImageEdit()
    //let result = await runMultiImageEdit2()
//    let result = await runMultiImageEdit3();
  //  let result = await runMultiImageEdit4();
    console.log(result);

//console.log(result);
//console.log("-----");
//console.log(result2);
    
   // const aiClient = new AIClient();

    //console.log(`Configuration loaded for environment: ${process.env.NODE_ENV || "development"}`);

    //    await aiClient.registerProvider(new OpenAIProvider(), AIProvider.OpenAI, "default");
    //await aiClient.registerProvider(new AnthropicProvider(), AIProvider.Anthropic, "default");
    //await aiClient.registerProvider(new GeminiProvider(), AIProvider.Gemini, "default");
/*
    aiClient.setLifeCycleHooks({
        onChunkEmitted: (ctx) => console.log(`[AI] Emitted ${ctx.chunkIndex} → ${ctx.providerType}`),
        onExecutionStart: (ctx) => console.log(`[AI] Execution Start ${ctx}`),
        onExecutionFailure: (ctx) => console.log(`[AI] Execution Failure ${ctx}`),
        onExecutionEnd: (ctx) => console.log(`[AI] Execution End ${ctx}`),
        onAttemptStart: (ctx) => console.log(`[AI] Attempt ${ctx.attemptIndex} → ${ctx.providerType}`),
        onAttemptSuccess: (ctx) => console.log(`[AI] Success ${ctx.providerType} in ${ctx.durationMs}ms`),
        onAttemptFailure: (ctx) => console.warn(`[AI] Failure ${ctx.providerType}: ${ctx.error}`)
    });
*/
    /*const chatRequest: ClientChatRequest = {
        messages: [
            { role: "user", content: [{ type: "text", text: "Explain quantum computing in 4 lines." }] },
            { role: "user", content: [{ type: "text", text: "Hello! Can you summarize the benefits of TypeScript?" }] }
        ]
    };*/

    /*const ctx: MultiModalExecutionContext = new MultiModalExecutionContext();

    //const result = await aiClient.chat({ input: chatRequest }, ctx);

    for await (const chunk of aiClient.chatStream({ input: chatRequest }, ctx)) {
        // Each 'chunk' is an AIResponseChunk<string>
        process.stdout.write(chunk.delta || "");
    }*/

 //   console.log("Chat Response:", result.output);

    // await editImageMultiTurn(aiClient);
    //await editImageMultiTurnStream(aiClient);

    /*   const generated = await aiClient.generateImage(
           {
               input: {
                   prompt: "A cinematic photo of a neon-lit cyberpunk street at night with a sneaky and fluffy cat",
                   params: {
                       size: "1536x1024",
                       format: "png",
                       quality: "high",
                       count: 1
                   }
               }
           },
           new AISession(),
           [{ providerType: AIProvider.Gemini, connectionName: "default" }]
       );
   
       console.log(generated);*/

    /* const request: ClientEmbeddingRequest = {
             input: [
                 "How do embed work?",
                 "Explain cosine similarity",
                 "Vector databases are cool"
             ]
         }
    
         const aiRequest = { input: request };
    
        const response = await aiClient.embeddings(aiRequest, new AISession(), [{providerType: AIProvider.Gemini, connectionName: "default"}]);
        console.log(response.output)
        */
    /* const chatRequest: ClientChatRequest = {
            messages: [
                { role: "user", content: [{ type: "text", text: "Explain quantum computing in 4 lines." }] },
                { role: "user", content: [{ type: "text", text: "Hello! Can you summarize the benefits of TypeScript?" }] }
            ]
        };
    
        // Wrap in AIRequest
        const aiRequest = { input: chatRequest };
    */
    // const result = await aiClient.chat(aiRequest, session);
    // console.log("Chat Response:", result.output);

    // console.log("-----------");

    // const result = await aiClient.chat(aiRequest, session);
    // console.log("Chat Response:", result.output);
    /*      for await (const chunk of aiClient.chatStream(aiRequest, aiClient.createSession())) {
                // Each 'chunk' is an AIResponseChunk<string>
                process.stdout.write(chunk.delta || "");
            }
            
            console.log("-----------");
*/
    // await multiTurnExample(aiClient);

    /*     const stream = aiClient.generateImageStream({
             input: {
                 prompt: "A cinematic photo of a neon-lit cyberpunk street at night with a sneaky and fluffy cat",
                 params: {
                     size: "1536x1024",
                     format: "png",
                     quality: "high",
                     count:1
                 }
             },
         });
      for await (const chunk of stream) {
          if (chunk.error) {
              console.error("Gen failed:", chunk.error);
              break;
          }
  
          if (chunk.delta?.length) {
              for (const partial of chunk.delta) {
                  console.log("Partial Gen:", partial);
              }
          }
  
          if (chunk.done) {
              console.log("----------");
          }
      }*/
    // await multiTurnExample(aiClient);

    // simple edit
    /*     let filePath = path.join('test_data/test_cybercat.png');
         let fileBuffer = fs.readFileSync(filePath);
         let buffer = fileBuffer.toString("base64");
         let refImage: ClientReferenceImage = {
             index: 0,
             base64: buffer,
             mimeType: "image/png",
             url: ensureDataUri(buffer, "image/png"),
             role: "reference"
         }
     
     const result = await aiClient.editImage({
         input: {
             prompt: "Replace the cat with an orange tabby",
             referenceImages: [
                 refImage
             ]
         }
     });
 
     console.log(result);
 
      for (let i = 0; i < 1; i++) {
          const buffer = Buffer.from(result.output[i].base64!, "base64");
          fs.writeFileSync(`test_data/output-${result.output[i].id}.${result.metadata?.format || "png"}`, buffer);
          console.log(`test_data/output-${result.output[i].id}.${result.metadata?.format || "png"}`);
      }*/
    /*
        const result = await aiClient.chat({
            input: {
                messages: [
                    { role: "user", content: [{ type: "text", text: "Explain quantum computing in 4 lines." }] }
                ]
            },
        });
        console.log(result);
        console.log("-----------");
        for await (const chunk of aiClient.chatStream({
            input: {
                messages: [
                    { role: "user", content: [{ type: "text", text: "Explain quantum computing in 4 lines." }] }
                ]
            }
        })) {
            // Each 'chunk' is an AIResponseChunk<string>
            process.stdout.write(chunk.delta || "");
        }
    
        //await aiClient.registerProvider(new GeminiProvider(), AIProviderType.Gemini, "default");
        //await aiClient.registerProvider(new AnthropicProvider(), AIProviderType.Anthropic, "default");      
    */
    /*
        const referenceImages: ClientReferenceImage[] = [];
    
        let filePath = path.join('test_data/test.jpeg');
        let fileBuffer = fs.readFileSync(filePath);
        let buffer = fileBuffer.toString("base64");
        let refImage: ClientReferenceImage = {
            index: 0,
            base64: buffer,
            mimeType: "image/jpeg",
            weight: 1,
        }
    
        referenceImages.push({
            //url: b64,
            ...refImage
        })
    
        filePath = path.join('test_data/test2.jpeg');
        fileBuffer = fs.readFileSync(filePath);
        buffer = fileBuffer.toString("base64");
        refImage = {
            index: 1,
            base64: buffer,
            mimeType: "image/jpeg",
            weight: 1,
        }
    
        referenceImages.push({
            //url: b64,
            ...refImage
        })
    
        const response = await aiClient.analyzeImage({
            input: {
                images: referenceImages
            }        
        });
    
        console.log(JSON.stringify(response, null, 2));    
    */
    /* const stream = aiClient.analyizeImageStream({
         input: {
             images: referenceImages
         }
     }, AIProviderType.OpenAI);
 
     for await (const chunk of stream) {
         if (chunk.error) {
             console.error("Analysis failed:", chunk.error);
             break;
         }
 
         if (chunk.delta?.length) {
             for (const partial of chunk.delta) {
                 console.log("Partial analysis:", partial);
             }
         }
 
         if (chunk.done) {
             console.log("----------");
         }
     }
 */
    //   console.log("Analysis complete");

    /* const referenceImages: ClientReferenceImage[] = [];
     //referenceImages.push({url: path});
 
     const filePath = path.join('test_data/test2.jpeg');
 
 
 
     // Read the file
     // Read the file into a Buffer
     const fileBuffer = fs.readFileSync(filePath);
 
     // Wrap in a File object and set type explicitly
     // const file = new File([fileBuffer], "test_data/test.jpeg", { type: "image/jpeg" });    
     const buffer = fileBuffer.toString("base64");
 
     const refImage:ClientReferenceImage = {
         index: 0,
         base64: buffer,
         mimeType: "image/jpeg",
         weight: 1,
         role: "subject",
         description: "cat",
     }
 
     const b64 = toDataUrl(refImage);
 
 
     referenceImages.push({
         url: b64,
         ...refImage
     })
 
     const result = await aiClient.chat({
         input: {
             messages: [
                 { role: "user", content: [{ type: "text", text: "Explain quantum computing in 4 lines." }] }
             ]
         },
     }, AIProviderType.OpenAI);
     console.log(result);
     for (let i = 0; i < 1; i++) {
         const buffer = Buffer.from(result.output[i].base64, "base64");
         fs.writeFileSync(`test_data/output-${result.output[i].id}.${result.metadata?.format || "png"}`, buffer);
         console.log(`test_data/output-${result.output[i].id}.${result.metadata?.format || "png"}`);
     }
 */
    // 1. Define flexible parameter types

    //const buffer = Buffer.from(result.output[i].base64, "base64");
    //fs.writeFileSync(`test_data/output-${result.output[i].id}.${result.metadata?.format || "png"}`, buffer);

    // Example 2: Dedicated Imagen 4 (Widescreen High-Fidelity)
    /* const proImages = await generateUniversalImage({
       modelId: "imagen-4.0-generate",
       prompt: "A photorealistic macro shot of a morning dew drop on a leaf.",
       aspectRatio: "16:9",
       count: 2
     });
   }*/

    /*
        const stream = aiClient.generateImageStream({
            input: {
                referenceImages,
                prompt: "A cinematic photo of a neon-lit cyberpunk street at night with a sneaky and fluffy cat",
                params: {
                    size: "1536x1024",
                    format: "png",
                    quality: "high",
                    count:1
                }
            },
        }, AIProviderType.Anthropic);
    
        for await (const chunk of stream) {
            // chunk.delta contains the array of NormalizedImage(s) produced in this chunk
            for (let i = 0; i < chunk.delta.length; i++) {
                const result: NormalizedImage = chunk.delta[i];
    
                if (result.base64) {
                    const buffer = Buffer.from(result.base64, "base64");
                    const ext = result.mimeType.split("/")[1] || "png";
    
                    fs.writeFileSync(`test_data/output-${result.id || i}.${ext}`,buffer);
                    console.log(`Saved image ${result.id || i}`);
                }
            }
    
            if (chunk.done) {
                console.log("All images streamed!");
            }
        }
    */

    /*const moderationResponse = await aiClient.embeddings({
        input: {
            input: ["hello", "How do embed work?"]
        }
    }, AIProviderType.Anthropic)

    console.log(JSON.stringify(moderationResponse, null, 2));
*/
    /* const embedResponse = await aiClient.embeddings({
         input: {input:[
             "How do embed work?",
             "Explain cosine similarity",
             "Vector databases are cool"
         ]        }
     }, AIProviderType.OpenAI)
 
     console.log(embedResponse);
 */
    //await aiClient.registerProvider(new GeminiProvider(), appConfig, AIProviderType.Gemini, "default");

    /*const chatResponse = await aiClient.chat({
        input: {
            messages: [
                { role: "user", content: [{ type: "text", text: "Explain quantum computing in 4 lines." }] }
            ]
        },
        options: {}
    }, AIProviderType.Gemini);

    console.log("Gemini chat output:", chatResponse.output);


    const aiRequest: AIRequest<ClientChatRequest> = {
        input: {
            messages: [
                { role: 'system', content: [{ type: "text", text: 'You are a poetic assistant.' }] },
                { role: 'user', content: [{ type: "text", text: 'Write a 4-line poem about the ocean.' }] }
            ],
        },
        options: {
            generalParams: {
                autoContinue: true,
                maxContinuations: 2,
                chatStreamBatchSize: 32
            },
            model: "gemini-flash-latest",
        },
        context: { requestId: "req_001" }
    };

    console.log("--- Stream Start ---");

    // Consuming the AsyncIterableIterator
    for await (const chunk of aiClient.chatStream(aiRequest, AIProviderType.Gemini)) {
        // Each 'chunk' is an AIResponseChunk<string>
        process.stdout.write(chunk.delta);
    }

    console.log("\n--- Stream End ---"); */
    /*
    const ai = new GoogleGenAI({ apiKey: "aaa" });
      const models = await ai.models.list();
      
      console.log("Authorized Model IDs:");
      console.log(models);
    */
    /* await aiClient.registerProvider(new AnthropicProvider(), appConfig, AIProviderType.Anthropic, "default");
 
     const chatResponse = await aiClient.chat({
         input: {
             messages: [
                 { role: "user", content: [{ type: "text", text: "Hello, who are you?" }] }
             ]
         },
         options: {}
     }, AIProviderType.Anthropic);
 
     console.log("Anthropic chat output:", chatResponse.output);
 
     // ----- Streaming chat -----
     const stream = aiClient.chatStream({
         input: {
             messages: [
                 { role: "user", content: [{ type: "text", text: "Tell me a story about AI." }] }
             ]
         },
         options: {}
     }, AIProviderType.Anthropic);
 
     for await (const chunk of stream) {
         process.stdout.write(chunk.delta);
     }
     console.log("\nStreaming complete.");*/
    /*
        await aiClient.registerProvider(new OpenAIProvider(), appConfig, AIProviderType.OpenAI, "default");
        //aiClient.registerProvider(new OpenAIProvider(appConfig), AIProviderType.OpenAI, "fallback");    
    
        const response = await aiClient.chat({
              options: { model: "gpt-5" },
              input: {
                  messages: [
                      {
                          role: "system",
                          content: [{ type: "text", text: "Talk like a pirate." }]
                      },
                      {
                          role: "user",
                          content: [
                              { type: "text", text: "Tell me a story in 3 sentences" }
                          ]
                      }
                  ]
              }
         }, AIProviderType.OpenAI);
      
         console.log(response.output);
         console.log("---------")
     
         const stream = await aiClient.chatStream({
             options: { model: "gpt-5" },
             input: {
                 messages: [
                     {
                         role: "system",
                         content: [{ type: "text", text: "Talk normally." }]
                     },
                     {
                         role: "user",
                         content: [
                             { type: "text", text: "Tell me a story in 3 sentences" }
                         ]
                     }
                 ]
             }
         }, AIProviderType.OpenAI);
     
         let fullText = "";
         for await (const chunk of stream) {        
             if (chunk.error) {
                 console.log("Error");
                 break;
             }
     
             if (chunk.delta) {
                 process.stdout.write(chunk.delta || "")
                 fullText += chunk.delta;
             }
     
             if (chunk.done) {
                 console.log("\n____complete____\n");
                 //console.log(JSON.stringify(chunk.structuredOutput, null, 2));
             }
         }
     
         console.log("====\n");
         console.log(fullText);
         console.log("\n");    
     */
    //console.log(JSON.stringify(response1, null, 2));

    /*
        const image = await aiClient.generateImage(
            {
                prompt: "A futuristic city skyline at sunset",
                params: {
                    format: "avif",
                    quality: "ultra"
                }
            },
            AIProviderType.OpenAI
        );
    
        console.log(image.output.images[0].base64);
    
    */

    /*
    //manager.registerProvider(AIProviderType.Anthropic, AnthropicProvider)

    const openAiProvider = await manager.getProvider(AIProviderType.OpenAI, "default") as OpenAIProvider;

    const request: { input: OpenAIInput } = {
        input: {
            type: "image",
            payload: {
                description: "A futuristic city skyline at sunset, digital art",
                referenceImages: [],
                params: {
                    format: "avif",
                    quality: "ultra"
                }
            },
            generalParams: {
                defaultImageFormat: "webp"
            }
        }
    };        

    /*const response = await openAiProvider.generateImage(request);
    console.log(JSON.stringify(response, null, 2));

    const img = response.output.images[0];
    const base64 = img.base64!;
    fs.writeFileSync("output.png", Buffer.from(base64, "base64"));
    console.log("Saved output.png");    */

    /*  const input:OpenAIInput = {
          type: "chatStream",
          payload: {messages: [
              {role: "system", content: [{type: "input_text", text:"Talk normally"}]},
              {role: "user", content:  [{type: "input_text", text:"Tell me a story in 3 sentences"}]}     
          ]} as OpenAIChatPayload
          //: [
              //{role: "system", content: [{type: "input_text", text:"Talk normally"}]},
              //{role: "user", content:  [{type: "input_text", text:"Tell me a story in 3 sentences"}]}            
          //]
      }

*/
    /*  const result = await openAiProvider.moderate({input: {
          type: "moderation",
          payload: {input: ["Hello", "kys"]}}})
  
      console.log(result);*/
    /*
            const input:OpenAIInput = {
                type: "chat",
                messages: [
                    {role: "system", content: [{type: "input_text", text:"Talk normally"}]},
                    {role: "user", content:  [{type: "input_text", text:"Tell me a story in 3 sentences"}]}            
                ]
            }
    */
    /*   for await (const result of openAiProvider.chatStream({ input, options: {
           model: "gpt-5",
           generalParams: {
               autoContinue: true
           },
           modelParams: {},
           
       }})) {        
           process.stdout.write(result.delta || ""); // incremental output
          // console.log(result);            
          // console.log(JSON.stringify(result.metadata, null, 2));
           
       }    
 */
    /*const result = await openAiProvider.editImage({
        input: {
            prompt: "Add a red hat to the person in the image",            
            type: "imageEdit",
            baseImageBase64: fs.readFileSync(path.join('test_data/test.png')).toString('base64')
        },
        options : {} as any
    });*/

    //console.log(result);
    /*
    
    */
    /* const request: { input: OpenAIInput } = {
         input: {
             type: "image",
             payload: {
                 prompt: "A futuristic city skyline at sunset, ultra-detailed, digital art",
                 referenceImages: [],
                 params: {
                     format: "avif"
                 }
             } as OpenAIImageGenerateMessage,
             generalParams: {
                 defaultImageFormat: "webp"
             }
         }
     };*/

    //  const response = await openAiProvider.generateImageStream(request);
    /*
        for await (const chunk of openAiProvider.generateImageStream(request)) {
            if (chunk.error) {
                console.error("Image error:", chunk.error);
                continue;
            }
    
            if (chunk.output?.stage === "final" && chunk.output.base64) {
                const buffer = Buffer.from(chunk.output.base64, "base64");
                fs.writeFileSync(`test_data/output-${chunk.id}.${chunk.metadata?.format || "png"}`, buffer);
                console.log(`test_data/output-${chunk.id}.${chunk.metadata?.format || "png"}`);
            }
        }
    
    
        // Stream images
       /* (async () => {
            let imageIndex = 1;
    
         let count = 0;
    
        for await (const chunk of openAiProvider.generateImageStream(request)) {
            if (chunk.output && chunk.output.base64) {
                const buffer = Buffer.from(chunk.output.base64, "base64");
                const filename = path.join(
                    process.cwd() + "/test_data",
                    `generated_image_${count + 1}.png`
                );
                fs.writeFileSync(filename, buffer);
                console.log(`Saved image ${count + 1} to ${filename}`);
                count++;
            }
    
            if (chunk.error) {
                console.error("Error from stream:", chunk.error);
            }
        }
    
            console.log("All images processed!");
        })();*/

    //for (const item of response.output.images) {
    //        const outFilePath = path.join(`test_data/${item.id}.png`);
    /* const images = response.output.images;
 
     const rawResults = images.map(item => ({
         id: crypto.randomUUID(),
         base64: item.base64
     }));
 console.log(rawResults);
     const media = MediaSourceMapper.convertArray(rawResults);
 
     const saved = await MediaFileHelper.saveAll(
         media,
         "./test_data",
         "aiImage"
     );
     console.log(saved);
     /*        if (item.base64) {
                 // Decode base64 string to raw bytes and write to file.
                 fs.writeFileSync(outFilePath, Buffer.from(item.base64, 'base64'));
             }
             else if(item.url) {
                 const response = await axios.get(item.url);            
                 console.log(response.headers);
                 fs.writeFileSync(outFilePath, Buffer.from(response.data));
             }
         }*/

    // openAiProvider.generateImage({
    //     input: ""
    // })

    /*  const request: AIRequest<OpenAIInput> = {
          input: {
              type: "embedding",
              payload: {
                  input: [
                      "How do embed work?",
                      "Explain cosine similarity",
                      "Vector databases are cool"
                  ]
              }
          },
          options: {
              model: "text-embedding-3-large"
          }
      };*/

    //const openAiProvider = await manager.getProvider(AIProviderType.OpenAI, "default") as OpenAIProvider;
    //  const embed = await openAiProvider.embed(request)

    // console.log(embed);
    /*
        const input:OpenAIInput = {
            type: "chat",
            messages: [
                {role: "system", content: [{type: "input_text", text:"Talk normally"}]},
                {role: "user", content:  [{type: "input_text", text:"Tell me a story in 3 sentences"}]}            
            ]
        }
        
        /*[
            {role: "system", content: [{type: "input_text", text:"Talk normally"}]},
            {role: "user", content:  [{type: "input_text", text:"Tell me a story in 3 sentences"}]}
        ];*/
    /*
        const chatResponse = await openAiProvider.chat({ input, options: {
            model: "gpt-5",
            generalParams: {
                autoContinue: true
            },
            modelParams: {
            }
        } as any });
        console.log("Chat response:", JSON.stringify(chatResponse.output, null, 2));
    */
    /*  console.log("Streaming chat:");
      for await (const result of openAiProvider.chatStream({ input, options: {
          model: "gpt-5",
          generalParams: {
              autoContinue: true
          },
          modelParams: {},
          
      }})) {        
          process.stdout.write(result.delta || ""); // incremental output
         // console.log(result);            
         // console.log(JSON.stringify(result.metadata, null, 2));
          
      }
      console.log("\n---- Stream complete ----");
*/

    /* console.log("---------------------------------");
     
     console.log(manager.listConnections(AIProviderType.OpenAI));
     console.log(manager.listConnections(AIProviderType.Anthropic));
     //console.log(await manager.getProvider(AIProviderType.OpenAI, "fallback"))
 
     console.log("---------------------------------");       
 */
    //console.log(provider);

    //console.log("Getting OpenAI provider instance...");

    /*  const openai1 = await ProviderRegistry.createProvider(
          AIProviderType.OpenAI,
          appConfig.providers.openai.connection1
      );
  */
    //const result = await openai1.generateSpeech!("Hello world from Chatgpt");

    //console.log(JSON.stringify(result, null, 2))
    /*
        //console.log("openai1", JSON.stringify(openai1, null, 2));
    //const fs = await import ('fs');
    const path = await import ('path');
    
    // Path to your PNG file
    const filePath = path.join('test_data/test.jpeg');
    
    // Read the file
      // Read the file into a Buffer
      const fileBuffer = fs.readFileSync(filePath);
    
      // Wrap in a File object and set type explicitly
      //const file = new File([fileBuffer], "test_data/test.jpeg", { type: "image/jpeg" });
    
    
        //const result = await openai1.translateAudio!(file);
    
    const result = await openai1.editVideo!("She turns around and smiles, then falls down comedically.");
        console.log(result);
    
    fs.writeFileSync('test_data/video_remix.mp4', result.output.buffer);
    
    console.log('Wrote video.mp4');    
    */

    /*const openai1 = await ProviderManager.getProvider(AIProviderType.OpenAI, {
        name: AIProviderType.OpenAI,
        apiKey: process.env.OPENAI_API_KEY_1,
        defaultModel: "gpt-4",
        models: {
            "gpt-4": {},
        },
    }, "1");
 
    const result = await openai1.generateText!("Hello from key1");
 
    console.log(result);*/

    //const result = await provider.generateText("Write a haiku about lazy loading.");

    /*const providerName = appConfig.defaultProvider;
    const providerConfig = appConfig.providers[providerName];
 
    console.log(`Loading provider: ${providerName}`);
    const provider:IProvider = await ProviderRegistry.createProvider(providerName, providerConfig);
 
    if(!provider || !provider.generateText) {
        throw new Error(`Failed to create provider: ${providerName}`);
    }
 
*/

    // const result = await provider.generateText("Write a haiku about lazy loading.");

    // console.log(`[${providerName}]`, result);

    //console.log(JSON.stringify(appConfig, null, 2));

    // const openaiProvider: OpenAIProvider = new OpenAIProvider();
    // await openaiProvider.init(appConfig.providers.openai);

    //  const prompt: string = "Once upon a time in a land far, far away, there lived a";
    //const response: any = await openaiProvider.generateText(prompt, "gpt-5");

    // streamed response
    /* let resultString: string = "";
     const response: any = await openaiProvider.stream(prompt, (str) => {
         resultString += str;
     },"gpt-5");
 */
    //  const response: any = await openaiProvider.embed("Hello world!", "text-embedding-3-large");

    /* const anthropicProviderConfig = appConfig.providers["anthropic"];
     const anthropic:IProvider = await ProviderRegistry.createProvider("anthropic", anthropicProviderConfig);
 
     if(!anthropic || !anthropic.generateText || !anthropic.stream) {
         throw new Error(`Failed to create provider: anthropic`);
     }*/

    //console.log("Generated response from OpenAI:");
    //console.log(response);

    /*const anthropicProvider:AnthropicProvider = new AnthropicProvider();
    await anthropicProvider.init(appConfig.providers.anthropic);
*/
    //const response: any = await anthropic.generateText("Hello world!, How are you?");

    /*let resultString: string = "";
    const response: any = await anthropic.stream("Hello world!, How are you?", (chunk) => {        
        resultString += chunk?.delta?.text || "";
    });
 
    console.log("Generated response from Anthropic:");
    console.log(resultString);*/

    //-----------------hf
    /*const providerName = "huggingface";
    const providerConfig = appConfig.providers[providerName]
    const provider:IProvider = await ProviderRegistry.createProvider(providerName, providerConfig);
 
    if(!provider || !provider.generateText) {
        throw new Error(`Failed to create provider: ${providerName}`);
    }
 
    const result = await provider.generateText("Write a short story about a brave little toaster.");
 
    console.log(`Generated response from ${providerName}:`);
    console.log(JSON.stringify(result, null, 2));*/

    //console.log("-------------------");
}

//main().catch((error) => {
    //console.error("Error in main execution:", error);
    //process.exit(1);
//});
