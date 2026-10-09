import { useEffect } from "react";
import { Dialogs } from "./components/Dialogs";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import { listenForOpen } from "./push";
import { selectSession, switchRunner, useStore } from "./store";

listenForOpen();

export function App() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const selected = useStore((s) => s.selected);
  const connected = useStore((s) => s.connected);
  const runnerId = useStore((s) => s.runnerId);
  const toasts = useStore((s) => s.toasts);

  // Deep links: #/s/<sessionId>, and #/r/<runnerId>/s/<sessionId> from notifications
  useEffect(() => {
    const fromHash = () => {
      const r = location.hash.match(/^#\/r\/([^/]+)\/s\/(.+)$/);
      if (r) switchRunner(decodeURIComponent(r[1]!));
      const m = r ?? location.hash.match(/^#\/s\/(.+)$/);
      if (m) selectSession(decodeURIComponent(m[r ? 2 : 1]!));
    };
    // Right away, not after the runner connects: a saved copy can show while it does.
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  // Ctrl/Cmd+K: new session
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useStore.setState({ dialog: "new", newSessionProject: undefined });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`app${sidebarOpen ? " side-open" : ""}`}>
      <div className="scrim" onClick={() => useStore.setState({ sidebarOpen: false })} />
      <Sidebar />
      <main>
        {!connected && <div className="offline">Reconnecting…</div>}
        {connected && !runnerId && <div className="offline">No runner is connected. Start one on your machine (see README).</div>}
        {selected ? <SessionView key={selected} sessionId={selected} /> : <Home />}
      </main>
      <Dialogs />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Home() {
  return (
    <>
      <header className="top">
        <button className="menu-btn" onClick={() => useStore.setState({ sidebarOpen: true })} aria-label="Menu">
          ☰
        </button>
        <div className="ttl">
          <div className="title">Tether</div>
        </div>
      </header>
      <div className="empty">
        <div>
          <h2>Pick a session or start a new one</h2>
          <div>Agents keep running on your runner when you close this page.</div>
          <div className="btns" style={{ justifyContent: "center", marginTop: 16 }}>
            <button className="btn pri" onClick={() => useStore.setState({ dialog: "new", newSessionProject: undefined })}>
              New session
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
