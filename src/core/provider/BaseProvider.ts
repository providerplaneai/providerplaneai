/**
 * @module core/provider/BaseProvider.ts
 * @description Abstract base class for provider implementations and shared capability wiring.
 */
import {
    AIProviderType,
    BuiltInCapabilityKey,
    CapabilityConfig,
    CapabilityExecutor,
    CapabilityKeyType,
    CapabilityMap,
    CapabilityUnsupportedError,
    CustomCapabilityKey,
    ProviderCapability,
    ProviderConnectionConfig
} from "#root/index.js";

/**
 * Abstract base class for all AI providers.
 *
 * Provides shared helpers and state management for provider implementations.
 *
 * Responsibilities:
 * - Store and manage provider configuration
 * - Register and check supported capabilities
 * - Merge provider defaults, model configs, and runtime options
 * - Offer type-safe capability checks
 *
 * Does not implement `Provider` directly, but is intended for extension by concrete provider
 * classes.
 */
export abstract class BaseProvider {
    /**
     * Type of this provider (OpenAI, Anthropic, Gemini, etc.)
     */
    readonly providerType: AIProviderType;
    /**
     * Current connection config
     */
    protected config: ProviderConnectionConfig | null = null;
    /**
     * Support provider capabilities
     */
    protected capabilities: Partial<CapabilityMap> = {};

    protected executors?: Map<CapabilityKeyType, CapabilityExecutor<any, any, any>>;

    /**
     * Base constructor.
     *
     * @param {AIProviderType} providerType - Type of the provider, used for registration and logging.
     */
    public constructor(providerType: AIProviderType) {
        this.providerType = providerType;
    }

    /**
     * Initialize the provider with a connection configuration.
     * Must be implemented by concrete providers.
     *
     * @param {ProviderConnectionConfig} _config - Connection configuration.
     * @throws {Error} Always, because concrete providers must override this method.
     */
    init(_config: ProviderConnectionConfig) {
        throw new Error("init() Not implemented");
    }

    /**
     * Check if the provider has been initialized.
     *
     * @returns {boolean} `true` when the provider has been initialized.
     */
    public isInitialized(): boolean {
        return this.config !== null;
    }

    /**
     * Returns the canonical provider identifier.
     *
     * @returns {AIProviderType} Provider identifier.
     */
    public getProviderType(): AIProviderType {
        return this.providerType;
    }

    /**
     * Returns the currently registered capability implementations for this provider.
     *
     * @returns {Partial<CapabilityMap>} Registered capability map.
     */
    public getCapabilities(): Partial<CapabilityMap> {
        return this.capabilities;
    }

    private resolveCapability<C extends CapabilityKeyType>(
        capability: C
    ): C extends keyof CapabilityMap ? CapabilityMap[C] : ProviderCapability {
        const capabilities = this.capabilities as Record<string, ProviderCapability | undefined>;
        if (capabilities[capability]) {
            return capabilities[capability] as C extends keyof CapabilityMap ? CapabilityMap[C] : ProviderCapability;
        }

        if (this.executors?.has(capability)) {
            // Client-registered executors may be used for custom capabilities and are resolved
            // through this fallback path by design.
            return this.executors.get(capability) as unknown as C extends keyof CapabilityMap
                ? CapabilityMap[C]
                : ProviderCapability;
        }

        throw new CapabilityUnsupportedError(this.providerType, capability);
    }

    /**
     * Returns the implementation registered for a capability key.
     *
     * @template C - Capability key type being resolved.
     * @param {C} capability - Capability key to resolve.
     * @returns {C extends keyof CapabilityMap ? CapabilityMap[C] : ProviderCapability} Registered capability implementation.
     * @throws {CapabilityUnsupportedError} When the capability is not registered.
     */
    public getCapability<C extends CapabilityKeyType>(
        capability: C
    ): C extends keyof CapabilityMap ? CapabilityMap[C] : ProviderCapability {
        return this.resolveCapability(capability);
    }

    /**
     * Type-safe runtime check for a capability.
     * Allows safe casting after confirming the capability is registered.
     *
     * @template C - Capability key.
     * @param {C} capability - Capability symbol.
     * @returns {boolean} `true` when the capability is registered.
     */
    public hasCapability<C extends CapabilityKeyType>(capability: C): boolean {
        const capabilities = this.capabilities as Record<string, ProviderCapability | undefined>;
        return !!capabilities[capability] || !!this.executors?.has(capability);
    }

    /**
     * Register a capability implementation.
     * Called by concrete providers to declare support for a capability.
     *
     * @template C - Built-in capability key.
     * @param {C} capability - Capability symbol.
     * @param {CapabilityMap[C]} impl - Implementation of the capability.
     */
    protected registerCapability<C extends BuiltInCapabilityKey>(capability: C, impl: CapabilityMap[C]): void;
    /**
     * Registers a custom capability implementation.
     *
     * @param {CustomCapabilityKey} capability - Custom capability key.
     * @param {ProviderCapability} impl - Capability implementation.
     */
    protected registerCapability(capability: CustomCapabilityKey, impl: ProviderCapability): void;
    protected registerCapability(capability: CapabilityKeyType, impl: ProviderCapability) {
        const capabilities = this.capabilities as Record<string, ProviderCapability | undefined>;
        capabilities[capability] = impl;
    }

