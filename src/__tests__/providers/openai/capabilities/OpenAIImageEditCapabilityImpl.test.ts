import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIImageEditCapabilityImpl } from '#root/providers/openai/capabilities/OpenAIImageEditCapabilityImpl.js';
import { AIProvider } from '#root/index.js';

const mockProvider = {
    ensureInitialized: vi.fn(),
    getMergedOptions: vi.fn((cap, opts) => ({ model: 'mock-model', modelParams: {}, providerParams: {}, generalParams: {} }))
};
const mockClient = {
    responses: {
        create: vi.fn(),
        stream: vi.fn()
    }
};
const mockExecutionContext = {
    getLastImage: vi.fn()
};

describe('OpenAIImageEditCapabilityImpl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // Streaming API tests
    it('throws if no prompt is provided (editImageStream)', async () => {
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const gen = edit.editImageStream({ input: {} } as any, mockExecutionContext as any);
        await expect(gen.next()).rejects.toThrow('Edit prompt is required for image editing');
    });

    it('yields images for valid stream events', async () => {
        // Proper async iterable mock
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: [
                                    { type: 'image_generation_call', status: 'generating', result: 'imgS', id: 'idS' }
                                ]
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const gen = edit.editImageStream(req as any, mockExecutionContext as any);
        const chunk = await gen.next();
        expect(chunk.value.output[0].base64).toBe('imgS');
        expect(chunk.value.id).toBe('idS');
        expect(chunk.value.done).toBe(true);
        expect(chunk.value.metadata?.provider).toBe(AIProvider.OpenAI);
    });

    it('yields error chunk for thrown error in stream', async () => {
        // Proper async iterable mock that throws
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                throw new Error('stream error');
            }
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const gen = edit.editImageStream(req as any, mockExecutionContext as any);
        const chunk = await gen.next();
        expect(chunk.value.error).toBe('stream error');
        expect(chunk.value.done).toBe(true);
    });

    it('yields error chunk for non-Error thrown in stream', async () => {
        // Async iterable mock that throws a string
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                throw 'string error';
            }
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const gen = edit.editImageStream(req as any, mockExecutionContext as any);
        const chunk = await gen.next();
        expect(chunk.value.error).toBe('string error');
        expect(chunk.value.done).toBe(true);
    });

    it('yields no images if stream event has no image_generation_call', async () => {
        // Proper async iterable mock with no image_generation_call
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: [
                                    { type: 'other_type', status: 'generating', result: 'notimg', id: 'idOther' }
                                ]
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const gen = edit.editImageStream(req as any, mockExecutionContext as any);
        const chunk = await gen.next();
        expect(chunk.value).toBeUndefined();
    });

    it('yields all images for multiple image_generation_call items in stream event', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: [
                                    { type: 'image_generation_call', status: 'generating', result: 'imgA', id: 'idA' },
                                    { type: 'image_generation_call', status: 'generating', result: 'imgB', id: 'idB' }
                                ]
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const gen = edit.editImageStream(req as any, mockExecutionContext as any);
        const chunkA = await gen.next();
        expect(chunkA.value.output[0].base64).toBe('imgA');
        expect(chunkA.value.id).toBe('idA');
        const chunkB = await gen.next();
        expect(chunkB.value.output[0].base64).toBe('imgB');
        expect(chunkB.value.id).toBe('idB');
        const done = await gen.next();
        expect(done.done).toBe(true);
    });

    it('yields images from multiple streams if count > 1', async () => {
        // Two streams, each yields one image
        const fakeStreamA = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: [
                                    { type: 'image_generation_call', status: 'generating', result: 'imgA', id: 'idA' }
                                ]
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        const fakeStreamB = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: [
                                    { type: 'image_generation_call', status: 'generating', result: 'imgB', id: 'idB' }
                                ]
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockReturnValueOnce(fakeStreamA).mockReturnValueOnce(fakeStreamB);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 2 }
            }
        };
        const gen = edit.editImageStream(req as any, mockExecutionContext as any);
        const chunkA = await gen.next();
        expect(chunkA.value.output[0].base64).toBe('imgA');
        expect(chunkA.value.id).toBe('idA');
        const chunkB = await gen.next();
        expect(chunkB.value.output[0].base64).toBe('imgB');
        expect(chunkB.value.id).toBe('idB');
        const done = await gen.next();
        expect(done.done).toBe(true);
    });

    it('sets multimodalArtifacts and metadata in streaming response', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: [
                                    { type: 'image_generation_call', status: 'generating', result: 'imgMeta', id: 'idMeta' }
                                ]
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }, { role: 'mask', base64: 'maskdata', mimeType: 'image/png', id: 'mask1' }],
                params: { count: 1 }
            },
            context: { requestId: 'reqMeta' }
        };
        const gen = edit.editImageStream(req as any, mockExecutionContext as any);
        const chunk = await gen.next();
        expect(chunk.value.multimodalArtifacts.masks[0].base64).toBe('maskdata');
        expect(chunk.value.metadata.requestId).toBe('reqMeta');
    });

    it('handles undefined outputItems in streaming', async () => {
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                if (!this._yielded) {
                    this._yielded = true;
                    return {
                        value: {
                            type: 'response.completed', response: {
                                output: undefined
                            }
                        }, done: false
                    };
                }
                return { done: true };
            },
            _yielded: false
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const gen = edit.editImageStream(req as any, mockExecutionContext as any);
        const chunk = await gen.next();
        expect(chunk.value).toBeUndefined();
    });

    it('handles undefined resp.output in non-streaming', async () => {
        mockClient.responses.create.mockResolvedValue({ output: undefined, id: 'idU', status: 'completed' });
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const res = await edit.editImage(req as any, mockExecutionContext as any);
        expect(res.output).toEqual([]);
    });

    it('prepareEditContent handles multiple masks and references', async () => {
        mockClient.responses.create.mockResolvedValue({ output: [{ type: 'image_generation_call', status: 'completed', result: 'imgMulti', id: 'idMulti' }], id: 'idMulti', status: 'completed' });
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [
                    { role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' },
                    { role: 'mask', base64: 'mask1', mimeType: 'image/png', id: 'mask1' },
                    { role: 'mask', base64: 'mask2', mimeType: 'image/png', id: 'mask2' },
                    { role: 'reference', base64: 'ref1', mimeType: 'image/png', id: 'ref1' },
                    { role: 'reference', url: 'refurl', mimeType: 'image/png', id: 'ref2' }
                ],
                params: { count: 1 }
            }
        };
        await edit.editImage(req as any, mockExecutionContext as any);
        const call = mockClient.responses.create.mock.calls[0][0];
        const content = call.input[0].content;
        expect(content.filter((c: any) => c.type === 'input_image').length).toBeGreaterThan(1);
    });

    it('returns empty output if no image_generation_call items', async () => {
        mockClient.responses.create.mockResolvedValue({ output: [{ type: 'other_type', status: 'completed', result: 'notimg', id: 'idOther' }], id: 'idOther', status: 'completed' });
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const res = await edit.editImage(req as any, mockExecutionContext as any);
        expect(res.output).toEqual([]);
    });

    it('throws if no prompt is provided (editImage)', async () => {
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        await expect(edit.editImage({ input: {} } as any, mockExecutionContext as any)).rejects.toThrow('Edit prompt is required for image editing');
    });

    it('throws if no subject image is provided', async () => {
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = { input: { prompt: 'edit', referenceImages: [] } };
        mockExecutionContext.getLastImage.mockReturnValue(undefined);
        await expect(edit.editImage(req as any, mockExecutionContext as any)).rejects.toThrow('Image edit requires a subject image');
    });

    it('returns normalized image for valid edit', async () => {
        const fakeResponse = {
            output: [{ type: 'image_generation_call', status: 'completed', result: 'base64img', id: 'img1' }],
            id: 'id1',
            status: 'completed'
        };
        mockClient.responses.create.mockResolvedValue(fakeResponse);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const res = await edit.editImage(req as any, mockExecutionContext as any);
        expect(res.output[0].base64).toBe('base64img');
        expect(res.output[0].id).toBe('img1');
        expect(res.id).toBe('id1');
        expect(res.metadata?.provider).toBe(AIProvider.OpenAI);
    });

    it('returns multiple images if count > 1', async () => {
        const fakeResponses = [
            { output: [{ type: 'image_generation_call', status: 'completed', result: 'imgA', id: 'idA' }], id: 'idA', status: 'completed' },
            { output: [{ type: 'image_generation_call', status: 'completed', result: 'imgB', id: 'idB' }], id: 'idB', status: 'completed' }
        ];
        mockClient.responses.create.mockResolvedValueOnce(fakeResponses[0]).mockResolvedValueOnce(fakeResponses[1]);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 2 }
            }
        };
        const res = await edit.editImage(req as any, mockExecutionContext as any);
        expect(res.output.length).toBe(2);
        expect(res.output[0].base64).toBe('imgA');
        expect(res.output[1].base64).toBe('imgB');
    });

    it('merges context metadata into response', async () => {
        const fakeResponse = {
            output: [{ type: 'image_generation_call', status: 'completed', result: 'imgC', id: 'idC' }],
            id: 'idC',
            status: 'completed'
        };
        mockClient.responses.create.mockResolvedValue(fakeResponse);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            },
            context: { requestId: 'reqC', metadata: { foo: 'bar' } }
        };
        const res = await edit.editImage(req as any, mockExecutionContext as any);
        expect(res.metadata?.requestId).toBe('reqC');
        expect(res.metadata?.foo).toBe('bar');
    });

    it('passes correct model, params, and options to responses.create', async () => {
        mockClient.responses.create.mockResolvedValue({ output: [], id: 'idX', status: 'completed' });
        mockProvider.getMergedOptions.mockReturnValueOnce({
            model: 'custom-model',
            modelParams: { temperature: 0.5 },
            providerParams: { foo: 'bar' },
            generalParams: {}
        });
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { size: 'large', quality: 'hd', style: 'art', background: 'white', count: 1 }
            }
        };
        await edit.editImage(req as any, mockExecutionContext as any);
        expect(mockClient.responses.create).toHaveBeenCalledWith(expect.objectContaining({
            model: 'custom-model',
            input: [expect.objectContaining({ role: 'user', content: expect.any(Array) })],
            tools: [expect.objectContaining({ type: 'image_generation', size: 'large', quality: 'hd', style: 'art', background: 'white' })],
            temperature: 0.5,
            foo: 'bar'
        }));
    });

    it('yields error chunk if error thrown during stream iteration (covers catch branch)', async () => {
        // Simulate error thrown during for-await-of
        const fakeStream = {
            [Symbol.asyncIterator]: function () { return this; },
            next: async function () {
                throw new Error('iteration error');
            }
        };
        mockClient.responses.stream.mockReturnValue(fakeStream);
        const edit = new OpenAIImageEditCapabilityImpl(mockProvider as any, mockClient as any);
        const req = {
            input: {
                prompt: 'edit',
                referenceImages: [{ role: 'subject', base64: 'imgdata', mimeType: 'image/png', id: 'subj1' }],
                params: { count: 1 }
            }
        };
        const gen = edit.editImageStream(req as any, mockExecutionContext as any);
        const chunk = await gen.next();
        expect(chunk.value.error).toBe('iteration error');
        expect(chunk.value.done).toBe(true);
    });
});
