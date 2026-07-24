import { parse as parseYaml } from "yaml";
import { INDEX_CACHE_TTL_SECONDS } from "../oci/types";

interface ChartIndex {
	entries?: Record<string, ChartEntry[]>;
}

interface ChartEntry {
	name?: string;
	version?: string;
	urls?: string[];
}

export async function resolveChartURL(
	repoURL: string,
	chartName: string,
	version: string,
	ctx: ExecutionContext,
): Promise<string> {
	const entries = await listChartEntries(repoURL, chartName, ctx);
	const entry = entries.find((e) => e.version === version);
	if (!entry) {
		throw new ChartNotFoundError(
			`Version "${version}" was not found for chart "${chartName}" in ${repoURL}. ` +
				`List available versions: GET /v2/<host>/<repo-path>/${chartName}/tags/list`,
		);
	}

	const rawURL = entry.urls?.[0];
	if (!rawURL) {
		throw new ChartNotFoundError(
			`Chart "${chartName}" version "${version}" in ${repoURL} has no download URL in index.yaml.`,
		);
	}

	if (/^https?:\/\//i.test(rawURL)) {
		return rawURL;
	}

	return `${repoURL}/${rawURL.replace(/^\/+/, "")}`;
}

/** Versions from classic index.yaml (newest first, as published). */
export async function listChartVersions(
	repoURL: string,
	chartName: string,
	ctx: ExecutionContext,
): Promise<string[]> {
	const entries = await listChartEntries(repoURL, chartName, ctx);
	const versions: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!entry.version || seen.has(entry.version)) continue;
		seen.add(entry.version);
		versions.push(entry.version);
	}
	return versions;
}

async function listChartEntries(
	repoURL: string,
	chartName: string,
	ctx: ExecutionContext,
): Promise<ChartEntry[]> {
	const indexURL = `${repoURL}/index.yaml`;
	const indexText = await fetchIndexYaml(indexURL, ctx);

	let index: ChartIndex;
	try {
		index = parseYaml(indexText) as ChartIndex;
	} catch {
		throw new ChartNotFoundError(
			`Upstream ${repoURL} did not return a valid Helm index.yaml. ` +
				`Check that the path maps to a classic Helm repo ` +
				`(e.g. oci://…/argoproj.github.io/argo-helm/argo-cd → https://argoproj.github.io/argo-helm).`,
		);
	}

	if (!index || typeof index !== "object" || !index.entries) {
		throw new ChartNotFoundError(
			`No Helm chart index found at ${repoURL}. ` +
				`Expected ${indexURL} with an "entries" map. ` +
				`Path format: oci://<proxy>/<host>/<repo-path>/<chart>`,
		);
	}

	const entries = index.entries[chartName];
	if (!entries?.length) {
		const available = Object.keys(index.entries).slice(0, 8);
		const hint =
			available.length > 0
				? ` Charts in this repo include: ${available.join(", ")}${Object.keys(index.entries).length > 8 ? ", …" : ""}.`
				: "";
		throw new ChartNotFoundError(
			`Chart "${chartName}" was not found in ${repoURL}.${hint} ` +
				`The chart name is the last path segment.`,
		);
	}
	return entries;
}

async function fetchIndexYaml(
	indexURL: string,
	ctx: ExecutionContext,
): Promise<string> {
	const cache = caches.default;
	const cacheKey = new Request(indexURL, { method: "GET" });

	const cached = await cache.match(cacheKey);
	if (cached?.ok) {
		return cached.text();
	}

	let upstream: Response;
	try {
		upstream = await fetch(indexURL, {
			headers: { Accept: "application/yaml, text/yaml, text/plain, */*" },
		});
	} catch (err) {
		const why = err instanceof Error ? err.message : "network error";
		throw new ChartNotFoundError(
			`Could not reach upstream Helm repo at ${indexURL} (${why}). ` +
				`Check the host/path in your oci:// URL.`,
		);
	}

	if (!upstream.ok) {
		throw new ChartNotFoundError(
			`No Helm repository at ${indexURL.replace(/\/index\.yaml$/, "")} ` +
				`(index.yaml returned HTTP ${upstream.status}). ` +
				`Example: oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd ` +
				`→ https://argoproj.github.io/argo-helm`,
		);
	}

	const text = await upstream.text();
	const responseToCache = new Response(text, {
		status: 200,
		headers: {
			"Content-Type": "application/yaml",
			"Cache-Control": `public, max-age=${INDEX_CACHE_TTL_SECONDS}`,
		},
	});
	ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
	return text;
}

export class ChartNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChartNotFoundError";
	}
}
