import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isPublicHostname } from "../config";

export interface RewriteResult {
	tgz: ArrayBuffer;
	modified: boolean;
	rewrites: { name: string; from: string; to: string }[];
}

/**
 * Rewrite classic Helm dependency repositories in Chart.yaml (and Chart.lock)
 * to OCI URLs through this proxy.
 *
 *   https://dandydeveloper.github.io/charts/
 *     → oci://<proxyHost>/dandydeveloper.github.io/charts
 *
 * Helm then pulls oci://<proxyHost>/dandydeveloper.github.io/charts/<name>.
 * Skips file://, @alias, alias:, empty, and existing oci:// refs.
 */
export async function rewriteChartDependencies(
	tgz: ArrayBuffer,
	proxyHost: string,
): Promise<RewriteResult> {
	if (!proxyHost) {
		return { tgz, modified: false, rewrites: [] };
	}

	const gunzipped = await gunzip(tgz);
	const files = parseTar(gunzipped);

	const chartYaml = files.find((f) => isRootChartFile(f.name, "Chart.yaml"));
	if (!chartYaml) {
		return { tgz, modified: false, rewrites: [] };
	}

	const chartText = new TextDecoder().decode(chartYaml.data);
	const metadata = parseYaml(chartText);
	if (metadata === null || typeof metadata !== "object") {
		return { tgz, modified: false, rewrites: [] };
	}

	const rewrites: RewriteResult["rewrites"] = [];
	const chartObj = metadata as Record<string, unknown>;
	const depsModified = rewriteDepsList(chartObj.dependencies, proxyHost, rewrites);

	if (!depsModified) {
		return { tgz, modified: false, rewrites: [] };
	}

	chartYaml.data = new TextEncoder().encode(stringifyYaml(chartObj));

	const chartLock = files.find((f) => isRootChartFile(f.name, "Chart.lock"));
	if (chartLock) {
		const lockText = new TextDecoder().decode(chartLock.data);
		const lock = parseYaml(lockText);
		if (lock !== null && typeof lock === "object") {
			const lockObj = lock as Record<string, unknown>;
			if (rewriteDepsList(lockObj.dependencies, proxyHost, [])) {
				chartLock.data = new TextEncoder().encode(stringifyYaml(lockObj));
			}
		}
	}

	const rebuilt = await gzip(createTar(files));
	return { tgz: rebuilt, modified: true, rewrites };
}

function rewriteDepsList(
	deps: unknown,
	proxyHost: string,
	rewrites: RewriteResult["rewrites"],
): boolean {
	if (!Array.isArray(deps) || deps.length === 0) {
		return false;
	}

	let modified = false;
	for (const dep of deps) {
		if (dep === null || typeof dep !== "object") continue;
		const d = dep as Record<string, unknown>;
		if (typeof d.repository !== "string") continue;

		const next = rewriteDependencyURL(d.repository, proxyHost);
		if (next === null || next === d.repository) continue;

		rewrites.push({
			name: typeof d.name === "string" ? d.name : "",
			from: d.repository,
			to: next,
		});
		d.repository = next;
		modified = true;
	}
	return modified;
}

/** Exported for unit tests. */
export function rewriteDependencyURL(
	repoURL: string,
	proxyHost: string,
): string | null {
	if (!shouldRewriteURL(repoURL)) {
		return null;
	}

	let parsed: URL;
	try {
		parsed = new URL(repoURL);
	} catch {
		return null;
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return null;
	}

	if (!isPublicHostname(parsed.hostname)) {
		return null;
	}

	const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
	return path
		? `oci://${proxyHost}/${parsed.hostname}/${path}`
		: `oci://${proxyHost}/${parsed.hostname}`;
}

function shouldRewriteURL(repoURL: string): boolean {
	if (!repoURL) return false;
	if (repoURL.startsWith("@") || repoURL.startsWith("alias:")) return false;
	if (repoURL.startsWith("file:") || repoURL.startsWith("oci://")) return false;
	return true;
}

function isRootChartFile(name: string, basename: string): boolean {
	const parts = name.split("/").filter(Boolean);
	if (parts.length === 1) {
		return parts[0] === basename;
	}
	return (
		parts.length === 2 &&
		parts[1] === basename &&
		parts[0] !== "charts"
	);
}

async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
	const ds = new DecompressionStream("gzip");
	const stream = new Blob([data]).stream().pipeThrough(ds);
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

async function gzip(data: Uint8Array): Promise<ArrayBuffer> {
	const cs = new CompressionStream("gzip");
	const stream = new Blob([data]).stream().pipeThrough(cs);
	return new Response(stream).arrayBuffer();
}

