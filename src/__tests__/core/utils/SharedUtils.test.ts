import { ensureDataUri, toDataUrl, resolveImageToBytes } from '#root/core/utils/SharedUtils.js';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';


describe('SharedUtils', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.resetAllMocks();
        // ensure global fetch is cleaned up after tests that stub it
        try { delete (global as any).fetch; } catch {}
    });

    describe('ensureDataUri', () => {
        it('leaves data URIs intact', () => {
            const data = 'data:image/png;base64,AAA';
            expect(ensureDataUri(data)).toBe(data);
        });

        it('prepends default MIME type prefix to plain base64', () => {
            const plain = 'AAA';
            expect(ensureDataUri(plain)).toBe('data:application/octet-stream;base64,AAA');
        });

        it('prepends custom MIME type prefix to plain base64', () => {
            const plain = 'AAA';
            expect(ensureDataUri(plain, 'image/png')).toBe('data:image/png;base64,AAA');
            expect(ensureDataUri(plain, 'image/jpeg')).toBe('data:image/jpeg;base64,AAA');
        });

        it('preserves existing data URI regardless of custom MIME type argument', () => {
            const data = 'data:image/jpeg;base64,BBB';
            expect(ensureDataUri(data, 'image/png')).toBe(data);
        });

        it('handles empty string', () => {
            expect(ensureDataUri('')).toBe('data:application/octet-stream;base64,');
            expect(ensureDataUri('', 'image/gif')).toBe('data:image/gif;base64,');
        });
    });

    describe('toDataUrl', () => {
        it('throws when base64 is missing', () => {
            expect(() => toDataUrl({} as any)).toThrow("Requires base64");
        });

        it('returns data url when base64 is present', () => {
            const url = toDataUrl({ base64: 'BBB', mimeType: 'image/jpeg' } as any);
            expect(url).toBe('data:image/jpeg;base64,BBB');
        });

        it('uses default mimeType (image/png) when not provided', () => {
            const url = toDataUrl({ base64: 'CCC' } as any);
            expect(url).toBe('data:image/png;base64,CCC');
        });

        it('supports various MIME types', () => {
            expect(toDataUrl({ base64: 'DDD', mimeType: 'image/webp' } as any))
                .toBe('data:image/webp;base64,DDD');
            expect(toDataUrl({ base64: 'EEE', mimeType: 'image/gif' } as any))
                .toBe('data:image/gif;base64,EEE');
        });

        it('throws when base64 property is null', () => {
            expect(() => toDataUrl({ base64: null } as any)).toThrow("Requires base64");
        });
    });

    describe('resolveImageToBytes', () => {
        it('handles data URLs with valid base64', async () => {
            const base64 = 'QUJD'; // 'ABC' in base64
            const dataUrl = `data:image/png;base64,${base64}`;
            const buf = await resolveImageToBytes(dataUrl);
            expect(Buffer.isBuffer(buf)).toBe(true);
            expect(buf.toString('base64')).toBe(base64);
        });

        it('handles data URLs with different MIME types', async () => {
            const base64 = 'QUJD';
            const dataUrl = `data:image/jpeg;base64,${base64}`;
            const buf = await resolveImageToBytes(dataUrl);
            expect(Buffer.isBuffer(buf)).toBe(true);
            expect(buf.toString('base64')).toBe(base64);
        });

        it('fetches remote image successfully', async () => {
            const fakeArray = Uint8Array.from([1,2,3]);

            // stub global fetch
            const mockFetch = vi.fn(async (url: string) => ({ ok: true, arrayBuffer: async () => fakeArray.buffer } as any));
            (global as any).fetch = mockFetch;

            const buf = await resolveImageToBytes('https://example.com/img.png');
            expect(Buffer.isBuffer(buf)).toBe(true);
            expect(buf.equals(Buffer.from(fakeArray))).toBe(true);
            expect(mockFetch).toHaveBeenCalledWith('https://example.com/img.png');
        });

        it('throws on invalid data URL format (missing comma separator)', async () => {
            await expect(resolveImageToBytes('data:image/pngbase64')).rejects.toThrow();
        });

        it('throws on invalid data URL format (no base64 data)', async () => {
            await expect(resolveImageToBytes('data:image/png;base64,')).rejects.toThrow('Invalid Data URL format');
        });

        it('throws when fetch returns non-ok status', async () => {
            const mockFetch = vi.fn(async (url: string) => ({ ok: false, statusText: 'Not Found' } as any));
            (global as any).fetch = mockFetch;

            await expect(resolveImageToBytes('https://example.com/missing.png'))
                .rejects.toThrow('Could not resolve reference image');
        });

        it('throws when fetch throws an error', async () => {
            const mockFetch = vi.fn(async (url: string) => { throw new Error('Network error'); });
            (global as any).fetch = mockFetch;

            await expect(resolveImageToBytes('https://example.com/img.png'))
                .rejects.toThrow('Could not resolve reference image');
        });

        it('handles data URLs with different valid base64 encoding', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            const dataUrl = `data:image/png;base64,${base64}`;
            const buf = await resolveImageToBytes(dataUrl);
            expect(Buffer.isBuffer(buf)).toBe(true);
            expect(buf.toString('base64')).toBe(base64);
        });
    });
});
