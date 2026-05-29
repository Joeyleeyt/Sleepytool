import { NavRail } from '@/components/layout/NavRail';

export default function LibraryPage() {
  return (
    <div className="h-screen flex">
      <NavRail />
      <div className="flex-1 grid place-items-center text-text-dim text-sm">
        Asset library — coming soon
      </div>
    </div>
  );
}
