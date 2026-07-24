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
			errors: { code: string }[];
		};
		expect(body.errors[0]?.code).toBe("NAME_UNKNOWN");
	});
});
