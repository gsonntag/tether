// Every messaging connector (connector.ts), in order: the first one connected is where Tether's texts
// go when the person hasn't written yet and hasn't picked one. A new one (Slack, Telegram) is a file
// that implements Connector, a line here, and its app in shared/fromTether.ts MESSAGING_APPS (its
// "[From <app>] " marker and "via <app>" label).

import type { Connector } from "./connector";
import { discordConnector } from "./discord";
import { imessageConnector } from "./imessage";
import type { TextingStore } from "./store";

/** What a connector needs to be made: the store, and its own test hooks (by its id). */
export type ConnectorFactory = (store: TextingStore, deps?: any) => Connector;

export const CONNECTORS: { id: string; make: ConnectorFactory }[] = [
  { id: "imessage", make: imessageConnector },
  { id: "discord", make: discordConnector },
];

/** Each connector's test hooks, by its id (iMessage: its OpenLink; Discord: DiscordDeps). */
export type ConnectorDeps = Record<string, unknown>;

export function connectors(store: TextingStore, deps: ConnectorDeps = {}): Connector[] {
  return CONNECTORS.map((c) => c.make(store, deps[c.id]));
}
