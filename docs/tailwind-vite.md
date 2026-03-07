# Tailwind CSS 4 + Vite 7 Reference

## Tailwind 4 Setup (CSS-first)
- No `tailwind.config.js` — theme is defined in CSS via `@theme` block
- No PostCSS plugin — uses `@tailwindcss/vite` Vite plugin
- Entry: `@import "tailwindcss"` in `src/styles/globals.css`
- Custom colors: `--color-aura-*` CSS variables in `@theme`
- Custom fonts: `--font-sans`, `--font-mono` in `@theme`

### Theme Variables
```css
@import "tailwindcss";

@theme {
  --color-aura-bg: #0d0d0d;
  --color-aura-accent: #6366f1;
  --font-sans: "Inter", -apple-system, sans-serif;
  /* ... */
}
```

### @apply Restrictions
In Tailwind 4, `@apply` only resolves Tailwind utility classes — not custom component classes.
Do NOT `@apply btn` inside `.btn-primary`. Instead, inline the shared utilities.

## Vite 7 Setup
- Config: `vite.config.ts` with `@vitejs/plugin-react` + `@tailwindcss/vite`
- Dev server: `npm run dev` (frontend-only with mock backend)
- Build: `tsc && vite build`
- Full-stack: `cargo tauri dev` (Tauri wraps Vite dev server)

## Key Files
- `vite.config.ts` — Vite configuration + Tailwind plugin
- `vitest.config.ts` — Vitest test configuration
- `src/styles/globals.css` — Tailwind theme + component styles
- `tsconfig.json` — TypeScript configuration

## Scripts
| Command | Purpose |
|---------|---------|
| `npm run dev` | Frontend-only dev (mock backend) |
| `npm run build` | Production frontend build |
| `npm test` | Run Vitest tests |
| `cargo tauri dev` | Full-stack dev (Rust + frontend) |
| `cargo tauri build` | Production desktop build |
