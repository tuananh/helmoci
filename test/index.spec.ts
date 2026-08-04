import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { parseOciPath, isDigest } from "../src/oci/router";
import { isPublicHostname, resolveChartRef } from "../src/config";
import {
	rewriteChartDependencies,
	rewriteDependencyURL,
} from "../src/helm/rewrite";
import { stringify as stringifyYaml } from "yaml";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("OCI router", () => {
	it("parses API root", () => {
		expect(parseOciPath("/v2/")).toEqual({ type: "api" });
		expect(parseOciPath("/v2")).toEqual({ type: "api" });
	});

	it("parses multi-segment manifest paths", () => {
		expect(
			parseOciPath(
				"/v2/argoproj.github.io/argo-helm/argo-cd/manifests/7.7.12",
			),
		).toEqual({
			type: "manifest",
			name: "argoproj.github.io/argo-helm/argo-cd",
			reference: "7.7.12",
		});
	});

	it("parses blob digests", () => {
		const digest =
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		expect(
			parseOciPath(
				`/v2/argoproj.github.io/argo-helm/argo-cd/blobs/${digest}`,
			),
		).toEqual({
			type: "blob",
			name: "argoproj.github.io/argo-helm/argo-cd",
			digest,
		});
		expect(isDigest(digest)).toBe(true);
		expect(isDigest("7.7.12")).toBe(false);
	});

	it("parses tags/list", () => {
		expect(
			parseOciPath("/v2/argoproj.github.io/argo-helm/argo-cd/tags/list"),
		).toEqual({
			type: "tags",
			name: "argoproj.github.io/argo-helm/argo-cd",
		});
	});
});

describe("config", () => {
	it("derives classic repo URL from OCI path", () => {
		expect(resolveChartRef("argoproj.github.io/argo-helm/argo-cd")).toEqual(
			{
				repoURL: "https://argoproj.github.io/argo-helm",
				host: "argoproj.github.io",
				repoPath: "argo-helm",
				chartName: "argo-cd",
				fullName: "argoproj.github.io/argo-helm/argo-cd",
			},
		);

		expect(resolveChartRef("charts.jetstack.io/cert-manager")).toEqual({
			repoURL: "https://charts.jetstack.io",
			host: "charts.jetstack.io",
			repoPath: "",
			chartName: "cert-manager",
			fullName: "charts.jetstack.io/cert-manager",
		});
	});

	it("rejects invalid hosts", () => {
		expect(isPublicHostname("localhost")).toBe(false);
		expect(isPublicHostname("127.0.0.1")).toBe(false);
		expect(isPublicHostname("chart")).toBe(false);
		expect(resolveChartRef("localhost/foo")).toBeNull();
		expect(resolveChartRef("argo-cd")).toBeNull();
	});
});

describe("dependency rewrite", () => {
	it("maps classic https repos to oci:// through the proxy", () => {
		expect(
			rewriteDependencyURL(
				"https://dandydeveloper.github.io/charts/",
				"helmoci.tuananh.net",
			),
		).toBe("oci://helmoci.tuananh.net/dandydeveloper.github.io/charts");

		expect(
			rewriteDependencyURL(
				"https://charts.jetstack.io",
				"helmoci.tuananh.net",
			),
		).toBe("oci://helmoci.tuananh.net/charts.jetstack.io");

		expect(
			rewriteDependencyURL(
				"https://charts.bitnami.com/bitnami",
				"127.0.0.1:8787",
			),
		).toBe("oci://127.0.0.1:8787/charts.bitnami.com/bitnami");
	});

	it("skips file, alias, and oci dependencies", () => {
		expect(rewriteDependencyURL("file://../local", "h")).toBeNull();
		expect(rewriteDependencyURL("@bitnami", "h")).toBeNull();
		expect(rewriteDependencyURL("alias:bitnami", "h")).toBeNull();
		expect(
			rewriteDependencyURL("oci://ghcr.io/example/charts", "h"),
		).toBeNull();
		expect(rewriteDependencyURL("", "h")).toBeNull();
	});

	it("rewrites Chart.yaml and Chart.lock inside a chart tgz", async () => {
		const tgz = await makeChartTgz("argo-cd", {
			apiVersion: "v2",
			name: "argo-cd",
			version: "1.0.0",
			dependencies: [
				{
					name: "redis-ha",
					version: "4.38.0",
					repository: "https://dandydeveloper.github.io/charts/",
					condition: "redis-ha.enabled",
				},
				{
					name: "local-dep",
					version: "1.0.0",
					repository: "file://../local",
				},
			],
		}, {
			dependencies: [
				{
					name: "redis-ha",
					repository: "https://dandydeveloper.github.io/charts/",
					version: "4.38.0",
				},
			],
			generated: "2024-01-01T00:00:00Z",
		});

		const result = await rewriteChartDependencies(tgz, "helmoci.tuananh.net");
		expect(result.modified).toBe(true);
		expect(result.rewrites).toEqual([
			{
				name: "redis-ha",
				from: "https://dandydeveloper.github.io/charts/",
				to: "oci://helmoci.tuananh.net/dandydeveloper.github.io/charts",
			},
		]);

		const files = await listTgzFiles(result.tgz);
		const chartYaml = files["argo-cd/Chart.yaml"];
		expect(chartYaml).toContain(
			"oci://helmoci.tuananh.net/dandydeveloper.github.io/charts",
		);
		expect(chartYaml).toContain("file://../local");
		expect(chartYaml).not.toContain("https://dandydeveloper.github.io/charts/");

		const chartLock = files["argo-cd/Chart.lock"];
		expect(chartLock).toContain(
			"oci://helmoci.tuananh.net/dandydeveloper.github.io/charts",
		);
	});
});

