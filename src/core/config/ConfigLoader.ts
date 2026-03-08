import dotenv from "dotenv";
import config from "config";
import {
    AIProviderType,
    AppConfig,
    ProviderConnectionConfig,
    validateBoolean,
    validateNonNegativeInteger
} from "#root/index.js";

/**
 * Loads and validates the application configuration, merging config files and environment variables.
 *
 * - Loads .env variables and merges with node-config files
 * - Validates provider and connection presence
 * - Resolves API keys from environment variables
 * - Returns a fully resolved AppConfig object
 *
 * @returns AppConfig loaded from config files and environment variables
 * @throws Error if no provider or required config is found
 */
export function loadAppConfig(): AppConfig {
    dotenv.config(); // load .env variables

    // Load config from node-config (already merges default + NODE_ENV json)
    const rawConfig = config.util.toObject();

    // Top-level load as partial to allow for further processing/validation.
    const parsed = rawConfig as AppConfig;

    // Minimal validations
    if (!parsed.providers || Object.keys(parsed.providers).length === 0) {
        throw new Error("At least one provider must be defined in config");
    }

    const appConfig: Record<any, any> = parsed.appConfig || {};
    validateNonNegativeInteger(appConfig.maxConcurrency, "maxConcurrency");
    validateNonNegativeInteger(appConfig.maxQueueSize, "maxQueueSize");
    validateNonNegativeInteger(appConfig.maxStoredResponseChunks, "maxStoredResponseChunks");
    validateNonNegativeInteger(appConfig.maxRawBytesPerJob, "maxRawBytesPerJob");
    validateNonNegativeInteger(appConfig.remoteImageFetchTimeoutMs, "remoteImageFetchTimeoutMs");
    validateNonNegativeInteger(appConfig.maxRemoteImageBytes, "maxRemoteImageBytes");
    validateBoolean(appConfig.storeRawResponses, "storeRawResponses");
    validateBoolean(appConfig.stripBinaryPayloadsInSnapshotsAndTimeline, "stripBinaryPayloadsInSnapshotsAndTimeline");
    const resolvedProviders: Record<string, Record<string, ProviderConnectionConfig>> = {};

    // For each provider type in config
    for (const providerType of Object.keys(parsed.providers)) {
        const connections = parsed.providers[providerType as AIProviderType];

        resolvedProviders[providerType] = {};

        // For each connection under the provider type
        for (const connectionName of Object.keys(connections)) {
            const connectionConfig = connections[connectionName] as ProviderConnectionConfig;

            // Resolve API key env variable name from config first.
            const apiKeyEnvVar = connectionConfig.apiKeyEnvVar;
            if (!apiKeyEnvVar) {
                throw new Error(`Provider '${providerType}' connection '${connectionName}' missing 'apiKeyEnvVar'`);
            }

            // Then resolve the actual secret from process.env at runtime.
            const apiKey = process.env[apiKeyEnvVar];
            if (!apiKey) {
                throw new Error(
                    `Environment variable '${apiKeyEnvVar}' not set for provider '${providerType}' connection '${connectionName}'`
                );
            }

            // Construct final provider config
            resolvedProviders[providerType][connectionName] = {
                ...connectionConfig,
                apiKey // Inject the actual key
            };
        }
    }

    return { appConfig, providers: resolvedProviders } as AppConfig;
}
