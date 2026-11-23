import { useEffect, useState } from "react";
import type { Card, HubClient } from "./api/client";

const POLL_MS = 12_000;
type Entry = { cards: Card[]; listeners: Set<(cards: Card[]) => void>; timer: ReturnType<typeof setInterval>; pending?: Promise<void> };
const entries = new Map<string, Entry>();
const keyOf = (client: HubClient, project?: string) => `${client.baseUrl}\u0000${project ?? ""}`;

function publish(entry: Entry, cards: Card[]) {
  entry.cards = cards;
  for (const listener of entry.listeners) listener(cards);
}

export function refreshTasks(client: HubClient, project?: string): Promise<void> {
  const entry = entries.get(keyOf(client, project));
  if (!entry) return client.tasks(project).then(() => {});
  if (entry.pending) return entry.pending;
  entry.pending = client.tasks(project).then(cards => publish(entry, cards)).finally(() => { entry.pending = undefined; });
  return entry.pending;
}

export function subscribeTasks(client: HubClient, project: string | undefined, listener: (cards: Card[]) => void) {
  const key = keyOf(client, project);
  let entry = entries.get(key);
  if (!entry) {
    const created: Entry = { cards: [], listeners: new Set(), timer: setInterval(() => { void refreshTasks(client, project).catch(() => {}); }, POLL_MS) };
    entries.set(key, created);
    entry = created;
    void refreshTasks(client, project).catch(() => {});
  }
  entry.listeners.add(listener);
  listener(entry.cards);
  return () => {
    entry?.listeners.delete(listener);
    if (entry && entry.listeners.size === 0) {
      clearInterval(entry.timer);
      entries.delete(key);
    }
  };
}

export function useTasks(client: HubClient, project?: string) {
  const [cards, setCards] = useState<Card[]>([]);
  useEffect(() => subscribeTasks(client, project, setCards), [client, project]);
  return cards;
}
