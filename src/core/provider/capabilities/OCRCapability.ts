/**
 * @module core/provider/capabilities/OCRCapability.ts
 * @description Provider-agnostic OCR capability contracts.
 */
import {
    AIRequest,
    AIResponse,
    ClientOCRRequest,
    MultiModalExecutionContext,
    NormalizedOCRDocument,
    ProviderCapability
} from "#root/index.js";

/**
 * Provider-agnostic OCR capability.
 *
 * OCR is modeled separately from image analysis because its primary intent is
 * text/document extraction rather than general visual understanding.
 */
/**
 * @public
 * OCR capability contract.
 */
export interface OCRCapability<TInput = ClientOCRRequest, TOutput = NormalizedOCRDocument[]> extends ProviderCapability {
    /**
     * Extracts OCR/document text from the supplied request.
     *
     * @param {AIRequest<TInput>} request - Unified OCR request envelope.
     * @param {MultiModalExecutionContext} ctx - Execution context.
     * @param {AbortSignal | undefined} signal - Optional abort signal.
     * @returns {Promise<AIResponse<TOutput>>} AIResponse containing normalized OCR document artifacts.
     */
    ocr(request: AIRequest<TInput>, ctx: MultiModalExecutionContext, signal?: AbortSignal): Promise<AIResponse<TOutput>>;
}
