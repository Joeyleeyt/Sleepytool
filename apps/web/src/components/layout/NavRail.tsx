'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
// Library, Palette, Settings, HelpCircle kept out until their nav items are restored.
import { Home, ListChecks, KeyRound, CircleUser, Flame, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Item {
  href: string;
  // Loose enough to accept lucide-react's forwardRef icon components whose
  // `size` prop accepts string | number.
  icon: React.ElementType;
  label: string;
}

const TOP: Item[] = [
  { href: '/', icon: Home, label: 'Projects' },
  // Hidden until ready — restore when the feature ships:
  // { href: '/library', icon: Library, label: 'Library' },
  { href: '/queue', icon: ListChecks, label: 'Render Queue' },
  // { href: '/style-presets', icon: Palette, label: 'Presets' },
  { href: '/keys', icon: KeyRound, label: 'API Keys' },
];
const BOTTOM: Item[] = [
  // Hidden until ready — restore when the feature ships:
  // { href: '/settings', icon: Settings, label: 'Settings' },
  // { href: '/help', icon: HelpCircle, label: 'Help' },
  { href: '/account', icon: CircleUser, label: 'Account' },
];

export function NavRail() {
  const path = usePathname();
  return (
    <nav className="flex flex-col items-center w-14 shrink-0 border-r border-border bg-bg-subtle">
      <Link href="/" className="h-14 grid place-items-center text-ember-500">
        <Flame size={22} />
      </Link>
      <div className="flex flex-col gap-1 mt-2 flex-1">
        {TOP.map((it) => (
          <NavItem key={it.href} item={it} active={isActive(path, it.href)} />
        ))}
      </div>
      <div className="flex flex-col gap-1 mb-3">
        {BOTTOM.map((it) => (
          <NavItem key={it.href} item={it} active={isActive(path, it.href)} />
        ))}
        <LogoutButton />
      </div>
    </nav>
  );
}

function LogoutButton() {
  async function logout() {
    await fetch('/api/login', { method: 'DELETE' }).catch(() => {});
    // Full navigation so the cleared cookie takes effect and middleware bounces
    // us to /login.
    window.location.assign('/login');
  }
  return (
    <button
      type="button"
      onClick={logout}
      title="Log out"
      className="w-10 h-10 grid place-items-center rounded-md text-text-dim hover:text-text hover:bg-bg-elev transition-colors"
    >
      <LogOut size={18} />
    </button>
  );
}

function NavItem({ item, active }: { item: Item; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={item.label}
      className={cn(
        'w-10 h-10 grid place-items-center rounded-md text-text-dim hover:text-text hover:bg-bg-elev transition-colors',
        active && 'bg-bg-elev text-text shadow-[inset_2px_0_0_0_#FB923C]',
      )}
    >
      <Icon size={18} />
    </Link>
  );
}

function isActive(path: string, href: string) {
  if (href === '/') return path === '/';
  return path.startsWith(href);
}
