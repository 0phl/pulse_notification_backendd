const admin = require('firebase-admin');
const { getFirestore, getMessaging } = require('./firebase');

// Send a notification to a specific user
const sendNotificationToUser = async (userId, title, body, data = {}) => {
  try {
    const db = getFirestore();
    const messaging = getMessaging();

    // Get user's FCM tokens
    const userTokensDoc = await db.collection('user_tokens').doc(userId).get();

    if (!userTokensDoc.exists) {
      console.log(`No tokens found for user ${userId}`);
      return { success: false, error: 'No tokens found' };
    }

    const userData = userTokensDoc.data();
    const tokens = userData.tokens || [];
    const preferences = userData.notificationPreferences || {};

    // Check if user has enabled this notification type
    if (data.type && preferences[data.type] === false) {
      console.log(`User ${userId} has disabled ${data.type} notifications`);
      return { success: false, error: 'Notification type disabled by user' };
    }

    // Extract valid tokens
    const validTokens = tokens
      .filter(tokenData => tokenData.token)
      .map(tokenData => tokenData.token);

    if (validTokens.length === 0) {
      console.log(`No valid tokens found for user ${userId}`);
      return { success: false, error: 'No valid tokens found' };
    }

    // Create notification message
    const message = {
      notification: {
        title,
        body,
      },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      tokens: validTokens,
      android: {
        priority: 'high',
        notification: {
          channelId: 'high_importance_channel',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    // Send the notification
    const response = await messaging.sendMulticast(message);

    console.log(`Notification sent to ${userId}: ${response.successCount} successful, ${response.failureCount} failed`);

    // Store the notification in Firestore
    await db.collection('notifications').add({
      userId,
      title,
      body,
      type: data.type || 'general',
      data,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Handle failed tokens
    if (response.failureCount > 0) {
      const failedTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(tokens[idx].token);
        }
      });

      // Remove failed tokens
      if (failedTokens.length > 0) {
        const updatedTokens = tokens.filter(tokenData => !failedTokens.includes(tokenData.token));

        await db.collection('user_tokens').doc(userId).update({
          tokens: updatedTokens,
        });

        console.log(`Removed ${failedTokens.length} invalid tokens for user ${userId}`);
      }
    }

    return {
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount
    };
  } catch (error) {
    console.error('Error sending notification:', error);
    return { success: false, error: error.message };
  }
};

// Send a notification to all users in a community
const sendNotificationToCommunity = async (communityId, title, body, data = {}, excludeUserId = null) => {
  try {
    const db = getFirestore();

    // Get all users in the community
    const usersSnapshot = await db.collection('users')
      .where('communityId', '==', communityId)
      .get();

    if (usersSnapshot.empty) {
      console.log(`No users found in community ${communityId}`);
      return { success: false, error: 'No users found in community' };
    }

    // Send notification to each user
    const promises = usersSnapshot.docs
      .filter(doc => !excludeUserId || doc.id !== excludeUserId) // Exclude specific user if provided
      .map(doc => {
        const userId = doc.id;
        return sendNotificationToUser(userId, title, body, data);
      });

    const results = await Promise.all(promises);

    console.log(`Notification sent to ${results.length} users in community ${communityId}`);

    return {
      success: true,
      sentCount: results.length,
      results
    };
  } catch (error) {
    console.error('Error sending community notification:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendNotificationToUser,
  sendNotificationToCommunity
};
