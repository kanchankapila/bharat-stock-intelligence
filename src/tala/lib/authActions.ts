import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { auth } from './trpcFire';

/** Sign-in / sign-out actions for the Book page. Kept in their own module so the
 *  auth instance re-export has no Firebase action imports pulled into it. */
export const authActions = {
  signInWithGoogle: () => signInWithPopup(auth, new GoogleAuthProvider()),
  signOut: () => signOut(auth),
};
