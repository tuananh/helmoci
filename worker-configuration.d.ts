interface Env {
	BUCKET: R2Bucket;
}

declare module "*.html" {
	const content: string;
	export default content;
}

/** Cloudflare Workers stream with a known length (required for R2 put streams). */
declare class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
	constructor(expectedLength: number);
}
