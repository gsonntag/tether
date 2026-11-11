// Every messaging connector (connector.ts), in order: the first one connected is where Tether's texts
// go when the person hasn't written yet and hasn't picked one. A new one (Slack, Telegram) is a file
// that implements Connector, and a line here.

import type { Connector } from "./connector";
import { discordConnector, type DiscordDeps } from "./discord";
import { imessageConnector } from "./imessage";
import type { OpenLink } from "./link";
import type { TextingStore } from "./store";

export interface ConnectorDeps {
  /** iMessage's link (tests) */
  imessage?: OpenLink;
  discord?: DiscordDeps;
}

export function connectors(store: TextingStore, deps: ConnectorDeps = {}): Connector[] {
  return [imessageConnector(store, deps.imessage), discordConnector(store, deps.discord)];
}
