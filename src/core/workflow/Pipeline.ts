/* eslint-disable @typescript-eslint/no-empty-object-type */
/**
 * @module core/workflow/Pipeline.ts
 * @description High-level workflow authoring API built on top of WorkflowBuilder.
 */
import {
    CapabilityKeys,
    GenericJob,
    type AIProviderType,
    type ClientOCRStructuredOptions,
    type ClientReferenceImage,
    type MultiModalExecutionContext,
    type ProviderRef,
    type Workflow,
    type WorkflowDefaults,
    type WorkflowNodeFn,
    type WorkflowNodeOptions,
    type WorkflowCapabilityRequestFactory,
    type WorkflowState,
    WorkflowBuilder,
    type WorkflowCapabilityNodeOptions,
    type WorkflowRetryPolicy,
    PipelineError,
    extractPipelineAudioArtifact,
    extractPipelineImageReference,
    extractPipelineText,
    resolvePipelineTemplate,
    toPipelineAudioInput,
    toPipelineFileInput
} from "#root/index.js";

/**
 * Generic workflow state value map used by pipeline request/selector callbacks.
 *
 * @public
 */
export type StepValues = Record<string, unknown>;

/**
 * Text input accepted by high-level pipeline text-capable helpers.
 *
 * @public
 */
export type StepTextInput = string | ((values: StepValues) => string);

/**
 * Generic selector callback signature used to project source step outputs.
 *
 * @public
 * @template T Projected value type.
 */
export type PipelineSelectorFn<T> = (sourceValue: unknown, values: StepValues) => T;

/**
 * Normalized artifact shape used across source-bound pipeline helpers.
 *
 * @public
 */
export type PipelineSourceArtifact = {
    id?: string;
    mimeType?: string;
    base64?: string;
    url?: string;
};
export interface PipelineStepHandle<TOutput = unknown> {
    readonly id: string;
    readonly __output?: TOutput;
}
export type PipelineStepRef = string | PipelineStepHandle<any>;
export interface PipelineSourceBinding<TSelect> {
    step: PipelineStepRef;
    select?: TSelect;
}
/**
 * Selectors for text-producing source bindings.
 *
 * @public
 */
export type PipelineTextSelect = "text" | PipelineSelectorFn<string>;

/**
 * Selectors for artifact-producing source bindings.
 *
 * @public
 */
export type PipelineArtifactSelect = "artifact" | "audio" | "video" | PipelineSelectorFn<PipelineSourceArtifact>;

/**
 * Selectors for image-producing source bindings.
 *
 * @public
 */
export type PipelineImageSelect = "image" | PipelineSelectorFn<ClientReferenceImage>;

/**
 * Selectors for video-producing source bindings.
 *
 * @public
 */
export type PipelineVideoSelect = "video" | "artifact" | PipelineSelectorFn<PipelineSourceArtifact>;
export type PipelineNormalizePreset = "text" | "artifact" | "image";
export type PipelineNormalizeFn = (output: unknown, values: StepValues) => unknown;
/**
 * Source reference union accepted by text-bound helpers.
 *
 * @public
 */
export type PipelineTextSourceRef = PipelineStepRef | PipelineSourceBinding<PipelineTextSelect>;

/**
 * Source reference union accepted by artifact-bound helpers.
 *
 * @public
 */
export type PipelineArtifactSourceRef = PipelineStepRef | PipelineSourceBinding<PipelineArtifactSelect>;

/**
 * Source reference union accepted by image-bound helpers.
 *
 * @public
 */
export type PipelineImageSourceRef = PipelineStepRef | PipelineSourceBinding<PipelineImageSelect>;

/**
 * Source reference union accepted by video-bound helpers.
 *
 * @public
 */
export type PipelineVideoSourceRef = PipelineStepRef | PipelineSourceBinding<PipelineVideoSelect>;

/**
 * Source selector builder contract used by helpers.
 *
 * @public
 */
export interface PipelineSourceSelector {
    /**
     * Binds a text source selector.
     *
     * @param {PipelineSelectorFn<string>=} select Optional projection from source value to text.
     * @returns {PipelineSourceBinding<PipelineTextSelect>} Selector binding for text-producing steps.
     */
    text(select?: PipelineSelectorFn<string>): PipelineSourceBinding<PipelineTextSelect>;
    /**
     * Binds a generic artifact selector.
     *
     * @param {PipelineSelectorFn<PipelineSourceArtifact>=} select Optional projection to artifact shape.
     * @returns {PipelineSourceBinding<PipelineArtifactSelect>} Selector binding for artifact-producing steps.
     */
    artifact(select?: PipelineSelectorFn<PipelineSourceArtifact>): PipelineSourceBinding<PipelineArtifactSelect>;
    /**
     * Binds an audio artifact selector.
     *
     * @param {PipelineSelectorFn<PipelineSourceArtifact>=} select Optional projection to artifact shape.
     * @returns {PipelineSourceBinding<PipelineArtifactSelect>} Selector binding for audio-producing steps.
     */
    audio(select?: PipelineSelectorFn<PipelineSourceArtifact>): PipelineSourceBinding<PipelineArtifactSelect>;
    /**
     * Binds a video artifact selector.
     *
     * @param {PipelineSelectorFn<PipelineSourceArtifact>=} select Optional projection to artifact shape.
     * @returns {PipelineSourceBinding<PipelineArtifactSelect>} Selector binding for video-producing steps.
     */
    video(select?: PipelineSelectorFn<PipelineSourceArtifact>): PipelineSourceBinding<PipelineArtifactSelect>;
    /**
     * Binds an image reference selector.
     *
     * @param {PipelineSelectorFn<ClientReferenceImage>=} select Optional projection to image reference shape.
     * @returns {PipelineSourceBinding<PipelineImageSelect>} Selector binding for image-producing steps.
     */
    image(select?: PipelineSelectorFn<ClientReferenceImage>): PipelineSourceBinding<PipelineImageSelect>;
}

/**
 * Shared authoring options for high-level pipeline steps.
 */
export interface PipelineStepOptions {
    after?: PipelineStepRef | PipelineStepRef[];
    provider?: AIProviderType;
    providerChain?: ProviderRef[];
    timeoutMs?: number;
    retry?: WorkflowRetryPolicy;
    when?: (values: StepValues) => boolean;
    addToManager?: boolean;
    normalize?: PipelineNormalizePreset | PipelineNormalizeFn;
    keepRaw?: boolean;
}

/**
 * Step options that require a single source step binding.
 */
export interface PipelineSourceStepOptions extends PipelineStepOptions {
    source:
        | PipelineStepRef
        | PipelineStepRef[]
        | PipelineSourceBinding<unknown>
        | Array<PipelineStepRef | PipelineSourceBinding<unknown>>;
}

/**
 * Step options that optionally bind to a single source step.
 */
export interface PipelineSourceOptionalStepOptions extends PipelineStepOptions {
    source?:
        | PipelineStepRef
        | PipelineStepRef[]
        | PipelineSourceBinding<unknown>
        | Array<PipelineStepRef | PipelineSourceBinding<unknown>>;
}

/**
 * Step options that require one or more source step bindings.
 */