describe("worker", () => {
	it("answers /v2/ API version check", async () => {
		const request = new IncomingRequest("http://example.com/v2/", {
			method: "GET",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("Docker-Distribution-API-Version")).toBe(
			"registry/2.0",
		);
	});

	it("answers /v2/ via SELF", async () => {
		const response = await SELF.fetch("https://example.com/v2/");
		expect(response.status).toBe(200);
		expect(response.headers.get("Docker-Distribution-API-Version")).toBe(
			"registry/2.0",
		);
	});

	it("returns NAME_UNKNOWN for invalid hosts", async () => {
		const response = await SELF.fetch(
			"https://example.com/v2/localhost/chart/manifests/1.0.0",
		);
		expect(response.status).toBe(404);
		const body = (await response.json()) as {
			errors: { code: string; message: string }[];
		};
		expect(body.errors[0]?.code).toBe("NAME_UNKNOWN");
		expect(body.errors[0]?.message).toContain("Invalid OCI path");
		expect(body.errors[0]?.message).toContain("argoproj.github.io");
	});
});

async function makeChartTgz(
	chartName: string,
	chart: Record<string, unknown>,
	lock?: Record<string, unknown>,
): Promise<ArrayBuffer> {
	const files: { name: string; data: Uint8Array }[] = [
		{
			name: `${chartName}/Chart.yaml`,
			data: new TextEncoder().encode(stringifyYaml(chart)),
		},
		{
			name: `${chartName}/values.yaml`,
			data: new TextEncoder().encode("replicaCount: 1\n"),
		},
	];
	if (lock) {
		files.push({
			name: `${chartName}/Chart.lock`,
			data: new TextEncoder().encode(stringifyYaml(lock)),
		});
	}
	return gzip(createTar(files));
}

async function listTgzFiles(
	tgz: ArrayBuffer,
): Promise<Record<string, string>> {
	const gunzipped = await gunzip(tgz);
	const out: Record<string, string> = {};
	let offset = 0;
	while (offset + 512 <= gunzipped.byteLength) {
		const header = gunzipped.subarray(offset, offset + 512);
		offset += 512;
		if (header.every((b) => b === 0)) break;
		const nameBytes = header.subarray(0, 100);
		let end = nameBytes.indexOf(0);
		if (end < 0) end = nameBytes.length;
		const name = new TextDecoder().decode(nameBytes.subarray(0, end)).trim();
		const size = parseInt(
			new TextDecoder()
				.decode(header.subarray(124, 136))
				.replace(/\0/g, "")
				.trim(),
			8,
		);
		const typeFlag = header[156];
		const data = gunzipped.subarray(offset, offset + size);
		offset += Math.ceil(size / 512) * 512;
		if (typeFlag === 0 || typeFlag === 48) {
			out[name] = new TextDecoder().decode(data);
		}
	}
	return out;
}

async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
	const ds = new DecompressionStream("gzip");
	const stream = new Blob([data]).stream().pipeThrough(ds);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzip(data: Uint8Array): Promise<ArrayBuffer> {
	const cs = new CompressionStream("gzip");
	const stream = new Blob([data]).stream().pipeThrough(cs);
	return new Response(stream).arrayBuffer();
}

function createTar(files: { name: string; data: Uint8Array }[]): Uint8Array {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (const file of files) {
		const header = new Uint8Array(512);
		const nameBytes = new TextEncoder().encode(file.name);
		header.set(nameBytes.subarray(0, Math.min(nameBytes.length, 100)), 0);
		const mode = "0000644\0";
		header.set(new TextEncoder().encode(mode), 100);
		header.set(new TextEncoder().encode("0000000\0"), 108);
		header.set(new TextEncoder().encode("0000000\0"), 116);
		const size = file.data.byteLength.toString(8).padStart(11, "0") + "\0";
		header.set(new TextEncoder().encode(size), 124);
		header.set(new TextEncoder().encode("00000000000\0"), 136);
		for (let i = 148; i < 156; i++) header[i] = 0x20;
		header[156] = 48;
		header.set(new TextEncoder().encode("ustar\0"), 257);
		header.set(new TextEncoder().encode("00"), 263);
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += header[i];
		const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
		header.set(new TextEncoder().encode(checksum), 148);

		const padding = (512 - (file.data.byteLength % 512)) % 512;
		chunks.push(header, file.data);
		total += 512 + file.data.byteLength;
		if (padding) {
			chunks.push(new Uint8Array(padding));
			total += padding;
		}
	}
	chunks.push(new Uint8Array(1024));
	total += 1024;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

