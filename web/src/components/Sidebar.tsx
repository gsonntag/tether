import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { HomeIcon, LinkIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import { useStore } from "../store";
import { RunnerDot } from "./RunnerStatus";
import { useNow } from "./useNow";

export function Sidebar() {
  const runners = useStore((s) => s.runners);
  const user = useStore((s) => s.user);
  const now = useNow();
  const close = () => useStore.setState({ sidebarOpen: false });

  return (
    <SideNav
      header={<SideNavHeading heading="Tether" icon={<NavIcon icon={<Icon icon={LinkIcon} size="sm" />} />} />}
      footer={
        user && (
          <SideNavSection title="Account" isHeaderHidden>
            <SideNavItem label={user.name || user.email} icon={UserCircleIcon} />
          </SideNavSection>
        )
      }
    >
      <SideNavSection title="Menu" isHeaderHidden>
        <SideNavItem label="Home" icon={HomeIcon} isSelected onClick={close} />
      </SideNavSection>
      {runners.length > 0 && (
        <SideNavSection title="Runners">
          {runners.map((r) => (
            <SideNavItem key={r.id} label={r.id} onClick={close} endContent={<RunnerDot runner={r} now={now} />} />
          ))}
        </SideNavSection>
      )}
    </SideNav>
  );
}