export interface PipelineSourceStepsOptions extends PipelineStepOptions {
    source:
        | PipelineStepRef
        | PipelineStepRef[]
        | PipelineSourceBinding<unknown>
        | Array<PipelineStepRef | PipelineSourceBinding<unknown>>;
}

/**
 * Source-bound step options that produce text input.
 */
export interface PipelineTextSourceStepOptions extends PipelineSourceStepOptions {
    source: PipelineTextSourceRef | PipelineTextSourceRef[];
    select?: PipelineTextSelect;
}

/**
 * Optional-source step options that produce text input when source is present.
 */
export interface PipelineTextSourceOptionalStepOptions extends PipelineSourceOptionalStepOptions {
    source?: PipelineTextSourceRef | PipelineTextSourceRef[];
    select?: PipelineTextSelect;
}

/**
 * Source-bound step options that consume artifact-like payloads.
 */
export interface PipelineArtifactSourceStepOptions extends PipelineSourceStepOptions {
    source: PipelineArtifactSourceRef | PipelineArtifactSourceRef[];
    select?: PipelineArtifactSelect;
}

/**
 * Optional-source step options that consume artifact-like payloads.
 */
export interface PipelineArtifactSourceOptionalStepOptions extends PipelineSourceOptionalStepOptions {
    source?: PipelineArtifactSourceRef | PipelineArtifactSourceRef[];
    select?: PipelineArtifactSelect;
}

/**
 * Source-bound step options that consume image references.
 */
export interface PipelineImageSourceStepOptions extends PipelineSourceStepOptions {
    source: PipelineImageSourceRef | PipelineImageSourceRef[];
    select?: PipelineImageSelect;
}

/**
 * Source-bound options for multi-source video analysis steps.
 */
export interface PipelineVideoSourceStepsOptions extends PipelineSourceStepsOptions {
    source: PipelineVideoSourceRef | PipelineVideoSourceRef[];
    select?: PipelineVideoSelect;
}

/**
 * Optional request customization for chat/chatStream helpers.
 */
export interface PipelineTextStepOptions extends PipelineStepOptions {
    inputOverrides?: Record<string, unknown> | ((values: StepValues) => Record<string, unknown>);
    requestOverrides?: Record<string, unknown> | ((values: StepValues) => Record<string, unknown>);
}

/**
 * Pipeline-level constructor options.
 */
export interface PipelineOptions {
    defaults?: WorkflowDefaults;
}

/**
 * Step input for TTS.
 */
export interface PipelineTtsInput {
    voice?: string;
    format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
    instructions?: string;
}

/**
 * Step input for transcription.
 */
export interface PipelineTranscribeInput {
    filename?: string;
    responseFormat?: "json" | "text" | "srt" | "verbose_json" | "vtt" | "diarized_json";
}

/**
 * Step input for translation.
 */
export interface PipelineTranslateInput {
    filename?: string;
    targetLanguage?: string;
    responseFormat?: "json" | "text" | "srt" | "verbose_json" | "vtt";
}

/**
 * Step input for moderation.
 */
export interface PipelineModerateInput {}

/**
 * Step input for embedding.
 */
export interface PipelineEmbedInput {
    text?: StepTextInput;
    purpose?: string;
}

/**
 * Step input for image generation.
 */
export interface PipelineImageGenerateInput {
    prompt?: StepTextInput;
    params?: {
        size?: string;
        format?: "png" | "jpeg" | "webp" | "avif";
        quality?: "low" | "medium" | "high" | "ultra";
        style?: string;
        background?: "transparent" | "opaque";
        extras?: Record<string, unknown>;
    };
}

/**
 * Step input for image analysis.
 */
export interface PipelineImageAnalyzeInput {
    prompt?: StepTextInput;
}

/**
 * Step input for OCR.
 */
export interface PipelineOCRInput {
    prompt?: StepTextInput;
    language?: string;
    filename?: string;
    mimeType?: string;
    includeBoundingBoxes?: boolean;
    structured?: ClientOCRStructuredOptions;
}

/**
 * Step input for file save.
 */
export interface PipelineSaveFileInput {
    path: string | ((args: { artifact: any; values: StepValues }) => string);
}

/**
 * Step input for video generation.
 */
export interface PipelineVideoGenerateInput {
    prompt?: StepTextInput;
    params?: Record<string, unknown>;
}

/**
 * Step input for video remix.
 */
export interface PipelineVideoRemixInput {
    sourceVideoId?: string | ((values: StepValues) => string);
    prompt?: StepTextInput;
    params?: Record<string, unknown>;
}

/**
 * Step input for video download.
 */
export interface PipelineVideoDownloadInput {
    videoUri?: StepTextInput;
    variant?: string;
    videoId?: string | ((values: StepValues) => string);
}

/**
 * Step input for video analysis.
 */
export interface PipelineVideoAnalyzeInput {
    prompt?: StepTextInput;
    params?: Record<string, unknown>;
}

/**
 * Step input for approval gate.
 */
export interface PipelineApprovalGateInput {
    input: Record<string, unknown> | ((values: StepValues) => Record<string, unknown>);
}

/**
 * Workflow-first high-level authoring API for common multimodal pipelines.
 *
 * Keeps `WorkflowBuilder` as the execution model while removing request-shape boilerplate.
 *
 * @public
 * @template TOutput Final aggregated workflow output type.
 */
export class Pipeline<TOutput = unknown> {
    private readonly builder: WorkflowBuilder<TOutput>;

    /**
     * Creates a pipeline authoring instance.
     *
     * @param {string} id Workflow identifier.
     * @param {PipelineOptions=} options Optional pipeline defaults.
     */
    constructor(id: string, options?: PipelineOptions) {
        this.builder = new WorkflowBuilder<TOutput>(id);
        if (options?.defaults) {
            this.builder.defaults(options.defaults);
        }
    }

    /**
     * Returns the underlying WorkflowBuilder for escape-hatch use.
     *
     * @returns {WorkflowBuilder<TOutput>} Underlying builder.
     */
    toWorkflowBuilder(): WorkflowBuilder<TOutput> {
        return this.builder;
    }

    /**
     * Set workflow defaults.
     *
     * @param {WorkflowDefaults} defaults Workflow-level runtime defaults.
     * @returns {this} Fluent pipeline instance.
     */
    defaults(defaults: WorkflowDefaults): this {
        this.builder.defaults(defaults);
        return this;
    }

    /**
     * Set workflow version.
     *
     * @param {string | number} value Workflow version value.
     * @returns {this} Fluent pipeline instance.
     */
    version(value: string | number): this {
        this.builder.version(value);
        return this;
    }

    /**
     * Add a custom node directly to the underlying workflow.
     *
     * @param {string} id Node id.
     * @param {WorkflowNodeFn} fn Node execution function.
     * @param {WorkflowNodeOptions=} options Node options.
     * @returns {this} Fluent pipeline instance.
     */
    node(id: string, fn: WorkflowNodeFn, options?: WorkflowNodeOptions): this {
        this.builder.node(id, fn, options);
        return this;
    }

