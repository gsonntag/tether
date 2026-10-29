import { AppShell } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import { Home } from "./components/Home";
import { Sidebar } from "./components/Sidebar";
import { useStore } from "./store";

export function App() {
  const link = useStore((s) => s.link);
  const everOpen = useStore((s) => s.everOpen);
  const auth = useStore((s) => s.auth);
  const stale = useStore((s) => s.stale);
  const sidebarOpen = useStore((s) => s.sidebarOpen);

  const banner =
    auth !== "ok" ? undefined : stale ? (
      <Banner status="info" container="section" collapsible={false} title="Tether was updated." endContent={<Button label="Reload" size="sm" onClick={() => location.reload()} />} />
    ) : link !== "open" && everOpen ? (
      <Banner status="error" container="section" collapsible={false} title={navigator.onLine ? "Reconnecting…" : "Offline · reconnecting…"} />
    ) : undefined;

  return (
    <AppShell
      variant="section"
      banner={banner}
      sideNav={<Sidebar />}
      mobileNav={{ isOpen: sidebarOpen, onOpenChange: (open) => useStore.setState({ sidebarOpen: open }) }}
    >
      {auth === "ok" ? <Home /> : <Blocked auth={auth} />}
    </AppShell>
  );
}

function Blocked({ auth }: { auth: "signedOut" | "notOwner" }) {
  return (
    <EmptyState
      icon={<Icon icon={LockClosedIcon} size="lg" />}
      title={auth === "signedOut" ? "Sign in to use Tether" : "This Tether belongs to someone else"}
      description={auth === "signedOut" ? "Your Foliation session has ended. Reload to sign in again." : "Only the app's owners can use it, because it runs commands on their machines."}
      actions={auth === "signedOut" ? <Button label="Reload" variant="primary" onClick={() => location.reload()} /> : undefined}
    />
  );
}
