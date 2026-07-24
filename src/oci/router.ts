export type OciRoute =
	| { type: "api" }
	| { type: "manifest"; name: string; reference: string }
	| { type: "blob"; name: string; digest: string }
	| { type: "tags"; name: string }
	| { type: "not_found" };

/**
 * Parse OCI Distribution V2 paths under /v2/.
 *
 * Examples:
 *   /v2/                                          → api
 *   /v2/helm.argo.com/argo/argo-cd/manifests/1.0  → manifest
 *   /v2/helm.argo.com/argo/argo-cd/blobs/sha256:… → blob
 *   /v2/helm.argo.com/argo/argo-cd/tags/list      → tags
 */
export function parseOciPath(pathname: string): OciRoute {
	let path = pathname;
	try {
		path = decodeURIComponent(pathname);
	} catch {
		return { type: "not_found" };
	}

	if (!path.startsWith("/v2")) {
		return { type: "not_found" };
	}

	const rest = path.slice("/v2".length).replace(/^\/+/, "");
	if (rest === "") {
		return { type: "api" };
	}

	const manifestsMarker = "/manifests/";
	const blobsMarker = "/blobs/";
	const tagsMarker = "/tags/list";

	const manifestsIdx = rest.lastIndexOf(manifestsMarker);
	if (manifestsIdx !== -1) {
		const name = rest.slice(0, manifestsIdx);
		const reference = rest.slice(manifestsIdx + manifestsMarker.length);
		if (!name || !reference || reference.includes("/")) {
			return { type: "not_found" };
		}
		return { type: "manifest", name, reference };
	}

	const blobsIdx = rest.lastIndexOf(blobsMarker);
	if (blobsIdx !== -1) {
		const name = rest.slice(0, blobsIdx);
		const digest = rest.slice(blobsIdx + blobsMarker.length);
		if (!name || !digest || digest.includes("/")) {
			return { type: "not_found" };
		}
		return { type: "blob", name, digest };
	}

	if (rest.endsWith(tagsMarker)) {
		const name = rest.slice(0, -tagsMarker.length).replace(/\/+$/, "");
		if (!name) {
			return { type: "not_found" };
		}
		return { type: "tags", name };
	}

	return { type: "not_found" };
}

export function isDigest(reference: string): boolean {
	return /^sha256:[a-f0-9]{64}$/.test(reference);
}
