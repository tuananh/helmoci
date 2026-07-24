export interface ChartRef {
	/** Upstream classic Helm repo URL, e.g. https://argoproj.github.io/argo-helm */
	repoURL: string;
	/** Host from the OCI path */
	host: string;
	/** Path segments between host and chart name (repo path) */
	repoPath: string;
	/** Last path segment used for index.yaml lookup */
	chartName: string;
	/** Full OCI repository name */
	fullName: string;
}

/**
 * Derive a classic Helm repo from the OCI repository name.
 *
 *   argoproj.github.io/argo-helm/argo-cd
 *     → https://argoproj.github.io/argo-helm  + chart argo-cd
 *
 *   charts.jetstack.io/cert-manager
 *     → https://charts.jetstack.io  + chart cert-manager
 *
 * Last segment is always the chart name; everything before is host[/repo-path].
 */
export function resolveChartRef(name: string): ChartRef | null {
	const segments = name.split("/").filter(Boolean);
	if (segments.length < 2) {
		return null;
	}

	const host = segments[0];
	if (!isPublicHostname(host)) {
		return null;
	}

	const chartName = segments[segments.length - 1];
	if (!isValidChartName(chartName)) {
		return null;
	}

	const repoPathSegments = segments.slice(1, -1);
	for (const part of repoPathSegments) {
		if (!isValidPathSegment(part)) {
			return null;
		}
	}

	const repoPath = repoPathSegments.join("/");
	const repoURL = repoPath
		? `https://${host}/${repoPath}`
		: `https://${host}`;

	return {
		repoURL,
		host,
		repoPath,
		chartName,
		fullName: name,
	};
}

/** Reject localhost, bare names, IPs, and obvious internal hosts. */
export function isPublicHostname(host: string): boolean {
	const h = host.toLowerCase();
	if (!h || h.length > 253) return false;
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
		return false;
	}
	if (h.includes(":") || h.includes(" ")) return false; // no IPv6 / junk
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // no raw IPv4
	if (!h.includes(".")) return false; // require a dot (e.g. example.com)
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h)) {
		return false;
	}
	return true;
}

function isValidChartName(name: string): boolean {
	// Helm chart names are lowercase alphanumerics and dashes (practically).
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

function isValidPathSegment(part: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part);
}
