/**
 * Local re-export of the app's tRPC React client.
 *
 * The terminal imports it as `../lib/trpc` so the whole TALA tree resolves inside
 * itself. It MUST be the same client instance the providers above it in main.tsx
 * were built from — a second `createTRPCReact` would produce a second, unhydrated
 * context consumer and every query would throw at render. Re-exporting the type
 * too is what gives the terminal end-to-end type inference from the server router.
 */
export { trpc } from '../../lib/trpc';