    /**
     * Add a node with dependencies.
     *
     * @param {PipelineStepRef | PipelineStepRef[]} dependencies Upstream dependencies.
     * @param {string} id Node id.
     * @param {WorkflowNodeFn} fn Node execution function.
     * @param {Omit<WorkflowNodeOptions, "dependsOn">=} options Node options (dependency list is managed by pipeline).
     * @returns {this} Fluent pipeline instance.
     */
    after(
        dependencies: PipelineStepRef | PipelineStepRef[],
        id: string,
        fn: WorkflowNodeFn,
        options?: Omit<WorkflowNodeOptions, "dependsOn">
    ): this {
        this.builder.after(this.resolveStepRefs(dependencies)!, id, fn, options);
        return this;
    }

    /**
     * Register a capability node using raw request shape.
     *
     * @template C Capability key/string.
     * @template TInput Request input shape.
     * @param {string} id Node id.
     * @param {C} capability Capability identifier.
     * @param {WorkflowCapabilityRequestFactory<TInput>} requestOrFactory Static request or request factory.
     * @param {WorkflowCapabilityNodeOptions=} options Capability execution options.
     * @returns {this} Fluent pipeline instance.
     */
    capabilityNode<C extends string, TInput>(
        id: string,
        capability: C,
        requestOrFactory: WorkflowCapabilityRequestFactory<TInput>,
        options?: WorkflowCapabilityNodeOptions
    ): this {
        this.builder.capabilityNode(id, capability as any, requestOrFactory as any, options);
        return this;
    }

    /**
     * Register a capability node with dependencies using raw request shape.
     *
     * @template C Capability key/string.
     * @template TInput Request input shape.
     * @param {PipelineStepRef | PipelineStepRef[]} dependencies Upstream dependencies.
     * @param {string} id Node id.
     * @param {C} capability Capability identifier.
     * @param {WorkflowCapabilityRequestFactory<TInput>} requestOrFactory Static request or request factory.
     * @param {Omit<WorkflowCapabilityNodeOptions, "dependsOn">=} options Capability options (dependency list managed by pipeline).
     * @returns {this} Fluent pipeline instance.
     */
    capabilityAfter<C extends string, TInput>(
        dependencies: PipelineStepRef | PipelineStepRef[],
        id: string,
        capability: C,
        requestOrFactory: WorkflowCapabilityRequestFactory<TInput>,
        options?: Omit<WorkflowCapabilityNodeOptions, "dependsOn">
    ): this {
        this.builder.capabilityAfter(
            this.resolveStepRefs(dependencies)!,
            id,
            capability as any,
            requestOrFactory as any,
            options
        );
        return this;
    }

    /**
     * Add a custom capability-backed step.
     *
     * @param {string} id Node id.
     * @param {string} capability Capability identifier.
     * @param {WorkflowCapabilityRequestFactory<any>} requestOrFactory Static request or request factory.
     * @param {PipelineStepOptions=} opts Pipeline step options.
     * @returns {this} Fluent pipeline instance.
     */
    custom(
        id: string,
        capability: string,
        requestOrFactory: WorkflowCapabilityRequestFactory<any>,
        opts?: PipelineStepOptions
    ): this {
        return this.capabilityStep(id, capability, requestOrFactory, opts);
    }

    /**
     * Add a custom capability-backed step with explicit dependencies.
     *
     * @param {PipelineStepRef | PipelineStepRef[]} dependencies Upstream dependencies.
     * @param {string} id Node id.
     * @param {string} capability Capability identifier.
     * @param {WorkflowCapabilityRequestFactory<any>} requestOrFactory Static request or request factory.
     * @param {Omit<PipelineStepOptions, "after">=} opts Pipeline options without `after` (provided by method argument).
     * @returns {this} Fluent pipeline instance.
     */
    customAfter(
        dependencies: PipelineStepRef | PipelineStepRef[],
        id: string,
        capability: string,
        requestOrFactory: WorkflowCapabilityRequestFactory<any>,
        opts?: Omit<PipelineStepOptions, "after">
    ): this {
        const mappedOptions: WorkflowCapabilityNodeOptions | undefined = {
            providerChain: this.resolveProviderChain(opts ?? {}),
            timeoutMs: opts?.timeoutMs,
            retry: opts?.retry,
            condition: opts?.when ? (state: WorkflowState) => opts.when!(state.values) : undefined,
            addToManager: opts?.addToManager
        };
        this.builder.capabilityAfter(
            this.resolveStepRefs(dependencies)!,
            id,
            capability as any,
            requestOrFactory,
            mappedOptions
        );
        return this;
    }

    /**
     * Add a chat step.
     *
     * @param {string} id Node id.
     * @param {StepTextInput} promptOrTemplate Prompt text or prompt factory.
     * @param {PipelineTextStepOptions=} opts Step options.
     * @returns {this} Fluent pipeline instance.
     */
    chat(id: string, promptOrTemplate: StepTextInput, opts?: PipelineTextStepOptions): this {
        return this.capabilityTextStep(id, CapabilityKeys.ChatCapabilityKey, promptOrTemplate, opts);
    }

    /**
     * Add a streaming chat step.
     *
     * @param {string} id Node id.
     * @param {StepTextInput} promptOrTemplate Prompt text or prompt factory.
     * @param {PipelineTextStepOptions=} opts Step options.
     * @returns {this} Fluent pipeline instance.
     */
    chatStream(id: string, promptOrTemplate: StepTextInput, opts?: PipelineTextStepOptions): this {
        return this.capabilityTextStep(id, CapabilityKeys.ChatStreamCapabilityKey, promptOrTemplate, opts);
    }

