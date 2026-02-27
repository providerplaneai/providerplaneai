import { describe, it, expect } from 'vitest';
import { AllProvidersFailedError } from '#root/core/types/exceptions/AllProvidersFailedError.js';
import { AIProvider } from '#root/core/provider/Provider.js';

describe('AllProvidersFailedError', () => {
    const capability = 'chat';
    const providerChain = [
        { providerType: AIProvider.OpenAI, connectionName: 'default' },
        { providerType: AIProvider.Anthropic, connectionName: 'prod' }
    ];
    const attempts = [
        {
            capability,
            providerType: AIProvider.OpenAI,
            connectionName: 'default',
            attemptIndex: 0,
            startTime: 123,
            durationMs: 100,
            error: 'timeout'
        },
        {
            capability,
            providerType: AIProvider.Anthropic,
            connectionName: 'prod',
            attemptIndex: 1,
            startTime: 456,
            durationMs: 200,
            error: 'quota'
        }
    ];


    it('constructs when Error.captureStackTrace is not available', () => {
        // Temporarily remove Error.captureStackTrace
        const originalCapture = Error.captureStackTrace;
        // @ts-ignore
        delete Error.captureStackTrace;
        const err = new AllProvidersFailedError(capability, providerChain, attempts);
        expect(err).toBeInstanceOf(AllProvidersFailedError);
        expect(typeof err.stack).toBe('string');
        // Restore original
        if (originalCapture) Error.captureStackTrace = originalCapture;
    });

    it('covers else branch if Error.captureStackTrace is missing', () => {
        const originalCapture = Error.captureStackTrace;
        // @ts-ignore
        delete Error.captureStackTrace;
        const err = new AllProvidersFailedError('embed', [], []);
        expect(err.stack).toBeDefined();
        // Restore
        if (originalCapture) Error.captureStackTrace = originalCapture;
    });

    it('sets stack trace with Error.captureStackTrace', () => {
        const originalCapture = Error.captureStackTrace;
        let called = false;
        // @ts-ignore
        Error.captureStackTrace = function (err, ctor) {
            called = true;
            expect(err).toBeInstanceOf(AllProvidersFailedError);
            expect(ctor).toBe(AllProvidersFailedError);
        };
        const err = new AllProvidersFailedError(capability, providerChain, attempts);
        expect(called).toBe(true);
        // Restore original
        Error.captureStackTrace = originalCapture;
    });

    it('constructs and sets properties', () => {
        const err = new AllProvidersFailedError(capability, providerChain, attempts);
        expect(err.capability).toBe(capability);
        expect(err.providerChain).toEqual(providerChain);
        expect(err.attempts).toEqual(attempts);
        expect(err.name).toBe('AllProvidersFailedError');
        expect(err.message).toContain('All providers failed');
    });

    it('toJSON returns structured object', () => {
        const err = new AllProvidersFailedError(capability, providerChain, attempts);
        const json = err.toJSON();
        expect(json.error.type).toBe('AllProvidersFailedError');
        expect(json.error.capability).toBe(capability);
        expect(Array.isArray(json.error.attempts)).toBe(true);
        expect(json.error.attempts.length).toBe(2);
    });

    it('toSummary returns concise summary', () => {
        const err = new AllProvidersFailedError(capability, providerChain, attempts);
        const summary = err.toSummary();
        expect(summary.name).toBe('AllProvidersFailedError');
        expect(summary.capability).toBe(capability);
        expect(Array.isArray(summary.attempts)).toBe(true);
    });

    it('handles empty providerChain and attempts', () => {
        const err = new AllProvidersFailedError('embed', [], []);
        expect(err.providerChain).toEqual([]);
        expect(err.attempts).toEqual([]);
        expect(err.toJSON().error.attempts.length).toBe(0);
    });

        it('handles malformed attempt objects in toJSON and toSummary', () => {
            // Deliberately omit some properties
            const malformedAttempts = [
                {
                    providerType: 'openai',
                    // connectionName missing
                    attemptIndex: 0,
                    // durationMs missing
                    error: undefined
                },
                null,
                undefined
            ];
            // @ts-expect-error: testing malformed input
            const err = new AllProvidersFailedError('malformed', [{ providerType: 'openai' }], malformedAttempts);
            const json = err.toJSON();
            expect(Array.isArray(json.error.attempts)).toBe(true);
            expect(json.error.attempts.length).toBe(3);
            // Should not throw, and should include undefined/null attempts as empty objects
            expect(json.error.attempts[1]).toEqual({});
            expect(json.error.attempts[2]).toEqual({});
            const summary = err.toSummary();
            expect(Array.isArray(summary.attempts)).toBe(true);
            expect(summary.attempts.length).toBe(3);
            expect(summary.attempts[1]).toEqual({});
            expect(summary.attempts[2]).toEqual({});
        });
});
