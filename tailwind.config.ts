import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "var(--font-geist-sans)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "var(--font-geist-mono)",
          "SFMono-Regular",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      colors: {
        ink: "#15171c",
        graphite: "#343946",
        line: "#d9dde7",
        mist: "#f6f8fb",
        graphlit: "#5a65ae",
      },
      fontSize: {
        md: ["15px", { lineHeight: "20px" }],
      },
    },
  },
  plugins: [],
};

export default config;
