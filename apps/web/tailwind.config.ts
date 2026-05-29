import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: '#0B0B0F', elev: '#15151B', subtle: '#0F0F14' },
        border: { DEFAULT: '#27272F', strong: '#3A3A45', ember: '#FB923C' },
        text: { DEFAULT: '#EDEDED', dim: '#9CA3AF', faint: '#6B7280' },
        ember: { 50: '#FFF7ED', 400: '#FB923C', 500: '#F97316', 600: '#EA580C' },
        ok: { DEFAULT: '#34D399' },
        warn: { DEFAULT: '#FBBF24' },
        bad: { DEFAULT: '#F87171' },
        busy: { DEFAULT: '#C4B5FD' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Inter Display"', 'Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        narration: ['"Newsreader"', 'Georgia', 'serif'],
      },
      borderRadius: { card: '10px' },
      boxShadow: {
        ember: '0 0 0 1px rgba(251,146,60,0.4), 0 8px 30px -10px rgba(251,146,60,0.3)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        shimmer: 'shimmer 2.5s linear infinite',
      },
    },
  },
  plugins: [],
};
export default config;
