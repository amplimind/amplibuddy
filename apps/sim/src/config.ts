import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { PLACES, parseFrontmatter, parseHours, type Neighbor, type Persona, type PlaceId } from '@ampli-world/shared';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const envFile = `${ROOT}.env`;
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  port: Number(process.env.SIM_PORT ?? 4300),
  minutesPerSecond: Number(process.env.SIM_MINUTES_PER_SECOND ?? 0.1),
  brainToken: process.env.BRAIN_TOKEN ?? '',
  adminToken: process.env.ADMIN_TOKEN ?? '',
  sitePassword: process.env.SITE_PASSWORD ?? '',
  dbFile: process.env.SIM_DB_FILE ?? `${ROOT}data/world.db`,
  libraryDir: `${ROOT}world/library`,
  personaFile: `${ROOT}world/persona.md`,
  neighborsDir: `${ROOT}world/neighbors`,
  webDist: `${ROOT}apps/web/dist`,
};

export function loadPersona(): Persona {
  const { meta } = parseFrontmatter(readFileSync(config.personaFile, 'utf8'));
  return {
    name: meta.name ?? 'Ampli',
    species: meta.species ?? 'small fox',
    town: meta.town ?? 'Ampliville',
  };
}

/**
 * Other animals in town: world/neighbors/<id>.md with name/species/place frontmatter.
 * `active: false` keeps a neighbour on file but out of town.
 */
export function loadNeighbors(): Neighbor[] {
  if (!existsSync(config.neighborsDir)) return [];
  return readdirSync(config.neighborsDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => ({ file, meta: parseFrontmatter(readFileSync(`${config.neighborsDir}/${file}`, 'utf8')).meta }))
    .filter(({ meta }) => meta.active !== 'false')
    .map(({ file, meta }) => {
      const place = (meta.place && meta.place in PLACES ? meta.place : 'cafe') as PlaceId;
      const hours = parseHours(meta.hours);
      return {
        id: basename(file, '.md'),
        name: meta.name ?? basename(file, '.md'),
        species: meta.species ?? 'animal',
        place,
        ...(hours ? { hours } : {}),
      };
    });
}
