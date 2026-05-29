import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/lib/queryClient';

// NOTE: Google Fonts intentionally NOT used — they fail to download behind
// some VPNs/firewalls and block render. Tailwind config falls back to system
// fonts (ui-sans-serif, ui-monospace, Georgia for narration).

export const metadata: Metadata = {
  title: 'EmberForge',
  description: 'Cinematic long-form AI video generation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
