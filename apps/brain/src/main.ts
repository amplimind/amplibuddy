import { setTimeout as sleep } from 'node:timers/promises';
import { config, loadNeighborPersonas, loadPersonaPrompt } from './config.ts';
import { Mind } from './mind.ts';
import { SimClient } from './sim-client.ts';

const sim = new SimClient(config.simUrl, config.brainToken);
const mind = new Mind(sim, loadPersonaPrompt(), config, loadNeighborPersonas());

console.log(
  !config.llm.openRouter
    ? `[brain] local LLM at ${config.llm.baseUrl}: thinking with ${config.brainModel}, reflecting with ${config.reflectModel} (no cost limits, internet café closed)`
    : config.llm.apiKey
      ? `[brain] thinking with ${config.brainModel}, reflecting with ${config.reflectModel}, budget $${config.dailyBudgetUsd}/day`
      : '[brain] no OPENROUTER_API_KEY: running offline (rules + utility choices, no LLM)',
);

let simReachable = true;
for (;;) {
  try {
    const ctx = await sim.context();
    if (!simReachable) console.log('[brain] sim is back');
    simReachable = true;
    await mind.step(ctx);
  } catch (err) {
    if (simReachable) console.warn(`[brain] can't reach sim at ${config.simUrl}:`, (err as Error).message);
    simReachable = false;
  }
  await sleep(config.pollMs);
}
