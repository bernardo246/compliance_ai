import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: '#050505',
        bgSecondary: '#0B0B0B',
        card: '#141414',
        borderSoft: '#252525',
        textPrimary: '#FFFFFF',
        textSecondary: '#BDBDBD',
        brand: '#3ECF8E',
        brandHover: '#2EB67D',
        brandGlow: '#6EE7B7',
      },
      boxShadow: {
        glow: '0 0 40px rgba(110, 231, 183, 0.25)',
      },
      animation: {
        float: 'float 6s ease-in-out infinite',
        glowPulse: 'glowPulse 2.5s ease-in-out infinite',
        gradientShift: 'gradientShift 8s ease infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 30px rgba(110, 231, 183, 0.2)' },
          '50%': { boxShadow: '0 0 55px rgba(110, 231, 183, 0.35)' },
        },
        gradientShift: {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
