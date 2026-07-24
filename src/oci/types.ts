export const MEDIA_TYPE_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const MEDIA_TYPE_HELM_CONFIG = "application/vnd.cncf.helm.config.v1+json";
export const MEDIA_TYPE_HELM_CHART =
	"application/vnd.cncf.helm.chart.content.v1.tar+gzip";

export const MAX_CHART_BYTES = 50 * 1024 * 1024; // 50 MiB
export const INDEX_CACHE_TTL_SECONDS = 600;

export interface OciDescriptor {
	mediaType: string;
	digest: string;
	size: number;
}

export interface OciManifest {
	schemaVersion: 2;
	mediaType: typeof MEDIA_TYPE_MANIFEST;
	config: OciDescriptor;
	layers: OciDescriptor[];
}

export interface TagPointer {
	digest: string;
	mediaType: string;
	size: number;
}

export type OciErrorCode =
	| "MANIFEST_UNKNOWN"
	| "BLOB_UNKNOWN"
	| "NAME_UNKNOWN"
	| "DENIED"
	| "UNSUPPORTED";

export function ociError(
	status: number,
	code: OciErrorCode,
	message: string,
): Response {
	return new Response(
		JSON.stringify({
			errors: [{ code, message }],
		}),
		{
			status,
			headers: {
				"Content-Type": "application/json",
				"Docker-Distribution-API-Version": "registry/2.0",
				"Cache-Control": "no-store",
			},
		},
	);
}

export function registryHeaders(
	extra?: HeadersInit,
): Headers {
	const headers = new Headers(extra);
	headers.set("Docker-Distribution-API-Version", "registry/2.0");
	return headers;
}
