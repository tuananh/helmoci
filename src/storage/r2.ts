import type { TagPointer } from "../oci/types";
import { registryHeaders } from "../oci/types";

export function blobKey(digest: string): string {
	return `blobs/${digest}`;
}

export function tagKey(fullName: string, tag: string): string {
	return `tags/${fullName}/${tag}`;
}

export async function getBlob(
	bucket: R2Bucket,
	digest: string,
): Promise<R2ObjectBody | null> {
	return bucket.get(blobKey(digest));
}

export async function putBlob(
	bucket: R2Bucket,
	digest: string,
	data: ArrayBuffer | Uint8Array,
	contentType: string,
): Promise<void> {
	const key = blobKey(digest);
	const existing = await bucket.head(key);
	if (existing) {
		return;
	}

	await bucket.put(key, data, {
		httpMetadata: { contentType },
		customMetadata: {
			"docker-content-digest": digest,
		},
	});
}

/**
 * Put a blob by streaming a known-length ReadableStream into R2.
 * Used when Content-Length is available so the Worker does not need a second buffer copy.
 */
export async function putBlobStream(
	bucket: R2Bucket,
	digest: string,
	stream: ReadableStream,
	size: number,
	contentType: string,
): Promise<void> {
	const key = blobKey(digest);
	const existing = await bucket.head(key);
	if (existing) {
		await stream.cancel().catch(() => {});
		return;
	}

	const { readable, writable } = new FixedLengthStream(size);
	const pipe = stream.pipeTo(writable);
	const put = bucket.put(key, readable, {
		httpMetadata: { contentType },
		customMetadata: {
			"docker-content-digest": digest,
		},
	});
	await Promise.all([pipe, put]);
}

export async function readBodyWithLimit(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<ArrayBuffer> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`body exceeds size limit (${total} > ${maxBytes})`);
		}
		chunks.push(value);
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out.buffer;
}

export async function getTagPointer(
	bucket: R2Bucket,
	fullName: string,
	tag: string,
): Promise<TagPointer | null> {
	const obj = await bucket.get(tagKey(fullName, tag));
	if (!obj) return null;
	try {
		return (await obj.json()) as TagPointer;
	} catch {
		return null;
	}
}

export async function putTagPointer(
	bucket: R2Bucket,
	fullName: string,
	tag: string,
	pointer: TagPointer,
): Promise<void> {
	await bucket.put(tagKey(fullName, tag), JSON.stringify(pointer), {
		httpMetadata: { contentType: "application/json" },
	});
}

export function streamBlobResponse(
	obj: R2ObjectBody,
	digest: string,
	headOnly: boolean,
): Response {
	const contentType =
		obj.httpMetadata?.contentType ?? "application/octet-stream";
	const headers = registryHeaders({
		"Content-Type": contentType,
		"Content-Length": String(obj.size),
		"Docker-Content-Digest":
			obj.customMetadata?.["docker-content-digest"] ?? digest,
		ETag: obj.httpEtag,
	});

	if (headOnly) {
		return new Response(null, { status: 200, headers });
	}

	return new Response(obj.body, { status: 200, headers });
}
