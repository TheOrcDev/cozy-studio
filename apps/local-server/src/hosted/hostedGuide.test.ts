import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// hostedGuide.ts imports Markdown as text, which Vitest cannot load, so read its source instead.
describe('hosted studio_guide', () => {
  it('serves every reference of the cozy-studio-mcp skill', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./hostedGuide.ts', import.meta.url)),
      'utf8',
    );
    const references = readdirSync(
      fileURLToPath(new URL('../../../../skills/cozy-studio-mcp/references/', import.meta.url)),
    ).filter((file) => file.endsWith('.md'));

    expect(references.length).toBeGreaterThan(0);
    for (const file of references) {
      expect(source).toContain(`/skills/cozy-studio-mcp/references/${file}'`);
      const topic = file.slice(0, -3);
      expect(source).toMatch(new RegExp(`^  (?:'${topic}': \\w+|${topic}),$`, 'm'));
    }
  });
});
