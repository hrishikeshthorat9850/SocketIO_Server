// lib/fcmServer.js
import { GoogleAuth } from "google-auth-library";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"];

// Debug logs
console.log("🔥 FIREBASE_SERVICE_ACCOUNT_KEY exists:", !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
console.log("🔥 GOOGLE_APPLICATION_CREDENTIALS:", process.env.GOOGLE_APPLICATION_CREDENTIALS);

/**
 * Get access token using ONLY the JSON file
 */
export async function getAccessToken() {
  try {
    const credPathRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (!credPathRaw) {
      throw new Error(
        "GOOGLE_APPLICATION_CREDENTIALS missing.\n" +
          "Please set: GOOGLE_APPLICATION_CREDENTIALS=./config/firebaseconfig.json"
      );
    }

    // Resolve full path
    const credPath = path.isAbsolute(credPathRaw)
      ? credPathRaw
      : path.join(process.cwd(), credPathRaw);

    if (!fs.existsSync(credPath)) {
      throw new Error(
        `Service account JSON file not found at: ${credPath}\n` +
          `Fix: Put your firebaseconfig.json file in this location.`
      );
    }

    // GoogleAuth loads it directly
    const auth = new GoogleAuth({
      keyFilename: credPath,
      scopes: SCOPES,
    });

    const client = await auth.getClient();
    const token = await client.getAccessToken();

    if (!token.token) throw new Error("Failed to get access token");

    return token.token;
  } catch (error) {
    console.error("❌ Error getting FCM access token:", error);
    throw error;
  }
}

/**
 * Send a message to FCM v1 API
 */
export async function sendFcmMessage(projectId, payload) {
  try {
    const accessToken = await getAccessToken();

    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: payload }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`FCM API error ${res.status}: ${text}`);
    }

    return await res.json();
  } catch (error) {
    console.error("❌ Error sending FCM message:", error);
    throw error;
  }
}

/**
 * Send notification to a single device
 */
export async function sendPushNotification({
  projectId,
  token,
  title,
  body,
  data = {},
  image = null,
}) {
  if (!projectId) projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("Missing Firebase Project ID");
  if (!token) throw new Error("Missing FCM token");

  const payload = {
    token,
    notification: {
      title,
      body,
      ...(image && { image }),
    },
    data: {
      ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    },
    android: {
      priority: "high",
      notification: {
        sound: "default",
        channelId: "default",
      },
    },
    webpush: {
      notification: {
        icon: "/favicon.png",
        badge: "/favicon.png",
        requireInteraction: false,
      },
      fcmOptions: {
        link: data.url || "/",
      },
    },
  };

  return await sendFcmMessage(projectId, payload);
}

/**
 * Send to multiple tokens
 */
export async function sendPushNotificationToMultiple({
  projectId,
  tokens,
  title,
  body,
  data = {},
}) {
  if (!tokens || tokens.length === 0) {
    throw new Error("No tokens provided");
  }

  const results = await Promise.allSettled(
    tokens.map((t) =>
      sendPushNotification({ projectId, token: t, title, body, data })
    )
  );

  return {
    success: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
    results,
  };
}
