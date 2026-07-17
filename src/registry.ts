import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser();

// Redirects to GitHub Packages with embedded credentials for public
// repositories, so an unauthenticated GET already works — standard Maven
// repository behavior, not an Aklivity-specific workaround.
const DEFAULT_REGISTRY_URL = 'https://maven.packages.aklivity.io';

export function pomUrl(groupId: string, artifactId: string, version: string, registryUrl = DEFAULT_REGISTRY_URL): string {
  const groupPath = groupId.replace(/\./g, '/');
  return `${registryUrl}/${groupPath}/${artifactId}/${version}/${artifactId}-${version}.pom`;
}

const MAX_REDIRECTS = 5;

// maven.packages.aklivity.io's own redirect embeds a username:password in
// the target URL (e.g. "https://user:token@maven.pkg.github.com/..."), and
// the Fetch spec forbids automatically following a redirect whose target
// carries embedded credentials — enforced by Node's fetch even outside a
// browser (confirmed against the real registry: plain `fetch(url)` throws
// "cross origin not allowed for request mode 'cors'" on this exact
// redirect). Followed manually instead: read the Location header ourselves
// or move any embedded credentials into a Basic Authorization header and
// re-request a credential-free URL, so the request the Fetch spec actually
// sees never has embedded userinfo in the first place.
async function fetchFollowingRedirects(url: string, init: RequestInit, redirectsLeft: number): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  const isRedirect = response.status >= 300 && response.status < 400;
  const location = response.headers.get('location');
  if (!isRedirect || location === null || redirectsLeft <= 0)
  {
    return response;
  }

  const nextUrl = new URL(location, url);
  const headers = new Headers(init.headers);
  if (nextUrl.username || nextUrl.password)
  {
    const credentials = `${decodeURIComponent(nextUrl.username)}:${decodeURIComponent(nextUrl.password)}`;
    headers.set('Authorization', `Basic ${Buffer.from(credentials).toString('base64')}`);
    nextUrl.username = '';
    nextUrl.password = '';
  }
  return fetchFollowingRedirects(nextUrl.toString(), { ...init, headers }, redirectsLeft - 1);
}

// Fetches a published artifact's pom.xml text — undefined on any non-2xx
// response (missing artifact, missing version, registry unreachable),
// leaving the caller to decide whether that's fatal or a skip-with-warning.
export async function fetchPom(groupId: string, artifactId: string, version: string, registryUrl = DEFAULT_REGISTRY_URL): Promise<string | undefined> {
  const response = await fetchFollowingRedirects(pomUrl(groupId, artifactId, version, registryUrl), {}, MAX_REDIRECTS);
  return response.ok ? response.text() : undefined;
}

interface PomScm {
  url?: unknown;
  connection?: unknown;
  developerConnection?: unknown;
}

// Matches a github.com host in either a plain https URL or Maven's
// "scm:git:https://..." connection-string form, and strips a trailing
// ".git" — the same repo identity regardless of which <scm> child element
// carried it or how it's suffixed.
const GITHUB_SCM_PATTERN = /github\.com[/:]+([^/]+)\/([^/.]+)(?:\.git)?\/?$/;

// Discovers a published artifact's own source repo from its pom's <scm>
// block — undefined when the block is missing entirely or doesn't resolve
// to a github.com host, which callers treat as "not actionable yet" rather
// than an error: this tool's driver is GitHub-API-based, so a non-GitHub
// upstream has nowhere to be folded in from regardless.
export function extractGithubRepo(pomXml: string): string | undefined {
  const doc = parser.parse(pomXml) as { project?: { scm?: PomScm } };
  const scm = doc.project?.scm;
  if (scm === undefined)
  {
    return undefined;
  }

  const candidates = [scm.url, scm.connection, scm.developerConnection]
    .filter((value): value is string | number => value !== undefined)
    .map(String);

  for (const candidate of candidates)
  {
    const match = GITHUB_SCM_PATTERN.exec(candidate);
    if (match)
    {
      return `${match[1]}/${match[2]}`;
    }
  }
  return undefined;
}
