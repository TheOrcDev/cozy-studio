import type { StudioEvent, UnknownStudioEvent } from '../../../packages/shared/src';

type PublishedStudioEvent = StudioEvent | UnknownStudioEvent;
type Listener = (event: PublishedStudioEvent) => void;

const listeners = new Set<Listener>();
let currentRevision = 0;

/** Durable revision source; hosted mode (ADR 0013) shares one revision order across instances. */
export interface StudioEventSink {
  append(event: { type: string; payload: unknown; createdAt: string }): number;
  currentRevision(): number;
}

let eventSink: StudioEventSink | null = null;

export function setStudioEventSink(sink: StudioEventSink | null) {
  eventSink = sink;
}

export function publishEvent(type: string, payload: unknown) {
  const createdAt = new Date().toISOString();
  const event: PublishedStudioEvent = {
    type,
    payload,
    createdAt,
    revision: eventSink ? eventSink.append({ type, payload, createdAt }) : ++currentRevision,
  };
  for (const listener of listeners) {
    listener(event);
  }
  return event;
}

export function getCurrentEventRevision() {
  return eventSink ? eventSink.currentRevision() : currentRevision;
}

export function subscribeEvents(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
