/**
 * Local re-export of the repo's `cn` (clsx + tailwind-merge).
 *
 * The terminal imports it as `../lib/utils` rather than reaching into the legacy
 * `src/lib/utils`, so that the whole TALA tree resolves inside itself. Re-exporting
 * (rather than re-implementing) keeps class-merge behaviour identical to every
 * other component in the app — a divergent merge would produce different padding
 * for the same class string depending on which tree rendered it.
 */
export { cn } from '../../lib/utils';
