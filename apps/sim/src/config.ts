import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PLACES, lookOf, parseFrontmatter, parseHours, type Neighbor, type Persona, type PlaceId } from '@ampli-world/shared';
import { DATA_DIR, ROOT, loadEnvironment, neighborsDir, personaFile } from '@ampli-world/shared/node';

export { ROOT };

loadEnvironment();

export const config = {
  port: Number(process.env.SIM_PORT ?? 4300),
  /** Only this Mac by default; set SIM_HOST=0.0.0.0 to share the town on your network. */
  host: process.env.SIM_HOST || '127.0.0.1',
  minutesPerSecond: Number(process.env.SIM_MINUTES_PER_SECOND ?? 0.1),
  brainToken: process.env.BRAIN_TOKEN ?? '',
  adminToken: process.env.ADMIN_TOKEN ?? '',
  /** Read-only connection to a local GyrOS API (e.g. http://localhost:8100); empty = no workshop. */
  gyrosUrl: (process.env.GYROS_URL ?? '').replace(/\/+$/, ''),
  /** GyrOS's own UI, for "open in GyrOS" links (e.g. http://localhost:3200). */
  gyrosUiUrl: (process.env.GYROS_UI_URL ?? '').replace(/\/+$/, ''),
  /** Ampli rings the workshop bell for runs waiting longer than this (real minutes). 0 = never. */
  gyrosNudgeAfterMin: Number(process.env.GYROS_NUDGE_AFTER_MIN ?? 120),
  sitePassword: process.env.SITE_PASSWORD ?? '',
  dbFile: process.env.SIM_DB_FILE ?? join(DATA_DIR, 'world.db'),
  webDist: `${ROOT}apps/web/dist`,
};

export function loadPersona(): Persona {
  const { meta } = parseFrontmatter(readFileSync(personaFile(), 'utf8'));
  return {
    name: meta.name ?? 'Ampli',
    species: meta.species ?? 'small fox',
    look: lookOf(meta.species ?? 'small fox', meta.look),
    town: meta.town ?? 'Ampliville',
  };
}

/**
 * Other animals in town: world/neighbors/<id>.md with name/species/place frontmatter.
 * `active: false` keeps a neighbour on file but out of town.
 */
export function loadNeighbors(): Neighbor[] {
  const dir = neighborsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => ({ file, meta: parseFrontmatter(readFileSync(`${dir}/${file}`, 'utf8')).meta }))
    .filter(({ meta }) => meta.active !== 'false')
    .map(({ file, meta }) => {
      const place = (meta.place && meta.place in PLACES ? meta.place : 'cafe') as PlaceId;
      const hours = parseHours(meta.hours);
      return {
        id: basename(file, '.md'),
        name: meta.name ?? basename(file, '.md'),
        species: meta.species ?? 'animal',
        look: lookOf(meta.species, meta.look),
        place,
        ...(hours ? { hours } : {}),
      };
    });
}
