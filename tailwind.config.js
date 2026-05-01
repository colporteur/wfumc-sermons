/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        serif: ['Georgia', 'serif'],
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      colors: {
        // Same UMC maroon palette as the bulletin app, for visual continuity
        umc: {
          50: '#fdf3f3',
          100: '#fce5e5',
          200: '#f7c1c1',
          300: '#f08e8e',
          400: '#e35454',
          500: '#cb2c2c',
          600: '#a82222',
          700: '#7e1c1c',
          800: '#681c1c',
          900: '#5b1a1a',
        },
      },
    },
  },
  plugins: [],
};
