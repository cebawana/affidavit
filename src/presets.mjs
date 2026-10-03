// Dev-server quirks, per framework. A preset never changes what is judged —
// it only removes noise the framework adds in development.
//
//   hide          CSS selectors hidden in every screenshot (dev-only badges that
//                 sit over the app and read as overlapping text).
//   notFoundText  Text of the dev server's transient 404 page. `open` retries
//                 while it shows, because some dev servers answer 404 for a few
//                 seconds while they recompile. The retry is always reported.

export const PRESETS = {
  none: { hide: [], notFoundText: null },
  next: { hide: ['nextjs-portal'], notFoundText: 'This page could not be found' },
  vite: { hide: [], notFoundText: null },
}
