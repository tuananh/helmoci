import { parse as parseYaml } from "yaml";
import { MAX_CHART_BYTES } from "../oci/types";
import { readBodyWithLimit } from "../storage/r2";

export async function downloadChart(chartURL: string): Promise<ArrayBuffer> {
	const response = await fetch(chartURL);
	if (!response.ok) {
		throw new Error(
			`failed to download chart (${response.status}) from ${chartURL}`,
		);
	}

	const lengthHeader = response.headers.get("Content-Length");
	if (lengthHeader !== null) {
		const length = Number(lengthHeader);
		if (Number.isFinite(length) && length > MAX_CHART_BYTES) {
			throw new Error(
				`chart exceeds size limit (${length} > ${MAX_CHART_BYTES})`,
			);
		}
	}

	if (!response.body) {
		throw new Error("empty chart response body");
	}

	return readBodyWithLimit(response.body, MAX_CHART_BYTES);
}

/**
 * Extract root Chart.yaml from a helm chart .tgz and return metadata as JSON bytes.
 */
export async function chartConfigFromTgz(
	tgz: ArrayBuffer,
): Promise<Uint8Array> {
	const yamlText = await extractRootChartYaml(tgz);
	const metadata = parseYaml(yamlText);
	if (metadata === null || typeof metadata !== "object") {
		throw new Error("Chart.yaml did not parse to an object");
	}
	const json = JSON.stringify(metadata);
	return new TextEncoder().encode(json);
}

async function extractRootChartYaml(tgz: ArrayBuffer): Promise<string> {
	const gunzipped = await gunzip(tgz);
	const files = parseTar(gunzipped);

	for (const file of files) {
		if (isRootChartYaml(file.name)) {
			return new TextDecoder().decode(file.data);
		}
	}

	throw new Error("Chart.yaml not found in chart archive");
}

function isRootChartYaml(name: string): boolean {
	const parts = name.split("/").filter(Boolean);
	if (parts.length === 1) {
		return parts[0] === "Chart.yaml";
	}
	// chartname/Chart.yaml — skip charts/<dep>/Chart.yaml
	return (
		parts.length === 2 &&
		parts[1] === "Chart.yaml" &&
		parts[0] !== "charts"
	);
}

async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
	const ds = new DecompressionStream("gzip");
	const stream = new Blob([data]).stream().pipeThrough(ds);
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

interface TarFile {
	name: string;
	data: Uint8Array;
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
			files.push({ name: fullName, data: fileData.slice() });
		}
	}

	return files;
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
