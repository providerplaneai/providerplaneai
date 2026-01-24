import { vi } from 'vitest';

vi.mock('@google/genai', () => {
    const generateContent = vi.fn().mockResolvedValue({
        response: {
            text: () => 'Mocked text response',
        },
    });

    const embedContent = vi.fn().mockResolvedValue({
        embeddings: [
            {
                values: [
                    -0.0051713563, -0.009996508, -0.04969813, -0.0062992093,
                    0.07232459, -0.024041407, 0.07855323, 0.048741046,
                    -0.0142248515, 0.014693419, -0.042067483, 0.05249327,
                    0.033167273, -0.016506921, -0.0028276134, -0.084738605,
                    -0.018131854, -0.07743105, -0.09328259, -0.004099271,
                    0.027964368, -0.029946255, -0.0042501665, -0.010834999,
                    -0.018079547, -0.014567202, 0.066759415, -0.05079914,
                    -0.016326826, 0.012405476, 0.046972726, 0.067885466,
                    0.045280527, -0.040220097, -0.0049224, -0.026806278,
                    0.0052341805, 0.061933037, 0.055566825, -0.031059768,
                    -0.02455924, 0.033148624, -0.0018180101, 0.034768693,
                    0.028994141, 0.0037522304, 0.013499139, 0.031934235,
                    0.026074005, -0.004061283, 0.09151512, -0.000009808674,
                    -0.038877375, 0.021773849, -0.053877596, -0.029178705,
                    -0.0034357805, -0.05064246, -0.042961624, 0.0108728735,
                    0.005483486, -0.043499492, 0.013408869, -0.04134278,
                    -0.008937275, 0.029534688, -0.03780139, -0.017647253,
                    -0.09770952, 0.033155646, -0.0201807, 0.0006974823,
                    -0.016362993, -0.012630572, 0.00743328, -0.026411038,
                    -0.01629007, -0.011782586, -0.07008938, 0.008152332,
                    0.028661737, 0.047539458, 0.04303851, 0.033185743,
                    0.017915985, -0.004393272, 0.02896522, -0.052293833,
                    -0.09762958, -0.018561894, 0.04437108, -0.023443397,
                    0.052189484, 0.04405086, 0.04035528, -0.069028206,
                    -0.030712003, 0.02175142, 0.03823692, 0.100536436,
                ]
            },
            {
                values: [
                    -0.0077046105, 0.04273205, -0.023378327, 0.0009878188, 0.059017282,
                    0.0109108435, 0.0017184165, -0.0017155318, 0.006147526, -0.0014621962,
                    0.037709206, 0.006849922, 0.027017523, -0.040158518, 0.06131091,
                    -0.050592713, 0.017601088, 0.037508618, -0.05063286, 0.0072313286,
                    -0.022093032, 0.0333188, 0.03766693, -0.06882282, -0.04486376,
                    0.018551046, 0.024190472, -0.00641946, 0.029348275, -0.030372053,
                    0.06462047, 0.028961644, -0.005859123, -0.024882026, -0.0021828832,
                    0.017000234, -0.046189856, 0.021909865, 0.020494433, -0.010464267,
                    -0.0018094394, -0.03419066, -0.042780194, 0.071856655, 0.013032597,
                    -0.015498844, 0.072735965, 0.08514852, -0.052090876, 0.010849777,
                    0.038179595, 0.04453987, -0.03917843, 0.08181154, -0.03169919,
                    -0.08721914, 0.02460233, -0.030790128, 0.04781768, 0.038325585,
                    -0.033459745, -0.004920613, 0.025122004, -0.033625774, 0.020545864,
                    0.023154441, -0.0034839874, 0.0030817818, -0.055410296, 0.015896441,
                    0.010360971, -0.018335229, -0.017076628, 0.0254715, -0.010569502,
                    -0.022336626, 0.035215553, 0.0460368, -0.043959487, 0.057621103,
                    -0.021136338, 0.03446412, 0.06864954, 0.038626395, 0.020999907,
                    -0.019776806, -0.0461455, -0.029710412, -0.054809056, -0.018588765,
                    -0.01000875, 0.006449363, -0.035836525, -0.017990675, 0.015274107,
                    0.019796813, -0.06317812, -0.08229897, 0.065924555, 0.05356886,
                ]
            },
            {
                values: [
                    -0.039076317, 0.009259269, -0.030038375, 0.01563131, 0.008287454,
                    0.054154787, 0.08102057, 0.015112201, 0.013054833, 0.015204559,
                    0.012077953, 0.027431995, -0.015354717, -0.017585862, -0.004161587,
                    -0.059377555, 0.018152803, -0.019340867, -0.0883727, 0.0046993974,
                    0.003004322, -0.05202428, -0.010571765, -0.0024938262, -0.04349013,
                    0.019328874, 0.030157294, -0.027439917, -0.021868503, 0.024387807,
                    -0.016012467, 0.06329867, -0.0231643, -0.07340819, -0.047663826,
                    -0.013154845, -0.038750585, 0.03996624, 0.061503675, -0.05603906,
                    -0.038224254, -0.023508662, -0.03609583, 0.037810232, 0.05121542,
                    -0.022088954, 0.008464532, 0.06813693, -0.012769606, 0.04117686,
                    -0.025370724, -0.015730904, -0.008308572, 0.00039932472, 0.015828563,
                    -0.018680375, 0.018757218, -0.009709275, 0.08257175, 0.04746027,
                    -0.028832465, -0.040487785, -0.003408261, -0.020287642, 0.00096933515,
                    -0.059149705, -0.046230778, 0.012407883, -0.059270237, -0.026760105,
                    -0.008942716, 0.055112444, 0.018355045, 0.036622226, 0.011844333,
                    0.012572084, 0.042278964, 0.001727491, -0.04144465, 0.018977884,
                    -0.0039262203, -0.0027389675, 0.07945555, 0.030648245, 0.024710057,
                    -0.031991404, -0.05245544, -0.023703698, -0.006588221, 0.010579505,
                    0.05979925, 0.01692233, 0.012122053, 0.028028417, 0.08433381,
                    -0.07171927, -0.045522016, -0.07004317, 0.058371324, 0.07607388,
                ]
            }
        ]
    });

    const generateImages = vi.fn().mockResolvedValue({
        generatedImages: [
            {
                image: {
                    imageBytes: 'ZmFrZS1pbWFnZQ==',
                },
            },
        ],
    });

    class GoogleGenAI {
        models = {
            generateContent,
            embedContent,
            generateImages,
        };

        constructor(options?: { apiKey?: string }) {
            if (!options?.apiKey) {
                throw new Error('Missing apiKey');
            }
        }
    }

    return { GoogleGenAI };
});


