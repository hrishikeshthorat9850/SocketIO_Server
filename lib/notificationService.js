// lib/notificationService.js
import { sendPushNotification, sendPushNotificationToMultiple } from './fcmServer.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("SUPABASE_URL :",  process.env.SUPABASE_URL);
console.log("SUPABASE_SERVICE_ROLE_KEY :",  process.env.SUPABASE_SERVICE_ROLE_KEY);
/**
 * Send push notification to a user
 * @param {string} userId - User ID to send notification to
 * @param {object} notification - Notification data
 * @param {string} notification.title - Notification title
 * @param {string} notification.body - Notification body
 * @param {object} notification.data - Additional data payload
 * @param {string} notification.image - Optional image URL
 */
export async function sendNotificationToUser(userId, { title, body, data = {}, image = null }) {
  try {
    if (!userId) {
      console.warn('⚠️ No user ID provided for notification');
      return { success: false, error: 'User ID required' };
    }

    // Check if user has notifications enabled
    try {
      // Get user metadata from auth.users table using service role
      const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);
      if (!userError && userData?.user) {
        const notificationsEnabled = userData.user.user_metadata?.notifications_enabled;
        // If explicitly set to false, skip sending notification
        // Default to true if not set (backward compatibility)
        if (notificationsEnabled === false) {
          console.log(`⚠️ Notifications disabled for user ${userId}, skipping notification`);
          return { success: false, error: 'Notifications disabled by user', skipped: true };
        }
      }
    } catch (prefError) {
      // If we can't check preference, proceed with sending (default to enabled)
      // This ensures backward compatibility - if check fails, we still send notifications
      console.warn('Could not check notification preference, proceeding:', prefError.message);
    }

    // Extract link from data if provided
    const link = data.url || data.link || null;

    // Save notification to database (non-blocking)
    try {
      await supabase
        .from('notifications')
        .insert({
          user_id: userId,
          title,
          body,
          link,
          seen: false,
        });
    } catch (dbError) {
      // Log but don't fail if table doesn't exist yet
      console.warn('Could not save notification to database:', dbError.message);
    }

    // Get all FCM tokens for this user (both web and Android)
    // This sends to all devices - web and Android will both receive
    const { data: tokens, error } = await supabase
      .from('fcm_tokens')
      .select('token, device_type')
      .eq('user_id', userId);

    if (error) {
      console.error('Error fetching FCM tokens:', error);
      return { success: false, error: error.message };
    }

    if (!tokens || tokens.length === 0) {
      console.log(`⚠️ No FCM tokens found for user ${userId}`);
      return { success: false, error: 'No tokens found', sent: 0 };
    }

    const tokenList = tokens.map(t => t.token);

    // Send to all tokens (user might have multiple devices)
    // Use sendPushNotificationToMultiple for batch sending
    const result = await sendPushNotificationToMultiple({
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,
      tokens: tokenList,
      title,
      body,
      data: {
        ...data,
        userId: String(userId),
        timestamp: new Date().toISOString(),
      },
    });

    return {
      success: true,
      sent: result?.success || 0,
      failed: result?.failed || 0,
      total: tokenList.length,
    };
  } catch (error) {
    console.error('Error sending notification to user:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send notification to multiple users
 * @param {string[]} userIds - Array of user IDs
 * @param {object} notification - Notification data
 */
export async function sendNotificationToUsers(userIds, notification) {
  const results = await Promise.allSettled(
    userIds.map(userId => sendNotificationToUser(userId, notification))
  );

  const success = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  const failed = results.filter(r => r.status === 'rejected' || !r.value?.success).length;

  return { success, failed, total: userIds.length };
}

/**
 * Check if weather alert can be sent (rate limit: 3 per day)
 * @param {string} userId - User ID
 * @returns {Promise<{canSend: boolean, count: number}>}
 */
export async function canSendWeatherAlert(userId) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.toISOString();

    const { data, error } = await supabase
      .from('weather_alerts_sent')
      .select('id')
      .eq('user_id', userId)
      .gte('sent_at', todayStart);

    if (error) {
      console.error('Error checking weather alert limit:', error);
      return { canSend: true, count: 0 }; // Allow on error
    }

    const count = data?.length || 0;
    return {
      canSend: count < 3,
      count,
    };
  } catch (error) {
    console.error('Error in canSendWeatherAlert:', error);
    return { canSend: true, count: 0 };
  }
}

/**
 * Record that a weather alert was sent
 * @param {string} userId - User ID
 * @param {string} alertType - Type of alert (e.g., 'rain', 'high_temp', 'wind')
 * @param {object} weatherData - Weather data that triggered the alert
 */
export async function recordWeatherAlertSent(userId, alertType, weatherData = {}) {
  try {
    const { error } = await supabase
      .from('weather_alerts_sent')
      .insert({
        user_id: userId,
        alert_type: alertType,
        weather_data: weatherData,
        sent_at: new Date().toISOString(),
      });

    if (error) {
      console.error('Error recording weather alert:', error);
    }
  } catch (error) {
    console.error('Error in recordWeatherAlertSent:', error);
  }
}

/**
 * Send weather alert notification (with rate limiting)
 * @param {string} userId - User ID
 * @param {object} alert - Alert data
 * @param {string} alert.type - Alert type
 * @param {string} alert.title - Alert title
 * @param {string} alert.body - Alert body
 * @param {object} alert.weatherData - Weather data
 */
export async function sendWeatherAlert(userId, alert) {
  try {
    // Check rate limit
    const { canSend, count } = await canSendWeatherAlert(userId);
    
    if (!canSend) {
      console.log(`⚠️ Weather alert limit reached for user ${userId} (${count}/3 today)`);
      return {
        success: false,
        error: 'Daily limit reached',
        limitReached: true,
      };
    }

    // Send notification
    const result = await sendNotificationToUser(userId, {
      title: alert.title,
      body: alert.body,
      data: {
        type: 'weather_alert',
        alertType: alert.type,
        url: '/weather',
        ...alert.weatherData,
      },
    });

    // Record that alert was sent
    if (result.success) {
      await recordWeatherAlertSent(userId, alert.type, alert.weatherData);
    }

    return result;
  } catch (error) {
    console.error('Error sending weather alert:', error);
    return { success: false, error: error.message };
  }
}

