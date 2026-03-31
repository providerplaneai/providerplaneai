/**
 * @module core/provider/capabilities/OCRCapability.ts
 * @description Provider implementations and capability adapters.
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
 * @description Capability contract for OCRCapability.
 */
export interface OCRCapability<TInput = ClientOCRRequest, TOutput = NormalizedOCRDocument[]> extends ProviderCapability {
    /**
     * Extracts OCR/document text from the supplied request.
     *
     * @param request Unified OCR request envelope.
     * @param ctx Execution context.
     * @param signal Optional abort signal.
     * @returns AIResponse containing normalized OCR document artifacts.
     */
    ocr(
        request: AIRequest<TInput>,
        ctx: MultiModalExecutionContext,
        signal?: AbortSignal
    ): Promise<AIResponse<TOutput>>;
}
