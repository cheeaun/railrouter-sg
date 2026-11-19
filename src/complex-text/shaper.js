// Browser entry point for the ported HarfBuzz Tamil shaper.
// See tamil-shaper.js for provenance and details.
import { createTamilShaper } from './tamil-shaper.js';

const loadAsset = async (url, kind) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return kind === 'text' ? response.text() : response.arrayBuffer();
};

export const tamilShaper = createTamilShaper(loadAsset);
