import {
	MEDIA_TYPE_HELM_CHART,
	MEDIA_TYPE_HELM_CONFIG,
	MEDIA_TYPE_MANIFEST,
	type OciManifest,
	type TagPointer,
} from "./types";
import { chartConfigFromTgz } from "../helm/chart";
import { rewriteChartDependencies } from "../helm/rewrite";

export interface BuiltChart {
	manifest: OciManifest;
	manifestBytes: Uint8Array;
	manifestDigest: string;
	configBytes: Uint8Array;
	configDigest: string;
	layerBytes: ArrayBuffer;
	layerDigest: string;
	pointer: TagPointer;
}

export async function buildHelmOciChart(
	chartTgz: ArrayBuffer,
	proxyHost: string,
): Promise<BuiltChart> {
	const rewritten = await rewriteChartDependencies(chartTgz, proxyHost);
	if (rewritten.modified) {
		for (const r of rewritten.rewrites) {
			console.log(
				"rewrote dependency",
				r.name,
				r.from,
				"→",
				r.to,
			);
		}
	}
	const layerBytes = rewritten.tgz;

	const configBytes = await chartConfigFromTgz(layerBytes);
	const configDigest = await sha256Digest(configBytes);
	const layerDigest = await sha256Digest(new Uint8Array(layerBytes));

	const manifest: OciManifest = {
		schemaVersion: 2,
		mediaType: MEDIA_TYPE_MANIFEST,
		config: {
			mediaType: MEDIA_TYPE_HELM_CONFIG,
			digest: configDigest,
			size: configBytes.byteLength,
		},
		layers: [
			{
				mediaType: MEDIA_TYPE_HELM_CHART,
				digest: layerDigest,
				size: layerBytes.byteLength,
			},
		],
	};

	const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
	const manifestDigest = await sha256Digest(manifestBytes);

	return {
		manifest,
		manifestBytes,
		manifestDigest,
		configBytes,
		configDigest,
		layerBytes,
		layerDigest,
		pointer: {
			digest: manifestDigest,
			mediaType: MEDIA_TYPE_MANIFEST,
			size: manifestBytes.byteLength,
		},
	};
}

export async function sha256Digest(data: BufferSource): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", data);
	return `sha256:${toHex(new Uint8Array(hash))}`;
}

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += bytes[i].toString(16).padStart(2, "0");
	}
	return out;
}
