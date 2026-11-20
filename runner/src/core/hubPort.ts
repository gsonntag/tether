// The runner's end of the texting hub (shared/textingHub.ts): who its hub is (the server says, on
// connect and whenever it changes), frames to and from it, and, when this runner is a hub, what its
// hello says about that. The texting module (modules/texting/hub.ts) does the rest.

import type { RunnerToServer } from "../../../shared/protocol";
import type { HubFrame, TextingHubInfo, TextingHubState } from "../../../shared/textingHub";

export class HubPort {
  /** the runner that texts for this one (none: no hub connected, or this one is a hub, or disconnected) */
  hub: TextingHubInfo | null = null;
  /** what this runner's hello says as a hub (none: it isn't one) */
  state?: TextingHubState;
  private hubListeners = new Set<(h: TextingHubInfo | null) => void>();
  private frameListener?: (from: string, m: HubFrame) => void;

  constructor(
    private sendFrame: (m: RunnerToServer) => boolean,
    /** bytes waiting in the connection's send buffer */
    readonly buffered: () => number,
    /** says hello again (the hub state changed) */
    private announce: () => void,
  ) {}

  /** This runner as a hub (or not, undefined): its hello says so when that changed. */
  setState(s: TextingHubState | undefined) {
    if (JSON.stringify(s) === JSON.stringify(this.state)) return;
    this.state = s;
    this.announce();
  }

  /** The server named this runner's hub (or none). */
  gotHub(h: TextingHubInfo | null) {
    if (JSON.stringify(h) === JSON.stringify(this.hub)) return;
    this.hub = h;
    for (const f of [...this.hubListeners]) f(h);
  }

  gotFrame(from: string, m: HubFrame) {
    this.frameListener?.(from, m);
  }

  onHub(f: (h: TextingHubInfo | null) => void): () => void {
    this.hubListeners.add(f);
    return () => this.hubListeners.delete(f);
  }

  onFrame(f: (from: string, m: HubFrame) => void): () => void {
    this.frameListener = f;
    return () => {
      if (this.frameListener === f) this.frameListener = undefined;
    };
  }

  /** Sends a frame to runner `to`; false when not connected. */
  post(to: string, m: HubFrame): boolean {
    return this.sendFrame({ t: "texting", to, m });
  }
}
