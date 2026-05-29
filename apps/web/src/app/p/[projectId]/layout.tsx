import { type ReactNode } from 'react';
import { NavRail } from '@/components/layout/NavRail';
import { TopBar } from '@/components/layout/TopBar';
import { StatusBar } from '@/components/layout/StatusBar';
import { RenderBanner } from '@/components/layout/RenderBanner';

export default function ProjectLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-screen flex">
      <NavRail />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
        <RenderBanner />
        <StatusBar />
      </div>
    </div>
  );
}