import { AIRequest, CapabilityKeys, ClientChatRequest, ClientEmbeddingRequest, ClientImageAnalysisRequest, ClientModerationRequest, GeminiProvider, MultiModalExecutionContext, ProviderConnectionConfig } from '#root/index.js';
import { describe, it, expect, beforeEach } from 'vitest';


// Mocks are loaded via setupTests.ts

describe('GeminiProvider', () => {
    let provider: GeminiProvider;
    let config: ProviderConnectionConfig;
    let executionContext: MultiModalExecutionContext;

    beforeEach(() => {
        vi.unmock('#root/providers/gemini/GeminiProvider.js');
        provider = new GeminiProvider();
        config = {
            type: 'gemini',
            apiKey: 'test-key',
            defaultModel: 'gemini-pro',
            defaultModels: {
                chat: 'gemini-pro',
                moderation: 'gemini-pro',
                embed: 'gemini-embed',
                imageGeneration: 'gemini-image',
                imageAnalyze: 'gemini-image',
            },
            models: {
                'gemini-pro': {},
                'gemini-embed': {},
                'gemini-image': {},
            },
            providerDefaults: {
                modelParams: {},
                providerParams: {},
                generalParams: {},
            },
        };
        executionContext = new MultiModalExecutionContext();
    });

    it('should throw if initialized without apiKey', () => {
        expect(() => provider.init(undefined as any)).toThrow();
    });

    it('should initialize and register capabilities', () => {
        provider.init(config);
        expect(provider.isInitialized()).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ChatCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ModerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.EmbedCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageGenerationCapabilityKey)).toBe(true);
        expect(provider.hasCapability(CapabilityKeys.ImageAnalysisCapabilityKey)).toBe(true);
    });

    it('should execute chat', async () => {
        provider.init(config);
        const req: AIRequest<ClientChatRequest> = {
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [{ type: 'text', text: 'Hello Gemini' }]
                    }
                ]
            }
        };
        const res = await provider.chat(req, executionContext);
        expect(res.output).toBeDefined();
        expect(typeof res.output).toBe('string');
        expect(res.metadata?.status).toBe('completed');
    });

    it('should execute moderation', async () => {
        provider.init(config);
        const req: AIRequest<ClientModerationRequest> = { input: { input: 'test moderation' } };
        const res = await provider.moderation(req, executionContext);
        expect(res.output).toBeDefined();
        expect(res.metadata?.status).toBe('completed');
    });

    it('should execute embed', async () => {
        provider.init(config);
        const req: AIRequest<ClientEmbeddingRequest> = { input: { input: 'embed this' } };
        const res = await provider.embed(req, executionContext);
        expect(res.output).toBeDefined();
        expect(Array.isArray(res.output) || Array.isArray(res.output[0])).toBe(true);
        expect(res.metadata?.status).toBe('completed');
    });

    it('should execute image generation', async () => {
        provider.init(config);
        const req: AIRequest<{ prompt: string }> = { input: { prompt: 'a cat' } };
        const res = await provider.generateImage(req, executionContext);
        expect(res.output).toBeDefined();
        expect(Array.isArray(res.output)).toBe(true);
        expect(res.output[0]).toHaveProperty('url');
        expect(res.metadata?.status).toBe('completed');
    });

    it('should execute image analysis', async () => {
        provider.init(config);
        const req: AIRequest<ClientImageAnalysisRequest> = {
            input: {
                images: [
                    {
                        id: 'img1',
                        sourceType: 'base64',
                        base64: 'abc123',
                        mimeType: 'image/png'
                    }
                ]
            }
        };
        const res = await provider.analyzeImage(req, executionContext);
        expect(res.output).toBeDefined();
        expect(Array.isArray(res.output)).toBe(true);
        // The mock returns an object with 'description', not 'text'
        expect(res.output[0]).toHaveProperty('description');
        expect(res.metadata?.status).toBe('completed');
    });

    it('should throw if chat called before init', async () => {
        const req: AIRequest<ClientChatRequest> = {
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [{ type: 'text', text: 'Hello Gemini' }]
                    }
                ]
            }
        };
        await expect(provider.chat(req, executionContext)).rejects.toThrow('No capability chat found');
    });

    it('should throw if moderation called before init', async () => {
        const req: AIRequest<ClientModerationRequest> = { input: { input: 'test moderation' } };
        await expect(provider.moderation(req, executionContext)).rejects.toThrow('No capability moderation found');
    });

    it('should throw if embed called before init', async () => {
        const req: AIRequest<ClientEmbeddingRequest> = { input: { input: 'embed this' } };
        await expect(provider.embed(req, executionContext)).rejects.toThrow('No capability embed found');
    });

    it('should throw if generateImage called before init', async () => {
        const req: AIRequest<{ prompt: string }> = { input: { prompt: 'a cat' } };
        await expect(provider.generateImage(req, executionContext)).rejects.toThrow('No capability imageGeneration found');
    });

    it('should throw if analyzeImage called before init', async () => {
        const req: AIRequest<ClientImageAnalysisRequest> = {
            input: {
                images: [
                    {
                        id: 'img1',
                        sourceType: 'base64',
                        base64: 'abc123',
                        mimeType: 'image/png'
                    }
                ]
            }
        };
        await expect(provider.analyzeImage(req, executionContext)).rejects.toThrow('No capability imageAnalyze found');
    });

    it('should throw CapabilityUnsupportedError if chatDelegate is missing for chat', async () => {
        provider.init(config);
        // @ts-ignore
        provider.chatDelegate = null;
        const req: AIRequest<ClientChatRequest> = {
            input: {
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'Hello Gemini' }] }
                ]
            }
        };
        await expect(provider.chat(req, executionContext)).rejects.toThrow('No capability chat found for gemini provider');
    });

    it('should throw CapabilityUnsupportedError if chatDelegate is missing for chatStream', async () => {
        provider.init(config);
        // @ts-ignore
        provider.chatDelegate = null;
        const req: AIRequest<ClientChatRequest> = {
            input: {
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'Hello Gemini' }] }
                ]
            }
        };
        expect(() => provider.chatStream(req, executionContext)).toThrow('No capability chatStream found for gemini provider');
    });

    it('should throw CapabilityUnsupportedError if moderationDelegate is missing for moderation', async () => {
        provider.init(config);
        // @ts-ignore
        provider.moderationDelegate = null;
        const req: AIRequest<ClientModerationRequest> = { input: { input: 'test moderation' } };
        await expect(provider.moderation(req, executionContext)).rejects.toThrow('No capability moderation found for gemini provider');
    });

    it('should throw CapabilityUnsupportedError if embedDelegate is missing for embed', async () => {
        provider.init(config);
        // @ts-ignore
        provider.embedDelegate = null;
        const req: AIRequest<ClientEmbeddingRequest> = { input: { input: 'embed this' } };
        await expect(provider.embed(req, executionContext)).rejects.toThrow('No capability embed found for gemini provider');
    });

    it('should throw CapabilityUnsupportedError if imageGenerationDelegate is missing for generateImage', async () => {
        provider.init(config);
        // @ts-ignore
        provider.imageGenerationDelegate = null;
        const req: AIRequest<{ prompt: string }> = { input: { prompt: 'a cat' } };
        await expect(provider.generateImage(req, executionContext)).rejects.toThrow('No capability imageGeneration found for gemini provider');
    });

    it('should throw CapabilityUnsupportedError if imageAnalysisDelegate is missing for analyzeImage', async () => {
        provider.init(config);
        // @ts-ignore
        provider.imageAnalysisDelegate = null;
        const req: AIRequest<ClientImageAnalysisRequest> = {
            input: {
                images: [
                    {
                        id: 'img1',
                        sourceType: 'base64',
                        base64: 'abc123',
                        mimeType: 'image/png'
                    }
                ]
            }
        };
        await expect(provider.analyzeImage(req, executionContext)).rejects.toThrow('No capability imageAnalyze found for gemini provider');
    });
});