    /**
     * Attaches client-registered executors used for dispatching custom capabilities.
     *
     * @param {Map<CapabilityKeyType, CapabilityExecutor<any, any, any>>} executors - Executor map.
     */
    public setClientExecutors(executors: Map<CapabilityKeyType, CapabilityExecutor<any, any, any>>) {
        this.executors = executors;
    }

    /**
     * Deep-merge multiple objects.
     * Arrays override completely, objects are recursively merged, primitives override.
     * Used for merging provider defaults, model configurations, and runtime options.
     *
     * @param {...any[]} sources - Objects to merge.
     * @returns {any} Deep-merged object.
     */
    protected mergeOptions(...sources: any[]): any {
        const result: any = {};

        for (const src of sources) {
            if (!src) {
                continue;
            }
            this.mergeOptionsInto(result, src);
        }

        return result;
    }

    /**
     * Merges a source object into a target object.
     * Arrays override, plain objects are deep-merged, primitives override.
     *
     * @param {Record<string, unknown>} target - Target object to mutate.
     * @param {Record<string, unknown>} source - Source object to read from.
     */
    private mergeOptionsInto(target: Record<string, unknown>, source: Record<string, unknown>) {
        const stack: Array<{ dst: Record<string, unknown>; src: Record<string, unknown> }> = [{ dst: target, src: source }];

        while (stack.length > 0) {
            const frame = stack.pop()!;
            const { dst, src } = frame;

            for (const [key, value] of Object.entries(src)) {
                if (Array.isArray(value)) {
                    dst[key] = [...value];
                    continue;
                }

                if (this.isMergeableObject(value)) {
                    const current = dst[key];
                    if (!this.isMergeableObject(current)) {
                        dst[key] = {};
                    }
                    stack.push({
                        dst: dst[key] as Record<string, unknown>,
                        src: value as Record<string, unknown>
                    });
                    continue;
                }

                dst[key] = value;
            }
        }
    }

    /**
     * Determines whether a value is a plain object that should be deep-merged.
     *
     * @param {unknown} value - Candidate value.
     * @returns {value is Record<string, unknown>} `true` for mergeable plain objects.
     */
    private isMergeableObject(value: unknown): value is Record<string, unknown> {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return false;
        }
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    /**
     * Resolve and merge configuration for a capability.
     *
     * Merge precedence (low → high):
     * 1. providerDefaults (global provider-level defaults)
     * 2. model capability defaults (models[modelName][capability])
     * 3. runtimeOptions (request-level overrides)
     *
     * Model resolution fallback:
     * runtimeOptions.model → config.defaultModels[capability] → config.defaultModel
     *
     * @param {string} capability - Name of the capability.
     * @param {any} runtimeOptions - Request-level override options.
     * @throws {Error} When a model cannot be resolved for the requested capability.
     * @returns {any} Merged configuration with keys such as `model`, `modelParams`, `providerParams`, and `generalParams`.
     */
    public getMergedOptions(capability: string, runtimeOptions: any = {}) {
        this.ensureInitialized();

        // 1) Resolve model
        const resolvedModel =
            runtimeOptions?.model ||
            (this.config!.defaultModels ? this.config!.defaultModels[capability] : undefined) ||
            this.config!.defaultModel;

        if (!resolvedModel) {
            throw new Error(`Unable to resolve model for capability='${capability}'`);
        }

        // 2) Get provider defaults (if any)
        const providerDefaults: CapabilityConfig = {
            modelParams: this.config!.providerDefaults?.modelParams || {},
            providerParams: this.config!.providerDefaults?.providerParams || {},
            generalParams: this.config!.providerDefaults?.generalParams || {}
        };

        // 3) Get model config for the capability
        const capabilityBlock: CapabilityConfig = this.config!.models?.[resolvedModel]?.[capability] || {};

        // If you haven't added providerParams/modelParams in JSON yet, treat all fields as modelParams
        const modelParamsFromConfig = capabilityBlock.modelParams || {};
        const providerParamsFromConfig = capabilityBlock.providerParams || {};
        const generalParamsFromConfig = capabilityBlock.generalParams || {};

        // 4) Runtime overrides
        const runtimeModelParams = runtimeOptions.modelParams || {};
        const runtimeProviderParams = runtimeOptions.providerParams || {};
        const runtimeGeneralParams = runtimeOptions.generalParams || {};

        // 5) Merge provider defaults => model config => runtime
        const mergedModelParams = this.mergeOptions(providerDefaults.modelParams, modelParamsFromConfig, runtimeModelParams);

        const mergedProviderParams = this.mergeOptions(
            providerDefaults.providerParams,
            providerParamsFromConfig,
            runtimeProviderParams
        );

        const mergedGeneralParams = this.mergeOptions(
            providerDefaults.generalParams,
            generalParamsFromConfig,
            runtimeGeneralParams
        );

        // Return a normalized envelope so downstream capability code can rely on
        // a stable options shape regardless of provider-specific config structure.
        return {
            model: resolvedModel,
            modelParams: mergedModelParams,
            providerParams: mergedProviderParams,
            generalParams: mergedGeneralParams
        };
    }

    /**
     * Ensures that the provider has been initialized before use.
     *
     * @throws Error if not initialized
     */
    public ensureInitialized(): void {
        if (!this.config) {
            throw new Error(`${this.providerType} provider not initialized`);
        }
    }
}
