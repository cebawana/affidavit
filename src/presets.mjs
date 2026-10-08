// Dev-server quirks, per framework. A preset never changes what is judged —
// it only removes noise the framework adds in development.
//
//   hide          CSS selectors hidden in every screenshot (dev-only badges that
//                 sit over the app and read as overlapping text).
//   notFoundText  Text of the dev server's transient 404 page. `open` retries
//                 while it shows, because some dev servers answer 404 for a few
//                 seconds while they recompile. The retry is always reported.
//   port          The dev server's default port, used by `init` for `baseUrl`.
//                 A port stated in the project itself wins over this.

export const PRESETS = {
  none: { hide: [], notFoundText: null, port: 3000 },
  next: { hide: ['nextjs-portal'], notFoundText: 'This page could not be found', port: 3000 },
  vite: { hide: [], notFoundText: null, port: 5173 },
}
