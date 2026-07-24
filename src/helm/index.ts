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
			`version ${version} not found for chart ${chartName}`,
		);
	}

	const rawURL = entry.urls?.[0];
	if (!rawURL) {
		throw new ChartNotFoundError(
			`no URLs for chart ${chartName} version ${version}`,
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
	const index = parseYaml(indexText) as ChartIndex;

	const entries = index.entries?.[chartName];
	if (!entries?.length) {
		throw new ChartNotFoundError(
			`chart ${chartName} not found in ${repoURL}`,
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

	const upstream = await fetch(indexURL, {
		headers: { Accept: "application/yaml, text/yaml, text/plain, */*" },
	});
	if (!upstream.ok) {
		throw new ChartNotFoundError(
			`failed to download index.yaml (${upstream.status}) from ${indexURL}`,
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