interface TarFile {
	name: string;
	data: Uint8Array;
	mode: number;
	mtime: number;
}

function parseTar(data: Uint8Array): TarFile[] {
	const files: TarFile[] = [];
	let offset = 0;

	while (offset + 512 <= data.byteLength) {
		const header = data.subarray(offset, offset + 512);
		offset += 512;

		if (isZeroBlock(header)) {
			break;
		}

		const name = readTarString(header, 0, 100);
		const size = parseInt(readTarString(header, 124, 12), 8);
		const mode = parseInt(readTarString(header, 100, 8), 8);
		const mtime = parseInt(readTarString(header, 136, 12), 8);
		const typeFlag = header[156];
		const prefix = readTarString(header, 345, 155);
		const fullName = prefix ? `${prefix}/${name}` : name;

		if (!Number.isFinite(size) || size < 0) {
			throw new Error(`invalid tar size for ${fullName}`);
		}

		const fileData = data.subarray(offset, offset + size);
		offset += Math.ceil(size / 512) * 512;

		// Regular file (type '0' or NUL)
		if (typeFlag === 0 || typeFlag === 48 /* '0' */) {
			files.push({
				name: fullName,
				data: fileData.slice(),
				mode: Number.isFinite(mode) ? mode : 0o644,
				mtime: Number.isFinite(mtime) ? mtime : 0,
			});
		}
	}

	return files;
}

function createTar(files: TarFile[]): Uint8Array {
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (const file of files) {
		const header = createTarHeader(file);
		const padding = (512 - (file.data.byteLength % 512)) % 512;
		chunks.push(header, file.data);
		total += header.byteLength + file.data.byteLength;
		if (padding > 0) {
			chunks.push(new Uint8Array(padding));
			total += padding;
		}
	}

	// Two zero blocks end the archive
	chunks.push(new Uint8Array(1024));
	total += 1024;

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function createTarHeader(file: TarFile): Uint8Array {
	const header = new Uint8Array(512);
	const { name, prefix } = splitTarName(file.name);

	writeTarString(header, 0, name, 100);
	writeTarString(header, 100, encodeOctal(file.mode, 7), 8);
	writeTarString(header, 108, encodeOctal(0, 7), 8);
	writeTarString(header, 116, encodeOctal(0, 7), 8);
	writeTarString(header, 124, encodeOctal(file.data.byteLength, 11), 12);
	writeTarString(header, 136, encodeOctal(file.mtime, 11), 12);
	// checksum field filled with spaces for calculation
	for (let i = 148; i < 156; i++) header[i] = 0x20;
	header[156] = 48; // '0' regular file
	writeTarString(header, 257, "ustar", 6);
	writeTarString(header, 263, "00", 2);
	if (prefix) {
		writeTarString(header, 345, prefix, 155);
	}

	let sum = 0;
	for (let i = 0; i < 512; i++) sum += header[i];
	writeTarString(header, 148, `${encodeOctal(sum, 6)}\0 `, 8);

	return header;
}

function splitTarName(fullName: string): { name: string; prefix: string } {
	if (fullName.length <= 100) {
		return { name: fullName, prefix: "" };
	}
	// ustar: prefix (155) + "/" + name (100)
	const max = 100;
	let split = fullName.length - max;
	const slash = fullName.lastIndexOf("/", split + max);
	if (slash > 0 && slash <= 155) {
		split = slash;
	}
	if (split > 155 || fullName.length - split - 1 > 100) {
		throw new Error(`tar path too long: ${fullName}`);
	}
	return {
		prefix: fullName.slice(0, split),
		name: fullName.slice(split + 1),
	};
}

function encodeOctal(value: number, digits: number): string {
	return value.toString(8).padStart(digits, "0");
}

function writeTarString(
	block: Uint8Array,
	start: number,
	value: string,
	length: number,
): void {
	const bytes = new TextEncoder().encode(value);
	const n = Math.min(bytes.byteLength, length);
	block.set(bytes.subarray(0, n), start);
}

function readTarString(block: Uint8Array, start: number, length: number): string {
	const slice = block.subarray(start, start + length);
	let end = slice.length;
	for (let i = 0; i < slice.length; i++) {
		if (slice[i] === 0) {
			end = i;
			break;
		}
	}
	return new TextDecoder().decode(slice.subarray(0, end)).trim();
}

function isZeroBlock(block: Uint8Array): boolean {
	for (let i = 0; i < block.byteLength; i++) {
		if (block[i] !== 0) return false;
	}
	return true;
}
