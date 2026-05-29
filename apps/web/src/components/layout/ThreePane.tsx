import { type ReactNode } from 'react';

export function ThreePane({
  children,
  inspector,
}: {
  children: ReactNode;
  inspector?: ReactNode;
}) {
  return (
    <div className="flex-1 min-h-0 grid grid-cols-[1fr_320px]">
      <main className="min-h-0 overflow-hidden">{children}</main>
      <aside className="border-l border-border bg-bg-subtle min-h-0 overflow-y-auto">
        {inspector}
      </aside>
    </div>
  );
}
