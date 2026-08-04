import homeHtml from "./home.html";
import { resolveChartRef } from "./config";
import {
	ChartNotFoundError,
	listChartVersions,
	resolveChartURL,
} from "./helm/index";
import { downloadChart } from "./helm/chart";
import { buildHelmOciChart } from "./oci/build";
import { isDigest, parseOciPath } from "./oci/router";
import {
	MEDIA_TYPE_HELM_CHART,
	MEDIA_TYPE_HELM_CONFIG,
	MEDIA_TYPE_MANIFEST,
	ociError,
	registryHeaders,
} from "./oci/types";
import {
	getBlob,
	getTagPointer,
	putBlob,
	putTagPointer,
	streamBlobResponse,
} from "./storage/r2";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/" || url.pathname === "") {
			return new Response(homeHtml, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}

		if (!url.pathname.startsWith("/v2")) {
			return new Response("Not Found", { status: 404 });
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			return ociError(405, "UNSUPPORTED", "only GET/HEAD are supported");
		}

		const route = parseOciPath(url.pathname);

		switch (route.type) {
			case "api":
				return new Response(null, {
					status: 200,
					headers: registryHeaders(),
				});

			case "blob":
				return handleBlob(env, route.digest, request.method === "HEAD");

			case "tags":
				return handleTagsList(route.name, ctx, url);

			case "manifest":
				return handleManifest(
					env,
					ctx,
					proxyHostFromRequest(request, url),
					route.name,
					route.reference,
					request.method === "HEAD",
				);

			default:
				return ociError(404, "NAME_UNKNOWN", "unknown registry path");
		}
	},
} satisfies ExportedHandler<Env>;

async function handleTagsList(
	name: string,
	ctx: ExecutionContext,
	url: URL,
): Promise<Response> {
	const ref = resolveChartRef(name);
	if (!ref) {
		return ociError(404, "NAME_UNKNOWN", invalidPathMessage(name));
	}

	try {
		let tags = await listChartVersions(ref.repoURL, ref.chartName, ctx);

		// OCI tag pagination: ?n=<limit>&last=<tag>
		const nParam = url.searchParams.get("n");
		const last = url.searchParams.get("last");
		if (last) {
			const idx = tags.indexOf(last);
			tags = idx >= 0 ? tags.slice(idx + 1) : tags;
		}
		let link: string | undefined;
		if (nParam !== null) {
			const n = Number(nParam);
			if (Number.isFinite(n) && n >= 0 && tags.length > n) {
				const nextLast = tags[n - 1];
				tags = tags.slice(0, n);
				if (nextLast) {
					const next = new URL(url);
					next.searchParams.set("n", String(n));
					next.searchParams.set("last", nextLast);
					link = `<${next.pathname}${next.search}>; rel="next"`;
				}
			}
		}

		const body = JSON.stringify({ name: ref.fullName, tags });
		const headers = registryHeaders({
			"Content-Type": "application/json",
			"Content-Length": String(new TextEncoder().encode(body).byteLength),
		});
		if (link) {
			headers.set("Link", link);
		}
		return new Response(body, { status: 200, headers });
	} catch (err) {
		if (err instanceof ChartNotFoundError) {
			return ociError(404, "NAME_UNKNOWN", err.message);
		}
		console.error("failed to list tags", err);
		return ociError(
			500,
			"DENIED",
			err instanceof Error ? err.message : "failed to list tags",
		);
	}
}

async function handleBlob(
	env: Env,
	digest: string,
	headOnly: boolean,
): Promise<Response> {
	if (!isDigest(digest)) {
		return ociError(404, "BLOB_UNKNOWN", `invalid digest: ${digest}`);
	}

	const obj = await getBlob(env.BUCKET, digest);
	if (!obj) {
		return ociError(404, "BLOB_UNKNOWN", `blob unknown: ${digest}`);
	}

	return streamBlobResponse(obj, digest, headOnly);
}

async function handleManifest(
	env: Env,
	ctx: ExecutionContext,
	proxyHost: string,
	name: string,
	reference: string,
	headOnly: boolean,
): Promise<Response> {
	// Digest-addressed manifest: serve from R2 cache only.
	if (isDigest(reference)) {
		const obj = await getBlob(env.BUCKET, reference);
		if (!obj) {
			return ociError(
				404,
				"MANIFEST_UNKNOWN",
				`manifest unknown: ${reference}`,
			);
		}
		return streamBlobResponse(obj, reference, headOnly);
	}

	const ref = resolveChartRef(name);
	if (!ref) {
		return ociError(404, "NAME_UNKNOWN", invalidPathMessage(name));
	}

	// Cache hit via tag pointer.
	const cached = await getTagPointer(
		env.BUCKET,
		proxyHost,
		ref.fullName,
		reference,
	);
	if (cached) {
		const obj = await getBlob(env.BUCKET, cached.digest);
		if (obj) {
			console.log("cache hit", ref.fullName, reference, cached.digest);
			return streamBlobResponse(obj, cached.digest, headOnly);
		}
	}

	try {
		const chartURL = await resolveChartURL(
			ref.repoURL,
			ref.chartName,
			reference,
			ctx,
		);
		console.log("cache miss — fetching", chartURL, "from", ref.repoURL);

		const chartTgz = await downloadChart(chartURL);
		const built = await buildHelmOciChart(chartTgz, proxyHost);

		await Promise.all([
			putBlob(
				env.BUCKET,
				built.configDigest,
				built.configBytes,
				MEDIA_TYPE_HELM_CONFIG,
			),
			putBlob(
				env.BUCKET,
				built.layerDigest,
				built.layerBytes,
				MEDIA_TYPE_HELM_CHART,
			),
			putBlob(
				env.BUCKET,
				built.manifestDigest,
				built.manifestBytes,
				MEDIA_TYPE_MANIFEST,
			),
			putTagPointer(
				env.BUCKET,
				proxyHost,
				ref.fullName,
				reference,
				built.pointer,
			),
		]);

		const headers = registryHeaders({
			"Content-Type": MEDIA_TYPE_MANIFEST,
			"Content-Length": String(built.manifestBytes.byteLength),
			"Docker-Content-Digest": built.manifestDigest,
		});

		if (headOnly) {
			return new Response(null, { status: 200, headers });
		}

		return new Response(built.manifestBytes, { status: 200, headers });
	} catch (err) {
		if (err instanceof ChartNotFoundError) {
			console.error("chart not found", err.message);
			return ociError(404, "MANIFEST_UNKNOWN", err.message);
		}
		console.error("failed to build chart", err);
		return ociError(
			500,
			"DENIED",
			err instanceof Error ? err.message : "failed to build chart",
		);
	}
}

function invalidPathMessage(name: string): string {
	return (
		`Invalid OCI path "${name}". ` +
		`Use a public host and chart name: ` +
		`oci://helmoci.tuananh.net/<host>/<repo-path>/<chart> ` +
		`(e.g. argoproj.github.io/argo-helm/argo-cd). ` +
		`Localhost and raw IP addresses are not allowed.`
	);
}

/** Host clients should use for rewritten oci:// dependency URLs. */
function proxyHostFromRequest(request: Request, url: URL): string {
	// Prefer Host header — wrangler custom_domain can rewrite request.url.
	const host = request.headers.get("Host")?.trim();
	if (host) return host;
	return url.host;
}
