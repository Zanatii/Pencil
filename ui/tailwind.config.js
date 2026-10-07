/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Both lightened slightly from the original #0B0E1A / #12172B —
        // same dark-navy hierarchy (void still the darkest anchor, abyss
        // still the lighter surface tone used for cards/inputs), just a
        // less crushed-black starting point overall.
        void: '#0F1420',
        abyss: '#1A2036',
        indigo: '#7C6FF2',
        teal: '#3FE0C5',
        amber: '#F2A93F',
        // Destructive-action accent — a warm terracotta rather than a raw
        // Tailwind red, so it sits in the same named-palette family as
        // indigo/teal/amber instead of being the one color in the app
        // that's just an off-the-shelf scale value.
        clay: '#C2542E',
        glass: 'rgba(255,255,255,0.05)',
      },
      fontFamily: {
        display: ["'Space Grotesk'", 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        mono: ["'IBM Plex Mono'", 'monospace'],
      },
      backgroundImage: {
        // Two layers: a faint teal wash tucked into the opposite corner
        // from the main gradient's origin (barely-there — 6% opacity,
        // fading out by 45% radius) so the page doesn't read as flat
        // dark-navy-on-black, sitting on top of the main radial gradient,
        // which now fades out over the full 100% radius instead of
        // finishing at 60% — a slower falloff reads as soft ambient
        // light rather than a hard vignette/spotlight edge.
        'void-gradient':
          'radial-gradient(circle at 85% 90%, rgba(63,224,197,0.06) 0%, rgba(63,224,197,0) 45%), radial-gradient(circle at 20% 0%, #1A2036 0%, #0F1420 100%)',
      },
      keyframes: {
        'merge-glow': {
          '0%': {
            boxShadow: '0 0 0 0 rgba(124,111,242,0.9)',
            backgroundColor: 'rgba(124,111,242,0.28)',
          },
          '100%': {
            boxShadow: '0 0 0 16px rgba(124,111,242,0)',
            backgroundColor: 'rgba(124,111,242,0)',
          },
        },
      },
      animation: {
        'merge-glow': 'merge-glow 1.8s ease-out',
      },
    },
  },
}
