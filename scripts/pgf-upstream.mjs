// Shared helpers for pinning and tracking wipfli/pgf-glyph-ranges.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
export const manifestPath = path.join(root, 'scripts/pgf-glyphs-upstream.json');
export const fontDir = 'font/NotoSansMultiscript-Regular-v1';
const apiUrl = `https://api.github.com/repos/wipfli/pgf-glyph-ranges/commits?path=font&per_page=1`;

export function rawGlyphUrl(sha, filename) {
  return `https://raw.githubusercontent.com/wipfli/pgf-glyph-ranges/${sha}/${fontDir}/${filename}`;
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Latest upstream commit that touched anything under font/.
export async function getLatestCommit() {
  const response = await fetch(apiUrl, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'railrouter-sg-glyph-check' },
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  const [commit] = await response.json();
  if (!commit?.sha) throw new Error('No commit returned by GitHub API');
  return {
    sha: commit.sha,
    message: commit.commit?.message?.split('\n')[0] ?? '',
    date: commit.commit?.committer?.date ?? '',
    url: commit.html_url,
  };
}

export async function readManifest() {
  try {
    return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeManifest(manifest) {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
