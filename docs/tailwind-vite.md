# Tailwind CSS 3 + Vite 5 Reference

> **Pinned versions: Tailwind 3.4.x, Vite 5.4.x.** Do NOT upgrade.
> - Tailwind 4 is a full rewrite: CSS-first config, no `tailwind.config.js`, new utility syntax.
> - Vite 6/7 drops Node 18, changes SSR/env APIs, removes `splitVendorChunkPlugin`.

## Tailwind Setup
- Config: `tailwind.config.js` (JS-based, Tailwind v3 style)
- PostCSS: `postcss.config.js` with `tailwindcss` and `autoprefixer`
- Entry: `@tailwind base; @tailwind components; @tailwind utilities;` in CSS

## Vite Setup
- Config: `vite.config.ts` with `@vitejs/plugin-react`
- Dev server: `npm run dev` (frontend-only with mock backend)
- Build: `tsc && vite build`
- Full-stack: `cargo tauri dev` (Tauri wraps Vite dev server)

## Key Files
- `vite.config.ts` — Vite configuration
- `tailwind.config.js` — Tailwind theme, plugins, content paths
- `postcss.config.js` — PostCSS plugin chain
- `tsconfig.json` — TypeScript configuration

## Scripts
| Command | Purpose |
|---------|---------|
| `npm run dev` | Frontend-only dev (mock backend) |
| `npm run build` | Production frontend build |
| `cargo tauri dev` | Full-stack dev (Rust + frontend) |
| `cargo tauri build` | Production desktop build |
