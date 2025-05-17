/**
 * Notification Delivery Diagnostic Tool
 * 
 * This script helps diagnose issues with push notification delivery.
 * It checks:
 * 1. Firebase configuration
 * 2. User token registration
 * 3. Notification delivery
 * 4. Notification payload structure
 */

const admin = require('firebase-admin');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin SDK
let app;
try {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './service-account-key.json';
  const serviceAccount = require(path.resolve(serviceAccountPath));
  
  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://pulse-app-ea5be-default-rtdb.asia-southeast1.firebasedatabase.app'
  }, 'diagnostic-app');
  
  console.log('✅ Firebase initialized successfully for diagnostics');
} catch (error) {
  console.error('❌ Failed to initialize Firebase:', error);
  process.exit(1);
}

const db = admin.firestore(app);
const messaging = admin.messaging(app);

/**
 * Diagnose notification issues for a specific user
 * @param {string} userId The user ID to diagnose
 */
async function diagnoseUserNotifications(userId) {
  console.log(`\n🔍 Diagnosing notification issues for user: ${userId}`);
  
  // Check if user exists
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    console.log(`⚠️ User document does not exist in Firestore. This might be normal depending on your data structure.`);
  } else {
    console.log(`✅ User document exists in Firestore`);
  }
  
  // Check user tokens
  console.log(`\n📱 Checking FCM tokens for user: ${userId}`);
  const userTokensDoc = await db.collection('user_tokens').doc(userId).get();
  
  if (!userTokensDoc.exists) {
    console.error(`❌ No tokens document found for user ${userId}`);
    console.log(`   Potential Issues:`);
    console.log(`   1. The app never registered FCM token with the backend`);
    console.log(`   2. Token registration endpoint failed`);
    console.log(`   3. User ID mismatch between app and backend`);
    console.log(`\n   Recommendations:`);
    console.log(`   - Verify FCM token registration in the app`);
    console.log(`   - Check logs for token registration failures`);
    console.log(`   - Verify user ID consistency`);
    return;
  }
  
  const userData = userTokensDoc.data();
  const tokens = userData.tokens || [];
  console.log(`✅ Found tokens document with ${tokens.length} tokens`);
  
  if (tokens.length === 0) {
    console.error(`❌ No tokens found in user document`);
    return;
  }
  
  // Analyze tokens
  console.log(`\n🔑 Analyzing token validity:`);
  for (const [index, tokenData] of tokens.entries()) {
    console.log(`\nToken #${index + 1}:`);
    console.log(`  Platform: ${tokenData.platform || 'unknown'}`);
    console.log(`  Token: ${tokenData.token ? tokenData.token.substring(0, 15) + '...' : 'invalid'}`);
    console.log(`  Created: ${tokenData.createdAt ? tokenData.createdAt.toDate().toLocaleString() : 'unknown'}`);
    console.log(`  Last Active: ${tokenData.lastActive ? tokenData.lastActive.toDate().toLocaleString() : 'unknown'}`);
    
    // Test token validity by sending a silent notification
    try {
      console.log(`  Testing token validity...`);
      await messaging.send({
        token: tokenData.token,
        data: {
          type: 'diagnostic',
          timestamp: Date.now().toString()
        },
        android: {
          priority: 'high',
          ttl: 60 * 1000,
          directBootOk: true
        }
      }, true); // dryRun = true, won't actually send notification
      
      console.log(`  ✅ Token appears valid`);
    } catch (error) {
      console.error(`  ❌ Token validation failed:`, error.message);
    }
  }
  
  // Check notification preferences
  console.log(`\n⚙️ Notification Preferences:`);
  const preferences = userData.notificationPreferences || {};
  if (Object.keys(preferences).length === 0) {
    console.log(`  No preferences set, will use defaults (all notifications enabled)`);
  } else {
    for (const [type, enabled] of Object.entries(preferences)) {
      console.log(`  ${type}: ${enabled ? '✅ Enabled' : '❌ Disabled'}`);
    }
  }
  
  // Check recent notifications
  console.log(`\n📬 Recent Notifications:`);
  const notificationQuery = await db.collection('notification_status')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();
  
  if (notificationQuery.empty) {
    console.log(`  No recent notifications found`);
  } else {
    for (const doc of notificationQuery.docs) {
      const statusData = doc.data();
      console.log(`\n  Notification Status ID: ${doc.id}`);
      console.log(`  Read: ${statusData.read ? '✓' : '✗'}`);
      console.log(`  Created: ${statusData.createdAt ? statusData.createdAt.toDate().toLocaleString() : 'unknown'}`);
      
      if (statusData.notificationId) {
        try {
          const notificationDoc = await db.collection('user_notifications').doc(statusData.notificationId).get();
          if (notificationDoc.exists) {
            const notificationData = notificationDoc.data();
            console.log(`  Content: "${notificationData.title}" - "${notificationData.body}"`);
            console.log(`  Type: ${notificationData.type || 'general'}`);
          } else {
            console.log(`  ⚠️ Referenced notification ${statusData.notificationId} not found`);
          }
        } catch (e) {
          console.error(`  Error fetching notification: ${e.message}`);
        }
      }
    }
  }
  
  // Summary
  console.log(`\n📋 Notification System Summary:`);
  console.log(`  User ID: ${userId}`);
  console.log(`  Tokens: ${tokens.length} registered`);
  console.log(`  Recent Notifications: ${notificationQuery.size}`);
  
  console.log(`\n🔍 Potential Issues & Solutions:`);
  console.log(`  1. Token Registration:`);
  console.log(`     - Ensure FCM token is being properly registered from the Flutter app`);
  console.log(`     - Check for token refresh handling in the app`);
  
  console.log(`  2. Notification Delivery:`);
  console.log(`     - Verify notification channel setup in Android app`);
  console.log(`     - Check notification permission status in the app`);
  console.log(`     - Look for any power-saving or battery optimization settings that might block notifications`);
  
  console.log(`  3. Flutter App Implementation:`);
  console.log(`     - Verify foreground notification handling is implemented`);
  console.log(`     - Check background notification handling is correctly setup`);
  console.log(`     - Ensure notification payload is properly processed`);
  
  console.log(`\n✅ Diagnostic complete`);
}

// Main function
async function main() {
  const userId = process.argv[2];
  
  if (!userId) {
    console.error('\n❌ Please provide a user ID');
    console.log('Usage: node scripts/diagnose-notification-issues.js USER_ID');
    process.exit(1);
  }
  
  console.log('🔍 Starting Notification Diagnostic Tool');
  
  try {
    await diagnoseUserNotifications(userId);
  } catch (error) {
    console.error('❌ Error during diagnosis:', error);
  } finally {
    // Clean up
    console.log('\nCleaning up...');
    await app.delete();
    console.log('Done.');
  }
}

// Run the main function
main(); 