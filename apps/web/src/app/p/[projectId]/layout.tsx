import { type ReactNode } from 'react';
import { NavRail } from '@/components/layout/NavRail';
import { TopBar } from '@/components/layout/TopBar';
import { StatusBar } from '@/components/layout/StatusBar';
import { RenderBanner } from '@/components/layout/RenderBanner';
import { PhaseStepper } from '@/components/layout/PhaseStepper';
import { AutoPhaseRedirect } from '@/components/layout/AutoPhaseRedirect';
import { LabsConsoleLogger } from '@/components/layout/LabsConsoleLogger';

export default function ProjectLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-screen flex">
      <AutoPhaseRedirect />
      <LabsConsoleLogger />
      <NavRail />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <PhaseStepper />
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
        <RenderBanner />
        <StatusBar />
      </div>
    </div>
  );
}
