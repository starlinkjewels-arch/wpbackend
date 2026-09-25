import admin from "firebase-admin";
import { readFileSync } from "node:fs";

// The WhatsApp service has its own named database, "wpserver", in the same
// Firebase project as the billing app but apart from the billing app's own
// database — the session, clients and campaigns never share a collection
// with invoices. Nothing here reads the billing data, so the two need not match.
//
// One codebase serves more than one shop, and each shop is a different named
// database in a different Firebase project, so this cannot be a constant that
// only a redeploy can change. Set FIRESTORE_DATABASE_ID on the host.
export const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "wpserver";

let dbInstance = null;
let serviceAccountProjectId = null;

/** Which Firebase project the configured key actually belongs to. Null until
 *  the key has been parsed — i.e. until the first getDb(). */
export function getProjectId() {
  return serviceAccountProjectId;
}

export function getDb() {
  if (dbInstance) return dbInstance;

  if (!admin.apps.length) {
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    // Locally it is easier to point at the downloaded key file than to paste
    // it onto one line. Hosts should keep using the variable above.
    if (!raw && process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      try {
        raw = readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8");
      } catch (err) {
        throw new Error(
          `FIREBASE_SERVICE_ACCOUNT_PATH points at a file that cannot be read (${err.message})`,
        );
      }
    }
    if (!raw) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_KEY is not set — add the Firebase Admin SDK service account " +
        "JSON as an environment variable (see .env.example) before the WhatsApp session store can work.",
      );
    }
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_KEY is set but is not valid JSON — paste the whole service " +
          `account file as one line, quotes and all (${err.message})`,
      );
    }
    serviceAccountProjectId = serviceAccount.project_id ?? null;
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }

  dbInstance = admin.firestore();
  dbInstance.settings({ databaseId: DATABASE_ID });
  return dbInstance;
}
