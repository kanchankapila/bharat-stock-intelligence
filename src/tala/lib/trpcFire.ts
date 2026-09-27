/**
 * Thin auth facade for the TALA terminal.
 *
 * The tRPC client reads the ID token from the SAME `auth` instance on every request
 * (see src/main.tsx), so the only thing this adds is the sign-in / sign-out actions
 * the Book page needs, in one place. Deliberately not a second Firebase
 * initialisation — a second `getAuth()` could return a different instance and
 * would silently drop the bearer token from every protected procedure call.
 */
export { auth } from '../../lib/firebase';

export { authActions } from './authActions';

