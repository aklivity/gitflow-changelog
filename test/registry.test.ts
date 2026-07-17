import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractGithubRepo, fetchPom, pomUrl } from '../src/registry.js';

describe('pomUrl', () => {
  it('builds the standard Maven repository layout from groupId/artifactId/version', () => {
    expect(pomUrl('io.aklivity.zilla', 'zilla', '2.0.0-alpha-34')).toBe(
      'https://maven.packages.aklivity.io/io/aklivity/zilla/zilla/2.0.0-alpha-34/zilla-2.0.0-alpha-34.pom',
    );
  });

  it('honors a custom registry base URL', () => {
    expect(pomUrl('io.aklivity.zilla', 'zilla', '1.0.0', 'https://repo.example.com')).toBe(
      'https://repo.example.com/io/aklivity/zilla/zilla/1.0.0/zilla-1.0.0.pom',
    );
  });
});

function okResponse(text: string): Response {
  return { ok: true, status: 200, headers: new Headers(), text: async () => text } as Response;
}

function notFoundResponse(): Response {
  return { ok: false, status: 404, headers: new Headers(), text: async () => 'Not Found' } as Response;
}

function redirectResponse(location: string): Response {
  return { ok: false, status: 302, headers: new Headers({ location }), text: async () => '' } as Response;
}

describe('fetchPom', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the pom text on a 2xx response', async () => {
    const fetchMock = vi.fn(async () => okResponse('<project/>'));
    vi.stubGlobal('fetch', fetchMock);

    const text = await fetchPom('io.aklivity.zilla', 'zilla', '2.0.0-alpha-34');
    expect(text).toBe('<project/>');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://maven.packages.aklivity.io/io/aklivity/zilla/zilla/2.0.0-alpha-34/zilla-2.0.0-alpha-34.pom',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('returns undefined on a non-2xx response, e.g. an unpublished version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse()));
    expect(await fetchPom('io.aklivity.zilla', 'zilla', '999.999.999')).toBeUndefined();
  });

  // Reproduces the real maven.packages.aklivity.io behavior: it 302s to a
  // GitHub Packages URL with embedded username:password credentials, which
  // the Fetch spec forbids auto-following — verified against the live
  // registry, not just this mock.
  it('follows a redirect whose target embeds credentials, moving them to a Basic Authorization header', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => redirectResponse('https://user:t0ken@maven.pkg.github.com/aklivity/packages/io/aklivity/zilla/zilla/2.0.0-alpha-34/zilla-2.0.0-alpha-34.pom'))
      .mockImplementationOnce(async () => okResponse('<project/>'));
    vi.stubGlobal('fetch', fetchMock);

    const text = await fetchPom('io.aklivity.zilla', 'zilla', '2.0.0-alpha-34');

    expect(text).toBe('<project/>');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [secondUrl, secondInit] = fetchMock.mock.calls[1];
    expect(secondUrl).toBe('https://maven.pkg.github.com/aklivity/packages/io/aklivity/zilla/zilla/2.0.0-alpha-34/zilla-2.0.0-alpha-34.pom');
    expect(new Headers(secondInit.headers).get('Authorization')).toBe(`Basic ${Buffer.from('user:t0ken').toString('base64')}`);
  });

  it('gives up after too many redirects rather than looping forever', async () => {
    const fetchMock = vi.fn(async () => redirectResponse('https://maven.packages.aklivity.io/loop'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPom('io.aklivity.zilla', 'zilla', '2.0.0-alpha-34');
    expect(result).toBeUndefined();
    expect(fetchMock.mock.calls.length).toBeLessThan(20);
  });
});

describe('extractGithubRepo', () => {
  it('reads a plain https <url>', () => {
    const pomXml = '<project><scm><url>https://github.com/aklivity/zilla</url></scm></project>';
    expect(extractGithubRepo(pomXml)).toBe('aklivity/zilla');
  });

  it('reads a scm:git: <connection> and strips a trailing .git', () => {
    const pomXml = '<project><scm><connection>scm:git:https://github.com/aklivity/zilla-plus.git</connection></scm></project>';
    expect(extractGithubRepo(pomXml)).toBe('aklivity/zilla-plus');
  });

  it('returns undefined for a non-github.com scm host', () => {
    const pomXml = '<project><scm><url>https://gitlab.com/acme/engine</url></scm></project>';
    expect(extractGithubRepo(pomXml)).toBeUndefined();
  });

  it('returns undefined when the pom has no <scm> block at all', () => {
    expect(extractGithubRepo('<project><artifactId>zilla</artifactId></project>')).toBeUndefined();
  });
});
