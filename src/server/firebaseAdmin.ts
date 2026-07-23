import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import firebaseConfig from "../../firebase-applet-config.json";

// FIREBASE_SERVICE_ACCOUNT_KEY holds the full service-account JSON (Firebase console →
// Project settings → Service accounts → Generate new private key), as a single-line env var.
// Falls back to Application Default Credentials (e.g. GOOGLE_APPLICATION_CREDENTIALS) if unset.
let app: App;
const apps = getApps();
if (apps.length) {
  app = apps[0];
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  app = initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)),
    projectId: firebaseConfig.projectId,
  });
} else {
  app = initializeApp({ projectId: firebaseConfig.projectId });
}

const adminAuth = getAuth(app);

export class AuthTokenError extends Error {}

/** Verifies a Firebase ID token and returns the caller's uid. Throws AuthTokenError on any failure. */
export async function verifyIdToken(authorizationHeader: string | undefined): Promise<string> {
  const token = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice(7) : undefined;
  if (!token) throw new AuthTokenError("Missing bearer token");
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return decoded.uid;
  } catch (err: any) {
    throw new AuthTokenError(err?.message ?? "Invalid token");
  }
}
