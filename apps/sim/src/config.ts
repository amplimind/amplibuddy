import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, type Persona } from '@ampli-world/shared';

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
