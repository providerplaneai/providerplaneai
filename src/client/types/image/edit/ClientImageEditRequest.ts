import { ClientReferenceImage, ClientRequestBase } from "#root/index.js";

/**
 * Provider-agnostic image edit request.
 */
export interface ClientImageEditRequest extends ClientRequestBase {
    /** Text prompt describing how to edit the image */
    prompt: string;

    /**
     * Images involved in the edit operation.
     *
     * Typical patterns:
     * - reference: base image to edit
     * - mask: edit mask
     * - style: style transfer
     */
    referenceImages?: ClientReferenceImage[];

    /**
     * Additional provider-agnostic generation parameters
     */
    params?: {
        size?: string;
        background?: string;
        quality?: string;
        style?: string;
        count?: number;
        autoGenerateMask?: boolean;
    };
}
