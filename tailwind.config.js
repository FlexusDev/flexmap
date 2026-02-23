/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        aura: {
          bg: "#0d0d0d",
          surface: "#1a1a1a",
          border: "#2a2a2a",
          hover: "#333333",
          accent: "#6366f1",
          "accent-hover": "#818cf8",
          text: "#e5e5e5",
          "text-dim": "#737373",
          success: "#22c55e",
          warning: "#f59e0b",
          error: "#ef4444",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "SF Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
