import { useEffect, useRef, useState } from 'react';
import type { DiaryEntry, UsageToday, WorldEvent, WorldSnapshot } from '@ampli-world/shared';

const MAX_EVENTS = 300;

/** Latest snapshot plus when it arrived, so the canvas can extrapolate between ticks. */
export interface LiveSnapshot {
  snapshot: WorldSnapshot;
  receivedAt: number;
}

export interface Bubble {
  text: string;
  receivedAt: number;
  /** Who is speaking: 'ampli' (default) or a neighbour id. */
  speaker?: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

function mergeEvents(prev: WorldEvent[], incoming: WorldEvent[]): WorldEvent[] {
  const seen = new Set(prev.map((e) => e.id));
  const merged = [...prev, ...incoming.filter((e) => !seen.has(e.id))].sort((a, b) => a.id - b.id);
  return merged.slice(-MAX_EVENTS);
}

export function useWorld() {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [diary, setDiary] = useState<DiaryEntry[]>([]);
  const [notebook, setNotebook] = useState<string[]>([]);
  const [usage, setUsage] = useState<UsageToday>({ calls: 0, costUsd: 0 });
  const [connected, setConnected] = useState(false);
  /** Bumped whenever Ampli reads a letter, so the mailbox view refetches. */
  const [mailVersion, setMailVersion] = useState(0);
  /** Bumped whenever a new artwork goes up, so the gallery refetches. */
  const [artVersion, setArtVersion] = useState(0);
  const [codeVersion, setCodeVersion] = useState(0);
  const live = useRef<LiveSnapshot | null>(null);
  const bubble = useRef<Bubble | null>(null);

  useEffect(() => {
    const refreshMemory = () => {
      getJson<DiaryEntry[]>('/api/diary').then(setDiary).catch(() => {});
      getJson<string[]>('/api/notebook').then(setNotebook).catch(() => {});
    };
    const refreshUsage = () => getJson<UsageToday>('/api/usage').then(setUsage).catch(() => {});

    getJson<WorldEvent[]>('/api/events?limit=120')
      .then((initial) => setEvents((prev) => mergeEvents(prev, initial)))
      .catch(() => {});
    refreshMemory();
    refreshUsage();

    const source = new EventSource('/api/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('state', (e) => {
      const snap = JSON.parse((e as MessageEvent<string>).data) as WorldSnapshot;
      live.current = { snapshot: snap, receivedAt: performance.now() };
      setSnapshot(snap);
    });
    source.addEventListener('event', (e) => {
      const event = JSON.parse((e as MessageEvent<string>).data) as WorldEvent;
      setEvents((prev) => mergeEvents(prev, [event]));
      if (event.type === 'thought') bubble.current = { text: event.data.text, receivedAt: performance.now() };
      if (event.type === 'reading') bubble.current = { text: event.data.takeaway, receivedAt: performance.now() };
      if (event.type === 'chat_line') {
        bubble.current = { text: event.data.text, receivedAt: performance.now(), speaker: event.data.speaker };
        if (event.data.llm) refreshUsage();
      }
      if (event.type === 'code_committed') {
        setCodeVersion((v) => v + 1);
        if (event.data.message) bubble.current = { text: `Committed: ${event.data.message}`, receivedAt: performance.now() };
        refreshUsage();
      }
      if (event.type === 'artwork_created') {
        setArtVersion((v) => v + 1);
        bubble.current = { text: `I made something: “${event.data.title}”`, receivedAt: performance.now() };
        refreshUsage();
      }
      if (event.type === 'mail_read') {
        setMailVersion((v) => v + 1);
        refreshUsage();
        if (event.data.reply) bubble.current = { text: event.data.reply, receivedAt: performance.now() };
      }
      if (event.type === 'diary_written') {
        refreshMemory();
        refreshUsage();
      }
      if ((event.type === 'thought' || event.type === 'reading') && event.data.llm) refreshUsage();
    });
    return () => source.close();
  }, []);

  return { snapshot, events, diary, notebook, usage, connected, live, bubble, mailVersion, artVersion, codeVersion };
}