    /**
     * Add a text-to-speech step bound to a prior text-producing source step.
     *
     * @param {string} id Node id.
     * @param {PipelineTtsInput} input TTS request input.
     * @param {PipelineTextSourceStepOptions} opts Source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    tts(id: string, input: PipelineTtsInput, opts: PipelineTextSourceStepOptions): this {
        const sourceRefs = this.toSourceBindings(opts.source);
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds, opts.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.AudioTextToSpeechCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => ({
                input: {
                    text: this.resolveSourceTexts(sourceRefs, state.values).join("\n\n"),
                    ...(input.voice ? { voice: input.voice } : {}),
                    ...(input.format ? { format: input.format } : {}),
                    ...(input.instructions ? { instructions: input.instructions } : {})
                }
            }),
            {
                ...opts,
                after: mergedAfter
            }
        );
    }

    /**
     * Add an audio transcription step bound to a prior audio-producing source step.
     *
     * @param {string} id Node id.
     * @param {PipelineTranscribeInput} input Transcription request input.
     * @param {PipelineArtifactSourceStepOptions} opts Source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    transcribe(id: string, input: PipelineTranscribeInput, opts: PipelineArtifactSourceStepOptions): this {
        const sourceRefs = this.toSourceBindings(opts.source);
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds, opts.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.AudioTranscriptionCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => {
                const audio = this.resolveFirstSourceArtifact(sourceRefs, state.values);
                return {
                    input: {
                        file: toPipelineAudioInput(audio),
                        mimeType: String(audio.mimeType ?? "audio/mpeg"),
                        filename: input.filename ?? "audio-input.mp3",
                        responseFormat: input.responseFormat ?? "text"
                    }
                };
            },
            {
                ...opts,
                after: mergedAfter
            }
        );
    }

    /**
     * Add an audio translation step bound to a prior audio-producing source step.
     *
     * @param {string} id Node id.
     * @param {PipelineTranslateInput} input Translation request input.
     * @param {PipelineArtifactSourceStepOptions} opts Source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    translate(id: string, input: PipelineTranslateInput, opts: PipelineArtifactSourceStepOptions): this {
        const sourceRefs = this.toSourceBindings(opts.source);
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds, opts.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.AudioTranslationCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => {
                const audio = this.resolveFirstSourceArtifact(sourceRefs, state.values);
                return {
                    input: {
                        file: toPipelineAudioInput(audio),
                        mimeType: String(audio.mimeType ?? "audio/mpeg"),
                        filename: input.filename ?? "audio-input.mp3",
                        targetLanguage: input.targetLanguage ?? "english",
                        responseFormat: input.responseFormat ?? "text"
                    }
                };
            },
            {
                ...opts,
                after: mergedAfter
            }
        );
    }

    /**
     * Add a moderation step bound to a prior text-producing source step.
     *
     * @param {string} id Node id.
     * @param {PipelineModerateInput} input Moderation request input.
     * @param {PipelineTextSourceStepOptions} opts Source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    moderate(id: string, input: PipelineModerateInput, opts: PipelineTextSourceStepOptions): this {
        const sourceRefs = this.toSourceBindings(opts.source);
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds, opts.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.ModerationCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => ({
                input: {
                    input: this.resolveSourceTexts(sourceRefs, state.values).join("\n\n")
                }
            }),
            {
                ...opts,
                after: mergedAfter
            }
        );
    }

    /**
     * Add an embedding step from explicit text or a source step.
     *
     * @param {string} id Node id.
     * @param {PipelineEmbedInput} input Embedding request input.
     * @param {PipelineTextSourceOptionalStepOptions=} opts Optional source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    embed(id: string, input: PipelineEmbedInput, opts?: PipelineTextSourceOptionalStepOptions): this {
        const sourceRefs = opts?.source ? this.toSourceBindings(opts.source) : [];
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds.length > 0 ? sourceIds : undefined, opts?.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.EmbedCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => ({
                input: {
                    input: this.resolveTextInput(
                        input.text ??
                            (sourceRefs.length > 0 ? this.resolveSourceTexts(sourceRefs, state.values).join("\n\n") : ""),
                        state.values
                    ),
                    ...(input.purpose ? { purpose: input.purpose } : {})
                }
            }),
            {
                ...(opts ?? {}),
                after: mergedAfter
            }
        );
    }

    /**
     * Add an image generation step.
     *
     * @param {string} id Node id.
     * @param {PipelineImageGenerateInput} input Image generation request input.
     * @param {PipelineTextSourceOptionalStepOptions=} opts Optional source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    imageGenerate(id: string, input: PipelineImageGenerateInput, opts?: PipelineTextSourceOptionalStepOptions): this {
        const sourceRefs = opts?.source ? this.toSourceBindings(opts.source) : [];
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds.length > 0 ? sourceIds : undefined, opts?.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.ImageGenerationCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => ({
                input: {
                    prompt: this.resolveTextInput(
                        input.prompt ??
                            (sourceRefs.length > 0 ? this.resolveSourceTexts(sourceRefs, state.values).join("\n\n") : ""),
                        state.values
                    ),
                    ...(input.params ? { params: input.params } : {})
                }
            }),
            {
                ...(opts ?? {}),
                after: mergedAfter
            }
        );
    }

    /**
     * Add an image analysis step bound to a generated-image source step.
     *
     * @param {string} id Node id.
     * @param {PipelineImageAnalyzeInput} input Image analysis request input.
     * @param {PipelineImageSourceStepOptions} opts Source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    imageAnalyze(id: string, input: PipelineImageAnalyzeInput, opts: PipelineImageSourceStepOptions): this {
        const sourceRefs = this.toSourceBindings(opts.source);
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds, opts.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.ImageAnalysisCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => ({
                input: {
                    images: this.resolveSourceImageReferences(sourceRefs, state.values),
                    ...(input.prompt
                        ? {
                              prompt: this.resolveTextInput(input.prompt, state.values)
                          }
                        : {})
                }
            }),
            {
                ...opts,
                after: mergedAfter
            }
        );
    }

    /**
     * Add an OCR step bound to a file/image-producing source step.
     *
     * @param {string} id Node id.
     * @param {PipelineOCRInput} input OCR request input.
     * @param {PipelineArtifactSourceStepOptions} opts Source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    ocr(id: string, input: PipelineOCRInput, opts: PipelineArtifactSourceStepOptions): this {
        const sourceRefs = this.toSourceBindings(opts.source);
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds, opts.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.OCRCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => {
                const artifact = this.resolveFirstSourceArtifact(sourceRefs, state.values);
                return {
                    input: {
                        file: toPipelineFileInput(artifact),
                        ...(input.filename ? { filename: input.filename } : {}),
                        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
                        ...(input.language ? { language: input.language } : {}),
                        ...(input.structured ? { structured: input.structured } : {}),
                        ...(input.includeBoundingBoxes !== undefined
                            ? { includeBoundingBoxes: input.includeBoundingBoxes }
                            : {}),
                        ...(input.prompt
                            ? {
                                  prompt: this.resolveTextInput(input.prompt, state.values)
                              }
                            : {})
                    }
                };
            },
            {
                ...opts,
                after: mergedAfter
            }
        );
    }

    /**
     * Add a save-file step bound to an artifact-producing source step.
     *
     * @param {string} id Node id.
     * @param {PipelineSaveFileInput} input Save-file request input.
     * @param {PipelineArtifactSourceStepOptions} opts Source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    saveFile(id: string, input: PipelineSaveFileInput, opts: PipelineArtifactSourceStepOptions): this {
        const sourceRefs = this.toSourceBindings(opts.source);
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds, opts.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.SaveFileCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => {
                const artifact = this.resolveFirstSourceArtifactCandidate(sourceRefs, state.values) as any;
                const targetPath =
                    typeof input.path === "function"
                        ? input.path({ artifact, values: state.values })
                        : this.resolveFilePathTemplate(input.path, artifact, state.values);

                const base64 = typeof artifact?.base64 === "string" ? artifact.base64.trim() : "";
                if (base64) {
                    return {
                        input: {
                            path: targetPath,
                            contentType: "base64",
                            base64
                        }
                    };
                }

                return {
                    input: {
                        path: targetPath,
                        contentType: "text",
                        text: extractPipelineText(artifact)
                    }
                };
            },
            {
                ...opts,
                after: mergedAfter
            }
        );
    }

    /**
     * Add a video generation step.
     *
     * @param {string} id Node id.
     * @param {PipelineVideoGenerateInput} input Video generation request input.
     * @param {PipelineTextSourceOptionalStepOptions=} opts Optional source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    videoGenerate(id: string, input: PipelineVideoGenerateInput, opts?: PipelineTextSourceOptionalStepOptions): this {
        const sourceRefs = opts?.source ? this.toSourceBindings(opts.source) : [];
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds.length > 0 ? sourceIds : undefined, opts?.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.VideoGenerationCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => ({
                input: {
                    prompt: this.resolveTextInput(
                        input.prompt ??
                            (sourceRefs.length > 0 ? this.resolveSourceTexts(sourceRefs, state.values).join("\n\n") : ""),
                        state.values
                    ),
                    ...(input.params ? { params: input.params } : {})
                }
            }),
            {
                ...(opts ?? {}),
                after: mergedAfter
            }
        );
    }

    /**
     * Add a video remix step.
     *
     * @param {string} id Node id.
     * @param {PipelineVideoRemixInput} input Video remix request input.
     * @param {PipelineArtifactSourceOptionalStepOptions=} opts Optional source binding and step options.
     * @returns {this} Fluent pipeline instance.
     * @throws {PipelineError} When no source video id can be resolved.
     */
    videoRemix(id: string, input: PipelineVideoRemixInput, opts?: PipelineArtifactSourceOptionalStepOptions): this {
        const sourceRefs = opts?.source ? this.toSourceBindings(opts.source) : [];
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds.length > 0 ? sourceIds : undefined, opts?.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.VideoRemixCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => {
                const sourceVideoId =
                    typeof input.sourceVideoId === "function" ? input.sourceVideoId(state.values) : input.sourceVideoId;
                const sourceArtifact =
                    sourceRefs.length > 0 ? (this.resolveFirstSourceArtifact(sourceRefs, state.values) as any) : undefined;
                const resolvedSourceVideoId = String(sourceVideoId ?? sourceArtifact?.id ?? "");
                if (!resolvedSourceVideoId) {
                    throw new PipelineError("videoRemix requires sourceVideoId or a valid `source` step with an artifact id.");
                }
                return {
                    input: {
                        sourceVideoId: resolvedSourceVideoId,
                        ...(input.prompt ? { prompt: this.resolveTextInput(input.prompt, state.values) } : {}),
                        ...(input.params ? { params: input.params } : {})
                    }
                };
            },
            {
                ...(opts ?? {}),
                after: mergedAfter
            }
        );
    }

    /**
     * Add a video download step.
     *
     * @param {string} id Node id.
     * @param {PipelineVideoDownloadInput} input Video download request input.
     * @param {PipelineArtifactSourceOptionalStepOptions=} opts Optional source binding and step options.
     * @returns {this} Fluent pipeline instance.
     */
    videoDownload(id: string, input: PipelineVideoDownloadInput, opts?: PipelineArtifactSourceOptionalStepOptions): this {
        const sourceRefs = opts?.source ? this.toSourceBindings(opts.source) : [];
        const sourceIds = sourceRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
        const mergedAfter = this.mergeAfterDependencies(sourceIds.length > 0 ? sourceIds : undefined, opts?.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.VideoDownloadCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => {
                const sourceArtifact =
                    sourceRefs.length > 0 ? (this.resolveFirstSourceArtifact(sourceRefs, state.values) as any) : undefined;
                const resolvedVideoUri =
                    input.videoUri !== undefined
                        ? this.resolveTextInput(input.videoUri, state.values)
                        : String(sourceArtifact?.url ?? "");
                const resolvedVideoId =
                    typeof input.videoId === "function"
                        ? input.videoId(state.values)
                        : (input.videoId ?? String(sourceArtifact?.id ?? `video-download-${Date.now()}`));
                return {
                    input: {
                        videoUri: resolvedVideoUri,
                        ...(input.variant ? { variant: input.variant } : {}),
                        videoId: String(resolvedVideoId)
                    }
                };
            },
            {
                ...(opts ?? {}),
                after: mergedAfter
            }
        );
    }

    /**
     * Add a video analysis step.
     *
     * @param {string} id Node id.
     * @param {PipelineVideoAnalyzeInput} input Video analysis request input.
     * @param {PipelineVideoSourceStepsOptions} opts Source binding and step options.
     * @returns {this} Fluent pipeline instance.
     * @throws {PipelineError} When no usable video artifact can be resolved.
     */
    videoAnalyze(id: string, input: PipelineVideoAnalyzeInput, opts: PipelineVideoSourceStepsOptions): this {
        const sourceDeps = (Array.isArray(opts.source) ? opts.source : [opts.source]).map((ref) =>
            this.resolveStepRef(this.resolveBoundSourceRef(ref))
        );
        const mergedAfter = this.mergeAfterDependencies(sourceDeps, opts.after);
        return this.capabilityStep(
            id,
            CapabilityKeys.VideoAnalysisCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => {
                const fromRefs = Array.isArray(opts.source) ? opts.source : [opts.source];
                const fromIds = fromRefs.map((ref) => this.resolveStepRef(this.resolveBoundSourceRef(ref)));
                const selected = fromIds
                    .map((stepId, index) =>
                        this.resolveSourceArtifact(
                            state.values[stepId],
                            state.values,
                            this.resolveBoundSelect(fromRefs[index], opts.select) as PipelineVideoSelect | undefined
                        )
                    )
                    .find((artifact) => {
                        // A video source is considered usable when either inline bytes or a URL is available.
                        const hasBase64 = typeof artifact?.base64 === "string" && artifact.base64.trim().length > 0;
                        const hasUrl = typeof artifact?.url === "string" && artifact.url.length > 0;
                        return hasBase64 || hasUrl;
                    });
                if (!selected) {
                    throw new PipelineError(
                        "videoAnalyze could not find a usable video artifact from the configured `source` steps."
                    );
                }
                return {
                    input: {
                        videos: [
                            {
                                ...(typeof selected.base64 === "string" && selected.base64.trim().length > 0
                                    ? { base64: selected.base64 }
                                    : {}),
                                ...(typeof selected.url === "string" && selected.url.length > 0 ? { url: selected.url } : {}),
                                mimeType: String(selected.mimeType ?? "video/mp4")
                            }
                        ],
                        ...(input.prompt ? { prompt: this.resolveTextInput(input.prompt, state.values) } : {}),
                        ...(input.params ? { params: input.params } : {})
                    }
                };
            },
            {
                ...opts,
                after: mergedAfter
            }
        );
    }

    /**
     * Add an approval-gate step.
     *
     * @param {string} id Node id.
     * @param {PipelineApprovalGateInput} input Approval gate request input.
     * @param {PipelineStepOptions=} opts Pipeline step options.
     * @returns {this} Fluent pipeline instance.
     */
    approvalGate(id: string, input: PipelineApprovalGateInput, opts?: PipelineStepOptions): this {
        return this.capabilityStep(
            id,
            CapabilityKeys.ApprovalGateCapabilityKey,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => ({
                input: typeof input.input === "function" ? input.input(state.values) : input.input
            }),
            opts
        );
    }

    /**
     * Register final output mapper.
     *
     * @param {(values: StepValues) => TOutput} mapper Output mapper.
     * @returns {this} Fluent pipeline instance.
     */
    output(mapper: (values: StepValues) => TOutput): this {
        this.builder.aggregate((results) => mapper(results));
        return this;
    }

    /**
     * Register final aggregate mapper (WorkflowBuilder-compatible alias).
     *
     * @param {(results: Record<string, unknown>, state: WorkflowState) => TOutput} mapper Aggregate mapper.
     * @returns {this} Fluent pipeline instance.
     */
    aggregate(mapper: (results: Record<string, unknown>, state: WorkflowState) => TOutput): this {
        this.builder.aggregate(mapper);
        return this;
    }

    /**
     * Build the underlying workflow.
     *
     * @returns {Workflow<TOutput>} Built workflow definition.
     */
    build(): Workflow<TOutput> {
        return this.builder.build();
    }

    /**
     * Internal helper for chat/chatStream request construction with optional request/input overrides.
     *
     * @private
     * @param {string} id Node id.
     * @param {typeof CapabilityKeys.ChatCapabilityKey | typeof CapabilityKeys.ChatStreamCapabilityKey} capability Chat capability key.
     * @param {StepTextInput} promptOrTemplate Prompt value or template factory.
     * @param {PipelineTextStepOptions=} opts Step options.
     * @returns {this} Fluent pipeline instance.
     */
    private capabilityTextStep(
        id: string,
        capability: typeof CapabilityKeys.ChatCapabilityKey | typeof CapabilityKeys.ChatStreamCapabilityKey,
        promptOrTemplate: StepTextInput,
        opts?: PipelineTextStepOptions
    ): this {
        // Normalize functional/static override declarations into a concrete object for this execution.
        const resolveOverrides = (
            overrides: Record<string, unknown> | ((values: StepValues) => Record<string, unknown>) | undefined,
            values: StepValues
        ): Record<string, unknown> | undefined => {
            if (!overrides) {
                return undefined;
            }
            return typeof overrides === "function" ? overrides(values) : overrides;
        };

        return this.capabilityStep(
            id,
            capability,
            (_ctx: MultiModalExecutionContext, state: WorkflowState) => {
                const requestOverrides = resolveOverrides(opts?.requestOverrides, state.values) ?? {};
                const inputOverrides = resolveOverrides(opts?.inputOverrides, state.values) ?? {};
                return {
                    ...requestOverrides,
                    input: {
                        messages: [
                            {
                                role: "user",
                                content: [{ type: "text", text: this.resolveTextInput(promptOrTemplate, state.values) }]
                            }
                        ],
                        ...inputOverrides
                    }
                };
            },
            opts
        );
    }

    /**
     * Registers a capability-backed step and optionally inserts a post-normalization adapter node.
     *
     * @private
     * @param {string} id Node id.
     * @param {string} capability Capability identifier.
     * @param {any} requestOrFactory Request payload or factory.
     * @param {PipelineStepOptions=} opts Step options.
     * @returns {this} Fluent pipeline instance.
     */
    private capabilityStep(id: string, capability: string, requestOrFactory: any, opts?: PipelineStepOptions): this {
        const { after, normalize, keepRaw, ...rest } = opts ?? {};
        const mappedOptions = this.mapStepOptions(rest);
        const resolvedAfter = this.resolveStepRefs(after);
        if (!normalize) {
            if (resolvedAfter) {
                this.builder.capabilityAfter(resolvedAfter, id, capability as any, requestOrFactory, mappedOptions);
            } else {
                this.builder.capabilityNode(id, capability as any, requestOrFactory, mappedOptions);
            }
            return this;
        }

        const rawNodeId = `${id}__raw`;
        // Register the capability call under a hidden node when normalization is requested.
        if (resolvedAfter) {
            this.builder.capabilityAfter(resolvedAfter, rawNodeId, capability as any, requestOrFactory, mappedOptions);
        } else {
            this.builder.capabilityNode(rawNodeId, capability as any, requestOrFactory, mappedOptions);
        }

        // Add an adapter node that transforms raw provider output into normalized workflow output.
        this.builder.after(rawNodeId, id, (_ctx, client, _runner, state) => {
            const rawValue = state.values[rawNodeId];
            const normalized = this.applyNormalization(capability, normalize, rawValue, state.values);
            const output = keepRaw ? { value: normalized, raw: rawValue } : normalized;

            const job = new GenericJob<undefined, unknown>(undefined, false, async () => ({
                output,
                rawResponse: keepRaw ? rawValue : undefined,
                id: `pipeline-normalize-${id}-${Date.now()}`,
                metadata: { normalized: true }
            }));

            // Normalization is executed as a regular job so it appears consistently in workflow/job telemetry.
            if (client.jobManager) {
                client.jobManager.addJob(job);
            } else {
                console.warn(
                    `Pipeline normalization for node "${id}" is executing without a job manager. 
                    Ensure the workflow client has a job manager configured for full visibility.`
                );
            }
            return job;
        });

        return this;
    }

    /**
     * Applies output normalization strategy for a step.
     *
     * @private
     * @param {string} capability Capability key that produced the output.
     * @param {PipelineNormalizePreset | PipelineNormalizeFn} normalize Normalization strategy.
     * @param {unknown} output Raw step output.
     * @param {StepValues} values Workflow values (available for custom normalization functions).
     * @returns {unknown} Normalized output.
     */
    private applyNormalization(
        capability: string,
        normalize: PipelineNormalizePreset | PipelineNormalizeFn,
        output: unknown,
        values: StepValues
    ): unknown {
        if (typeof normalize === "function") {
            return normalize(output, values);
        }
        switch (normalize) {
            case "text":
                return this.extractNormalizedText(capability, output);
            case "artifact":
                return extractPipelineAudioArtifact(output);
            case "image":
                return extractPipelineImageReference(output);
            default:
                return output;
        }
    }

    /**
     * Resolve user-facing text for built-in text-producing capabilities before
     * falling back to the loose recursive text extractor.
     *
     * @private
     * @param {string} capability Capability key that produced the output.
     * @param {unknown} output Raw step output.
     * @returns {string} Best-effort normalized text payload.
     */
    private extractNormalizedText(capability: string, output: unknown): string {
        switch (capability) {
            case CapabilityKeys.ChatCapabilityKey:
            case CapabilityKeys.ChatStreamCapabilityKey:
            case CapabilityKeys.AudioTranscriptionCapabilityKey:
            case CapabilityKeys.AudioTranslationCapabilityKey: {
                const strict = this.extractAssistantMessageText(output);
                if (strict) {
                    return strict;
                }
                break;
            }
            case CapabilityKeys.OCRCapabilityKey: {
                const strict = this.extractOCRText(output);
                if (strict) {
                    return strict;
                }
                break;
            }
            default:
                break;
        }
        return extractPipelineText(output);
    }

    /**
     * Extract assistant-authored text from normalized chat-like payloads.
     *
     * This intentionally ignores metadata/raw container fields so terminal
     * markers such as `completed` do not leak into `normalize: "text"` output.
     *
     * @private
     * @param {unknown} output Raw capability output.
     * @returns {string} Assistant text content, if available.
     */
    private extractAssistantMessageText(output: unknown): string {
        if (typeof output === "string") {
            return output.trim();
        }

        const messages = Array.isArray(output) ? output : [output];
        const collected: string[] = [];

        for (const message of messages) {
            if (!message || typeof message !== "object") {
                continue;
            }

            const typedMessage = message as { role?: unknown; content?: unknown };
            if (typedMessage.role !== undefined && typedMessage.role !== "assistant") {
                continue;
            }

            const content = typedMessage.content;
            if (!Array.isArray(content)) {
                continue;
            }

            for (const part of content) {
                if (!part || typeof part !== "object") {
                    continue;
                }
                const typedPart = part as { type?: unknown; text?: unknown };
                if (typedPart.type !== undefined && typedPart.type !== "text") {
                    continue;
                }
                if (typeof typedPart.text !== "string") {
                    continue;
                }
                const trimmed = typedPart.text.trim();
                if (!trimmed) {
                    continue;
                }
                collected.push(trimmed);
            }
        }

        return collected.join("\n").trim();
    }

    /**
     * Extract readable OCR text from normalized OCR output.
     *
     * @private
     * @param {unknown} output Raw OCR capability output.
     * @returns {string} OCR text content, if available.
     */
    private extractOCRText(output: unknown): string {
        const documents = Array.isArray(output) ? output : [output];
        const collected: string[] = [];

        for (const document of documents) {
            if (!document || typeof document !== "object") {
                continue;
            }

            const typedDocument = document as { fullText?: unknown; pages?: unknown };
            if (typeof typedDocument.fullText === "string" && typedDocument.fullText.trim().length > 0) {
                collected.push(typedDocument.fullText.trim());
                continue;
            }

            if (!Array.isArray(typedDocument.pages)) {
                continue;
            }

            for (const page of typedDocument.pages) {
                if (!page || typeof page !== "object") {
                    continue;
                }
                const fullText = (page as { fullText?: unknown }).fullText;
                if (typeof fullText !== "string" || fullText.trim().length === 0) {
                    continue;
                }
                collected.push(fullText.trim());
            }
        }

        return collected.join("\n\n").trim();
    }

    /**
     * Maps pipeline-level step options to WorkflowBuilder capability node options.
     *
     * @private
     * @param {Omit<PipelineStepOptions, "after">} opts Pipeline step options.
     * @returns {WorkflowCapabilityNodeOptions | undefined} Workflow node capability options.
     */
    private mapStepOptions(opts: Omit<PipelineStepOptions, "after">): WorkflowCapabilityNodeOptions | undefined {
        return {
            providerChain: this.resolveProviderChain(opts),
            timeoutMs: opts.timeoutMs,
            retry: opts.retry,
            condition: opts.when ? (state: WorkflowState) => opts.when!(state.values) : undefined,
            addToManager: opts.addToManager
        };
    }

    /**
     * Resolves provider selection preference from options.
     *
     * @private
     * @param {Omit<PipelineStepOptions, "after">} opts Pipeline step options.
     * @returns {ProviderRef[] | undefined} Provider chain for capability execution.
     */
    private resolveProviderChain(opts: Omit<PipelineStepOptions, "after">): ProviderRef[] | undefined {
        if (opts.providerChain) {
            return opts.providerChain;
        }
        if (opts.provider) {
            return [{ providerType: opts.provider, connectionName: "default" }];
        }
        return undefined;
    }

    /**
     * Resolves text input from either static text/template or factory function.
     *
     * @private
     * @param {StepTextInput} input Text input source.
     * @param {StepValues} values Workflow values.
     * @returns {string} Resolved text.
     */
    private resolveTextInput(input: StepTextInput, values: StepValues): string {
        if (typeof input === "function") {
            return String(input(values));
        }
        return resolvePipelineTemplate(input, values);
    }

    /**
     * Resolves a save-file path template with support for legacy and template tokens.
     *
     * @private
     * @param {string} template Path template.
     * @param {any} artifact Source artifact.
     * @param {StepValues} values Workflow values.
     * @returns {string} Resolved target file path.
     */
    private resolveFilePathTemplate(template: string, artifact: any, values: StepValues): string {
        const artifactId = String(artifact?.id ?? "");
        // Preserve compatibility with older token names while supporting new template syntax.
        const withLegacyTokens = template.split("{audioId}").join(artifactId).split("{artifactId}").join(artifactId);

        return withLegacyTokens.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, tokenRaw) => {
            const token = String(tokenRaw).trim();
            if (token === "source.id") {
                return artifactId;
            }
            return extractPipelineText(values[token]);
        });
    }

    /**
     * Resolves source value into text using an optional custom selector.
     *
     * @private
     * @param {unknown} sourceValue Source step output.
     * @param {StepValues} values Workflow values.
     * @param {PipelineTextSelect=} select Optional source selector.
     * @returns {string} Resolved text value.
     */
    private resolveSourceText(sourceValue: unknown, values: StepValues, select?: PipelineTextSelect): string {
        if (typeof select === "function") {
            return String(select(sourceValue, values));
        }
        return extractPipelineText(sourceValue);
    }

    /**
     * Resolves source value into an artifact-like object using an optional selector.
     *
     * @private
     * @param {unknown} sourceValue Source step output.
     * @param {StepValues} values Workflow values.
     * @param {PipelineArtifactSelect | PipelineVideoSelect=} select Optional source selector.
     * @returns {PipelineSourceArtifact} Resolved artifact object.
     */
    private resolveSourceArtifact(
        sourceValue: unknown,
        values: StepValues,
        select?: PipelineArtifactSelect | PipelineVideoSelect
    ): PipelineSourceArtifact {
        if (typeof select === "function") {
            return select(sourceValue, values);
        }
        return extractPipelineAudioArtifact(sourceValue) as PipelineSourceArtifact;
    }

    /**
     * Resolves source value into a canonical image reference using an optional selector.
     *
     * @private
     * @param {unknown} sourceValue Source step output.
     * @param {StepValues} values Workflow values.
     * @param {PipelineImageSelect=} select Optional source selector.
     * @returns {ClientReferenceImage} Resolved image reference.
     */
    private resolveSourceImageReference(
        sourceValue: unknown,
        values: StepValues,
        select?: PipelineImageSelect
    ): ClientReferenceImage {
        if (typeof select === "function") {
            return select(sourceValue, values);
        }
        return extractPipelineImageReference(sourceValue);
    }

    /**
     * Normalizes source bindings into an array for helpers that support fan-in.
     *
     * @private
     * @param {T | T[]} source Source binding(s).
     * @returns {T[]} Normalized source binding list.
     */
    private toSourceBindings<T>(source: T | T[]): T[] {
        return Array.isArray(source) ? source : [source];
    }

    /**
     * Resolves multiple source bindings into text fragments.
     *
     * @private
     * @param {(PipelineTextSourceRef)[]} refs Source references.
     * @param {StepValues} values Workflow values.
     * @returns {string[]} Resolved non-empty text fragments.
     */
    private resolveSourceTexts(refs: PipelineTextSourceRef[], values: StepValues): string[] {
        return refs
            .map((ref) => {
                const stepId = this.resolveStepRef(this.resolveBoundSourceRef(ref));
                const select = this.resolveBoundSelect(ref, undefined) as PipelineTextSelect | undefined;
                return this.resolveSourceText(values[stepId], values, select).trim();
            })
            .filter((text) => text.length > 0);
    }

    /**
     * Resolves multiple source bindings into artifact values.
     *
     * @private
     * @param {(PipelineArtifactSourceRef | PipelineVideoSourceRef)[]} refs Source references.
     * @param {StepValues} values Workflow values.
     * @returns {PipelineSourceArtifact[]} Resolved artifacts.
     */
    private resolveSourceArtifacts(
        refs: Array<PipelineArtifactSourceRef | PipelineVideoSourceRef>,
        values: StepValues
    ): PipelineSourceArtifact[] {
        return refs.map((ref) => {
            const stepId = this.resolveStepRef(this.resolveBoundSourceRef(ref));
            const select = this.resolveBoundSelect(ref, undefined) as PipelineArtifactSelect | PipelineVideoSelect | undefined;
            return this.resolveSourceArtifact(values[stepId], values, select);
        });
    }

    /**
     * Resolves the first usable artifact from one or more source bindings.
     *
     * @private
     * @param {(PipelineArtifactSourceRef | PipelineVideoSourceRef)[]} refs Source references.
     * @param {StepValues} values Workflow values.
     * @returns {PipelineSourceArtifact} First resolved artifact.
     * @throws {PipelineError} When no usable artifact can be resolved.
     */
    private resolveFirstSourceArtifact(
        refs: Array<PipelineArtifactSourceRef | PipelineVideoSourceRef>,
        values: StepValues
    ): PipelineSourceArtifact {
        const artifact = this.resolveSourceArtifacts(refs, values).find((candidate) => {
            const hasId = typeof candidate?.id === "string" && candidate.id.length > 0;
            const hasUrl = typeof candidate?.url === "string" && candidate.url.length > 0;
            const hasBase64 = typeof candidate?.base64 === "string" && candidate.base64.trim().length > 0;
            return hasId || hasUrl || hasBase64;
        });
        if (!artifact) {
            throw new PipelineError("Could not resolve a usable artifact from the configured `source` step(s).");
        }
        return artifact;
    }

    /**
     * Resolves the first source artifact without imposing transport-field requirements.
     *
     * This is used by helpers such as `saveFile` that can persist text-only payloads
     * and therefore do not require `id`, `url`, or `base64` to be present.
     *
     * @private
     * @param {(PipelineArtifactSourceRef | PipelineVideoSourceRef)[]} refs Source references.
     * @param {StepValues} values Workflow values.
     * @returns {PipelineSourceArtifact} First resolved artifact candidate.
     * @throws {PipelineError} When no source artifact can be resolved.
     */
    private resolveFirstSourceArtifactCandidate(
        refs: Array<PipelineArtifactSourceRef | PipelineVideoSourceRef>,
        values: StepValues
    ): PipelineSourceArtifact {
        const artifact = this.resolveSourceArtifacts(refs, values)[0];
        if (!artifact) {
            throw new PipelineError("Could not resolve an artifact from the configured `source` step(s).");
        }
        return artifact;
    }

    /**
     * Resolves multiple image source bindings into canonical image references.
     *
     * @private
     * @param {PipelineImageSourceRef[]} refs Source references.
     * @param {StepValues} values Workflow values.
     * @returns {ClientReferenceImage[]} Resolved image references.
     */
    private resolveSourceImageReferences(refs: PipelineImageSourceRef[], values: StepValues): ClientReferenceImage[] {
        return refs.map((ref) => {
            const stepId = this.resolveStepRef(this.resolveBoundSourceRef(ref));
            const select = this.resolveBoundSelect(ref, undefined) as PipelineImageSelect | undefined;
            return this.resolveSourceImageReference(values[stepId], values, select);
        });
    }

    /**
     * Merges required and optional dependencies into normalized dependency shape.
     *
     * @private
     * @param {PipelineStepRef | PipelineStepRef[] | undefined} required Required dependencies.
     * @param {PipelineStepRef | PipelineStepRef[] | undefined} optional Optional dependencies.
     * @returns {string | string[] | undefined} Normalized dependency list.
     */
    private mergeAfterDependencies(
        required: PipelineStepRef | PipelineStepRef[] | undefined,
        optional: PipelineStepRef | PipelineStepRef[] | undefined
    ): string | string[] | undefined {
        const reqRefs = required ? (Array.isArray(required) ? required : [required]) : [];
        const optRefs = optional ? (Array.isArray(optional) ? optional : [optional]) : [];
        const req = reqRefs.map((ref) => this.resolveStepRef(ref));
        const opt = optRefs.map((ref) => this.resolveStepRef(ref));
        // Dedupe and discard empty refs to avoid invalid dependency edges.
        const merged = Array.from(new Set([...req, ...opt].filter((v) => v.length > 0)));
        if (merged.length === 0) {
            return undefined;
        }
        if (merged.length === 1) {
            return merged[0];
        }
        return merged;
    }

    /**
     * Build a typed step handle that can be reused in `source`/`after`.
     *
     * @template TOutputStep Step output type.
     * @param {string} id Step id.
     * @returns {PipelineStepHandle<TOutputStep>} Typed step handle.
     */
    step<TOutputStep = unknown>(id: string): PipelineStepHandle<TOutputStep> {
        return { id };
    }

    /**
     * Type guard for source binding objects.
     *
     * @private
     * @param {unknown} ref Source reference candidate.
     * @returns {ref is PipelineSourceBinding<unknown>} True when candidate is source binding.
     */
    private isSourceBinding(ref: unknown): ref is PipelineSourceBinding<unknown> {
        return Boolean(ref && typeof ref === "object" && "step" in (ref as Record<string, unknown>));
    }

    /**
     * Resolves a bound source reference to a step reference.
     *
     * @private
     * @param {PipelineStepRef | PipelineSourceBinding<unknown>} ref Source reference.
     * @returns {PipelineStepRef} Step reference.
     */
    private resolveBoundSourceRef(ref: PipelineStepRef | PipelineSourceBinding<unknown>): PipelineStepRef {
        return this.isSourceBinding(ref) ? ref.step : ref;
    }

    /**
     * Resolves selector precedence for source binding and fallback selector.
     *
     * @private
     * @param {PipelineStepRef | PipelineSourceBinding<unknown> | undefined} ref Source reference.
     * @param {unknown} fallback Fallback selector.
     * @returns {unknown} Effective selector.
     */
    private resolveBoundSelect(ref: PipelineStepRef | PipelineSourceBinding<unknown> | undefined, fallback: unknown): unknown {
        if (this.isSourceBinding(ref)) {
            return ref.select ?? fallback;
        }
        return fallback;
    }

    /**
     * Resolves a step reference object/string to a concrete step id.
     *
     * @private
     * @param {PipelineStepRef} ref Step reference.
     * @returns {string} Step id.
     */
    private resolveStepRef(ref: PipelineStepRef): string {
        if (typeof ref === "string") {
            return ref;
        }
        return String(ref?.id ?? "");
    }

    /**
     * Resolves one-or-many step references to workflow-compatible dependency representation.
     *
     * @private
     * @param {PipelineStepRef | PipelineStepRef[] | undefined} refs Dependency references.
     * @returns {string | string[] | undefined} Normalized dependency representation.
     */
    private resolveStepRefs(refs: PipelineStepRef | PipelineStepRef[] | undefined): string | string[] | undefined {
        if (!refs) {
            return undefined;
        }
        const list = Array.isArray(refs) ? refs : [refs];
        const resolved = list.map((ref) => this.resolveStepRef(ref)).filter((v) => v.length > 0);
        if (resolved.length === 0) {
            return undefined;
        }
        if (resolved.length === 1) {
            return resolved[0];
        }
        return resolved;
    }
}
