import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../src/registry.js';
import { resolveUpstreamConfig } from '../src/discover-upstream.js';
import type { ExplicitUpstreamConfig, UpstreamConfig } from '../src/types.js';

describe('resolveUpstreamConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes an already-explicit config through unchanged, with no discovery I/O', async () => {
    const explicit: UpstreamConfig = {
      repo: 'acme/engine',
      'dependency-version-file': 'pom.xml',
      'dependency-version-property': 'engine.version',
      classification: 'maven',
    };
    const fetchSpy = vi.spyOn(registry, 'fetchPom');

    const result = await resolveUpstreamConfig(explicit, '/nonexistent');

    expect(result).toEqual({ config: explicit });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('maven-discovered ({maven: {groupId, artifactId}}) config', () => {
    let gitDir: string;

    beforeEach(async () => {
      gitDir = await mkdtemp(join(tmpdir(), 'gitflow-changelog-discover-test-'));
      await writeFile(
        join(gitDir, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <artifactId>zilla-plus</artifactId>
  <properties>
    <zilla.version>2.0.0-alpha-34</zilla.version>
  </properties>
</project>
`,
        'utf8',
      );
      await mkdir(join(gitDir, 'cloud', 'docker-image'), { recursive: true });
      await writeFile(
        join(gitDir, 'cloud', 'docker-image', 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <artifactId>docker-image</artifactId>
  <dependencies>
    <dependency>
      <groupId>io.aklivity.zilla</groupId>
      <artifactId>engine</artifactId>
      <version>\${zilla.version}</version>
    </dependency>
  </dependencies>
</project>
`,
        'utf8',
      );
    });

    afterEach(async () => {
      await rm(gitDir, { recursive: true, force: true });
    });

    it('resolves repo + version-file + version-property from Maven metadata', async () => {
      vi.spyOn(registry, 'fetchPom').mockImplementation(async (groupId, artifactId, version) => {
        expect(groupId).toBe('io.aklivity.zilla');
        expect(artifactId).toBe('zilla');
        expect(version).toBe('2.0.0-alpha-34');
        return '<project><scm><url>https://github.com/aklivity/zilla</url></scm></project>';
      });

      const discovered: UpstreamConfig = { maven: { groupId: 'io.aklivity.zilla', artifactId: 'zilla' } };
      const result = await resolveUpstreamConfig(discovered, gitDir);

      const expected: ExplicitUpstreamConfig = {
        repo: 'aklivity/zilla',
        'dependency-version-file': 'pom.xml',
        'dependency-version-property': 'zilla.version',
        classification: 'maven',
        'maven-group-id': 'io.aklivity.zilla',
      };
      expect(result).toEqual({ config: expected });
    });

    it('skips with a warning when no dependency under the groupId has a property-form version', async () => {
      const discovered: UpstreamConfig = { maven: { groupId: 'io.aklivity.nonexistent', artifactId: 'nonexistent' } };
      const result = await resolveUpstreamConfig(discovered, gitDir);

      expect(result.config).toBeUndefined();
      expect(result.warning).toMatch(/io.aklivity.nonexistent:nonexistent/);
      expect(result.warning).toMatch(/no dependency under groupId/);
    });

    it('skips with a warning when the discovered pom has no github.com <scm>', async () => {
      vi.spyOn(registry, 'fetchPom').mockResolvedValue('<project><scm><url>https://gitlab.com/acme/engine</url></scm></project>');

      const discovered: UpstreamConfig = { maven: { groupId: 'io.aklivity.zilla', artifactId: 'zilla' } };
      const result = await resolveUpstreamConfig(discovered, gitDir);

      expect(result.config).toBeUndefined();
      expect(result.warning).toMatch(/could not discover a github.com <scm> URL/);
    });

    it('skips with a warning when the artifact pom fails to fetch entirely', async () => {
      vi.spyOn(registry, 'fetchPom').mockResolvedValue(undefined);

      const discovered: UpstreamConfig = { maven: { groupId: 'io.aklivity.zilla', artifactId: 'zilla' } };
      const result = await resolveUpstreamConfig(discovered, gitDir);

      expect(result.config).toBeUndefined();
      expect(result.warning).toMatch(/could not discover a github.com <scm> URL/);
    });
  });
});
