import { useEffect, useRef, useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { VStack } from "@astryxdesign/core/Layout";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { Bars3Icon } from "@heroicons/react/24/outline";
import { Dialogs } from "./components/Dialogs";
import { SessionView } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import { listenForOpen, pushOnHere, pushSupported } from "./push";
import { NARROW_QUERY, openLink, switchRunner, toggleSidebar, useStore } from "./store";
import { useDrawerSwipe } from "./swipe";

listenForOpen();

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

export function App() {
  return (
    <ToastViewport position="bottomEnd" maxVisible={4}>
      <Shell />
      <ToastBridge />
    </ToastViewport>
  );
}

const swipeIsOpen = () => useStore.getState().sidebarOpen;
const swipeSetOpen = (open: boolean) => useStore.setState({ sidebarOpen: open });

function Shell() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const sidebarHidden = useStore((s) => s.sidebarHidden);
  const selected = useStore((s) => s.selected);
  const connected = useStore((s) => s.connected);
  const runnerId = useStore((s) => s.runnerId);
  const narrow = useNarrow();
  useDrawerSwipe(narrow, swipeIsOpen, swipeSetOpen);

  // Deep links: #/s/<id>, and #/r/<runnerId>/s/<sessionId> from notifications
  useEffect(() => {
    const fromHash = () => {
      const r = location.hash.match(/^#\/r\/([^/]+)\/s\/(.+)$/);
      if (r) switchRunner(decodeURIComponent(r[1]!));
      const m = r ?? location.hash.match(/^#\/s\/(.+)$/);
      if (m) openLink(decodeURIComponent(m[r ? 2 : 1]!));
    };
    // Right away, not after the runner connects: a saved copy can show while it does.
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  // Ctrl/Cmd+Shift+O: new session; Ctrl/Cmd+B: toggle the sidebar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === "o") {
        e.preventDefault();
        useStore.setState({ dialog: "new", newSessionProject: undefined });
      } else if (!e.shiftKey && k === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // First visit with no answer yet on this device: offer push notifications once.
  useEffect(() => {
    if (!runnerId || !pushSupported() || Notification.permission === "denied") return;
    if (localStorage.getItem("tether.notifyAsked") || pushOnHere(runnerId)) return;
    localStorage.setItem("tether.notifyAsked", "1");
    if (!useStore.getState().dialog) useStore.setState({ dialog: "notify" });
  }, [runnerId]);

  const showSide = narrow || !sidebarHidden;
  const banner = !connected ? (
    <Banner status="error" container="section" collapsible={false} title="Disconnected · reconnecting…" />
  ) : !runnerId ? (
    <Banner status="warning" container="section" collapsible={false} title="No runner is connected" description="Start one on your machine (see README)." />
  ) : undefined;

  return (
    <AppShell
      variant="section"
      banner={banner}
      sideNav={showSide ? <Sidebar narrow={narrow} /> : undefined}
      mobileNav={{ hasToggle: false, isOpen: sidebarOpen, onOpenChange: (open) => useStore.setState({ sidebarOpen: open }) }}
    >
      <VStack height="100%" style={{ position: "relative", minHeight: 0 }}>
        {(narrow || sidebarHidden) && (
          <IconButton
            label="Show sidebar"
            tooltip="Show sidebar (⌘B)"
            variant="secondary"
            size="sm"
            icon={<Icon icon={Bars3Icon} />}
            onClick={toggleSidebar}
            style={{ position: "absolute", top: "var(--spacing-2)", insetInlineStart: "var(--spacing-2)", zIndex: 2 }}
          />
        )}
        {selected ? <SessionView key={selected} sessionId={selected} /> : <Home />}
      </VStack>
      <Dialogs />
    </AppShell>
  );
}

/** Shows the store's toasts (from rpc errors and the like) through Astryx's toast stack. */
function ToastBridge() {
  const show = useToast();
  const toasts = useStore((s) => s.toasts);
  const shown = useRef(new Set<number>());
  useEffect(() => {
    for (const t of toasts) {
      if (shown.current.has(t.id)) continue;
      shown.current.add(t.id);
      show({ body: t.text, type: t.level === "error" ? "error" : "info", uniqueID: `t${t.id}` });
    }
  }, [toasts, show]);
  return null;
}

function Home() {
  return (
    <VStack height="100%" vAlign="center" hAlign="center" padding={6}>
      <EmptyState
        title="Pick a session or start a new one"
        description="Agents keep running on your runner when you close this page."
        actions={<Button label="New session" variant="primary" onClick={() => useStore.setState({ dialog: "new", newSessionProject: undefined })} />}
      />
    </VStack>
  );
}
