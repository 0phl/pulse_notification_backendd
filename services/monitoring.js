const admin = require('firebase-admin');
const { getDatabase, getFirestore } = require('./firebase');

// Monitor for new community notices
const monitorCommunityNotices = () => {
  const db = getDatabase();
  const firestore = getFirestore();
  const noticesRef = db.ref('/community_notices');

  console.log('Starting monitoring for new community notices...');

  // Listen for new notices
  noticesRef.on('child_added', async (snapshot) => {
    try {
      const noticeData = snapshot.val();
      const noticeId = snapshot.key;

      if (!noticeData || !noticeData.communityId) {
        console.log('Invalid notice data');
        return;
      }

      // IMPROVED: Extended time window for processing notices
      // Check if notice was created recently (within the last 2 minutes)
      // Increased from 30 seconds to 2 minutes to ensure we don't miss notices
      const now = Date.now();
      const createdAt = noticeData.createdAt || 0;

      // Only skip notices that are extremely old (> 1 hour)
      if (now - createdAt > 60 * 60 * 1000) {
        // Skip notices older than 1 hour
        console.log(`Skipping notice ${noticeId} - too old (${Math.floor((now - createdAt)/1000)} seconds)`);
        return;
      }

      // For notices between 2 minutes and 1 hour old, log but still process them
      if (now - createdAt > 2 * 60 * 1000) {
        console.log(`Notice ${noticeId} is older than expected (${Math.floor((now - createdAt)/1000)} seconds), but still processing`);
      } else {
        console.log(`New community notice detected: ${noticeId}`);
      }

      // Enhanced logging for better debugging
      console.log(`[NOTICE DEBUG] Notice created by user: ${noticeData.authorId || 'unknown'}`);
      console.log(`[NOTICE DEBUG] Notice title: "${noticeData.title || 'No title'}"`);
      console.log(`[NOTICE DEBUG] Notice community: ${noticeData.communityId}`);
      console.log(`[NOTICE DEBUG] Notice created at: ${new Date(createdAt).toISOString()}`);

      // Check if author is admin and store the status
      let authorIsAdmin = false;
      if (noticeData.authorId) {
        try {
          const authorDocRef = await firestore.collection('users').doc(noticeData.authorId).get();
          if (authorDocRef.exists) {
            const authorData = authorDocRef.data();
            authorIsAdmin = authorData.isAdmin === true || authorData.role === 'admin';
            if (authorIsAdmin) {
              console.log(`[NOTICE DEBUG] Notice author ${noticeData.authorId} is an admin`);
            }
          }
        } catch (error) {
          console.error(`[NOTICE ERROR] Failed to check author admin status: ${error.message}`);
        }
      }

      // Check if notification for this notice already exists in Firestore
      // to prevent duplicate notifications
      const existingNotifications = await firestore
        .collection('community_notifications')
        .where('data.noticeId', '==', noticeId)
        .limit(1)
        .get();

      if (!existingNotifications.empty) {
        console.log(`Notification for notice ${noticeId} already exists, skipping`);
        return;
      }

      // Send notification to all users in the community except the author
      const { sendNotificationToCommunity } = require('./notifications');

      // Make sure to pass the authorId to exclude from notifications
      if (!noticeData.authorId) {
        console.log(`[NOTICE WARNING] No author ID found for notice ${noticeId}. Notifications might be sent to the author.`);
      }

      // IMPROVED: Add retry logic for failed notification attempts
      let retryCount = 0;
      const maxRetries = 3;
      let notificationResult;

      while (retryCount < maxRetries) {
        try {
          notificationResult = await sendNotificationToCommunity(
            noticeData.communityId,
            'Community Notice',
            `${noticeData.authorName || 'Administrator'} posted new community notice: "${noticeData.title || 'Community Announcement'}"\n\n${noticeData.content?.substring(0, 100) || 'No additional details provided.'}${noticeData.content?.length > 100 ? '...' : ''}`,
            {
              type: 'communityNotices',
              noticeId,
              communityId: noticeData.communityId,
              authorId: noticeData.authorId, // Include authorId in data for additional filtering
              authorIsAdmin: authorIsAdmin ? 'true' : 'false', // Add admin status flag
            },
            noticeData.authorId // Exclude the author
          );

          // If successful or partially successful, break out of retry loop
          if (notificationResult.success || notificationResult.sentCount > 0) {
            break;
          }

          retryCount++;
          console.log(`[NOTICE RETRY] Attempt ${retryCount}/${maxRetries} failed, retrying in 3 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds before retry
        } catch (retryError) {
          console.error(`[NOTICE ERROR] Retry ${retryCount + 1} failed with error:`, retryError);
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds before retry
        }
      }

      // Log outcome of notification attempt after retries
      if (retryCount === maxRetries) {
        console.error(`[NOTICE ERROR] Failed to send notification for notice ${noticeId} after ${maxRetries} attempts`);
        // Record the failure for later analysis
        await firestore.collection('failed_notifications').add({
          noticeId,
          communityId: noticeData.communityId,
          authorId: noticeData.authorId,
          title: noticeData.title,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          error: 'Maximum retry attempts reached',
          noticeTimestamp: createdAt
        });
      } else if (notificationResult && notificationResult.sentCount > 0) {
        console.log(`[NOTICE SUCCESS] Notification sent for notice ${noticeId} to ${notificationResult.sentCount} users after ${retryCount} retries`);
      }

    } catch (error) {
      console.error('Error processing new community notice:', error);
      // Record the error for debugging
      try {
        const firestore = getFirestore();
        await firestore.collection('notification_errors').add({
          type: 'communityNotice',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          error: error.message,
          stack: error.stack
        });
      } catch (logError) {
        console.error('Failed to log error:', logError);
      }
    }
  });
};

// Monitor for new comments on community notices
const monitorCommunityNoticeComments = () => {
  const db = getDatabase();

  console.log('Starting monitoring for new comments on community notices...');

  // Listen for new comments
  db.ref('/community_notices').on('child_changed', async (snapshot) => {
    try {
      const noticeData = snapshot.val();
      const noticeId = snapshot.key;

      if (!noticeData || !noticeData.comments) {
        return;
      }

      // Get the latest comment
      const commentsArray = Object.entries(noticeData.comments || {}).map(([id, data]) => ({
        id,
        ...data,
        createdAt: data.createdAt || 0
      }));

      // Sort by createdAt (newest first)
      commentsArray.sort((a, b) => b.createdAt - a.createdAt);

      if (commentsArray.length === 0) {
        return;
      }

      const latestComment = commentsArray[0];

      // DEBUG LOGGING: Log the entire comment object to diagnose issues
      console.log(`[COMMENT DEBUG] Latest comment on notice ${noticeId}:`, JSON.stringify(latestComment));

      // Check if the comment was just added (within the last 10 seconds)
      const now = Date.now();
      if (now - latestComment.createdAt > 10000) {
        return;
      }

      console.log(`New comment detected on notice ${noticeId}`);

      // Don't send notification if the comment author is the same as the notice author
      if (latestComment.authorId === noticeData.authorId) {
        return;
      }

      // Send notification to the notice author
      const { sendNotificationToUser } = require('./notifications');

      // Make sure text exists and is a string before using substring
      let commentText = latestComment.text || '';

      // Handle the case where text might be in a different property
      if (!commentText && latestComment.content) {
        commentText = latestComment.content;
        console.log(`[COMMENT DEBUG] Using 'content' property instead of 'text' for comment ${latestComment.id}`);
      }

      // Check if comment text is empty
      if (!commentText || commentText.trim() === '') {
        console.log(`[COMMENT DEBUG] WARNING: Empty comment text for comment ${latestComment.id}`);
        commentText = "(No comment text)";
      }

      // Ensure string type
      commentText = String(commentText);

      // Truncate long comments
      const truncatedText = `"${commentText.substring(0, 50)}${commentText.length > 50 ? '...' : ''}"`;

      console.log(`[COMMENT DEBUG] Sending notification with comment text: ${truncatedText}`);

      await sendNotificationToUser(
        noticeData.authorId,
        'New Comment on Your Notice',
        `${latestComment.authorName || 'Someone'} commented: ${truncatedText}`,
        {
          type: 'socialInteractions',
          noticeId,
          commentId: latestComment.id,
          communityId: noticeData.communityId,
          authorId: latestComment.authorId,
          commentText: commentText.substring(0, 100) // Include comment text in the data payload
        }
      );
    } catch (error) {
      console.error('Error processing new comment:', error);
    }
  });
};

// Monitor for new likes on community notices
const monitorCommunityNoticeLikes = () => {
  const db = getDatabase();
  const firestore = getFirestore();

  console.log('Starting monitoring for new likes on community notices...');

  // Listen for changes to notices (likes are added as properties)
  db.ref('/community_notices').on('child_changed', async (snapshot) => {
    try {
      const noticeData = snapshot.val();
      const noticeId = snapshot.key;

      if (!noticeData || !noticeData.likes) {
        return;
      }

      // Get all likes
      const likes = noticeData.likes || {};

      // Find likes added in the last 10 seconds
      const now = Date.now();
      const recentLikes = Object.entries(likes)
        .filter(([_, likeData]) => {
          const createdAt = likeData.createdAt || 0;
          return (now - createdAt) < 10000; // 10 seconds
        })
        .map(([userId, _]) => userId);

      if (recentLikes.length === 0) {
        return;
      }

      console.log(`[NOTICE_LIKE DEBUG] Recent likes detected on notice ${noticeId}: ${recentLikes.join(', ')}`);
      console.log(`[NOTICE_LIKE DEBUG] Notice author: ${noticeData.authorId || 'unknown'}`);

      // Check if any of the likers or the author is an admin (for debugging)
      // Define authorIsAdmin and likerIsAdmin variables at a wider scope
      let authorIsAdmin = false;
      let likerIsAdmin = false;

      try {
        const authorDocRef = await firestore.collection('users').doc(noticeData.authorId).get();
        authorIsAdmin = authorDocRef.exists && (authorDocRef.data().isAdmin || authorDocRef.data().role === 'admin');

        if (authorIsAdmin) {
          console.log(`[NOTICE_LIKE DEBUG] Notice author ${noticeData.authorId} is an admin`);
        }

        // We'll set likerIsAdmin for the current liker inside the loop below
      } catch (error) {
        console.error(`[NOTICE_LIKE ERROR] Error checking author admin status: ${error.message}`);
      }

      // Process each recent like
      for (const likerId of recentLikes) {
        // Double check to avoid self-notifications
        // Don't send notification if the liker is the same as the notice author
        if (likerId === noticeData.authorId) {
          console.log(`[NOTICE_LIKE DEBUG] Skipping notification as user ${likerId} liked their own notice`);
          continue;
        }

        console.log(`New like detected on notice ${noticeId} by user ${likerId}`);

        // Check if this specific liker is an admin
        try {
          const likerDocRef = await firestore.collection('users').doc(likerId).get();
          likerIsAdmin = likerDocRef.exists && (likerDocRef.data().isAdmin || likerDocRef.data().role === 'admin');

          if (likerIsAdmin) {
            console.log(`[NOTICE_LIKE DEBUG] Liker ${likerId} is an admin`);
          }
        } catch (error) {
          console.error(`[NOTICE_LIKE ERROR] Error checking liker admin status: ${error.message}`);
          likerIsAdmin = false; // Reset in case of error
        }

        // Get liker's name with enhanced retrieval - check multiple data sources
        let displayName = 'Someone';

        try {
          // First try Realtime Database
          const likerSnapshot = await db.ref(`/users/${likerId}`).once('value');
          const likerData = likerSnapshot.val();

          if (likerData) {
            console.log(`[NOTICE_LIKE DEBUG] Found user in RTDB: ${likerId}`);
            displayName = likerData.fullName || likerData.displayName || likerData.username || displayName;
          } else {
            console.log(`[NOTICE_LIKE DEBUG] User not found in RTDB: ${likerId}`);
          }

          // If we still don't have a name, check Firestore
          if (displayName === 'Someone') {
            const userDocRef = await firestore.collection('users').doc(likerId).get();
            if (userDocRef.exists) {
              const userData = userDocRef.data();
              console.log(`[NOTICE_LIKE DEBUG] Found user in Firestore: ${likerId}`);
              displayName = userData.fullName || userData.displayName || userData.username || displayName;
            } else {
              console.log(`[NOTICE_LIKE DEBUG] User not found in Firestore: ${likerId}`);
            }
          }

          // Final check in userProfiles collection if it exists
          if (displayName === 'Someone') {
            const profileDocRef = await firestore.collection('userProfiles').doc(likerId).get();
            if (profileDocRef.exists) {
              const profileData = profileDocRef.data();
              console.log(`[NOTICE_LIKE DEBUG] Found user in userProfiles: ${likerId}`);
              displayName = profileData.fullName || profileData.displayName || profileData.name || displayName;
            }
          }

          // If we STILL don't have a name, use first part of email or ID
          if (displayName === 'Someone') {
            // Try to get email from auth
            try {
              const userRecord = await admin.auth().getUser(likerId);
              if (userRecord && userRecord.email) {
                displayName = userRecord.email.split('@')[0]; // Use email username
                console.log(`[NOTICE_LIKE DEBUG] Using email from Auth: ${displayName}`);
              } else if (userRecord && userRecord.displayName) {
                displayName = userRecord.displayName;
                console.log(`[NOTICE_LIKE DEBUG] Using displayName from Auth: ${displayName}`);
              }
            } catch (authError) {
              console.log(`[NOTICE_LIKE DEBUG] Auth lookup failed: ${authError.message}`);
              // If everything fails, use shortened user ID instead of the full one
              displayName = likerId.substring(0, 8) + '...';
            }
          }
        } catch (error) {
          console.error(`[NOTICE_LIKE ERROR] Error retrieving user data: ${error.message}`);
          displayName = likerId.substring(0, 8) + '...'; // Shortened ID as fallback
        }

        console.log(`[NOTICE_LIKE DEBUG] Final display name for ${likerId}: ${displayName}`);

        // Prepare notice title
        const noticeTitle = noticeData.title || 'your notice';

        // Send notification to the notice author with admin flags
        const { sendNotificationToUser } = require('./notifications');
        await sendNotificationToUser(
          noticeData.authorId,
          'New Like on Your Notice',
          `${displayName} liked your notice: "${noticeTitle}"`,
          {
            type: 'socialInteractions',
            noticeId,
            communityId: noticeData.communityId,
            likerId: likerId,             // ID of the person who liked the post (the actor)
            noticeAuthorId: noticeData.authorId, // ID of the post author (recipient)
            noticeTitle: noticeTitle.substring(0, 30), // Include title in payload
            // Add admin flags to help with notification handling
            authorIsAdmin: authorIsAdmin ? 'true' : 'false',
            likerIsAdmin: likerIsAdmin ? 'true' : 'false',
            isUserAdmin: authorIsAdmin ? 'true' : 'false' // Mark if recipient is admin
          }
        );
      }
    } catch (error) {
      console.error('Error processing new like:', error);
    }
  });
};

// Monitor for new marketplace items
const monitorMarketplaceItems = () => {
  const firestore = getFirestore();

  console.log('Starting monitoring for new marketplace items...');

  // Listen for new marketplace items
  // Using only orderBy without where to avoid needing a composite index
  firestore.collection('market_items')
    .orderBy('createdAt', 'desc')
    .limit(10) // Limit to recent items
    .onSnapshot(async (snapshot) => {
      try {
        // Process only added documents
        const addedDocs = snapshot.docChanges()
          .filter(change => change.type === 'added')
          .map(change => ({
            id: change.doc.id,
            ...change.doc.data()
          }));

        if (addedDocs.length === 0) {
          return;
        }

        // Get current time
        const now = Date.now();
        // Only process items created in the last 5 minutes
        const recentItems = addedDocs.filter(item => {
          // Check if item has createdAt timestamp
          if (!item.createdAt) return false;

          // Convert Firestore timestamp to milliseconds
          const createdAtMs = item.createdAt.toMillis ?
            item.createdAt.toMillis() :
            (item.createdAt._seconds ? item.createdAt._seconds * 1000 : 0);

          // Check if item was created in the last 5 minutes
          return (now - createdAtMs) < 5 * 60 * 1000;
        });

        if (recentItems.length === 0) {
          return;
        }

        for (const item of recentItems) {
          console.log(`New marketplace item detected: ${item.id} with status: ${item.status}`);

          // Case 1: Item is Active or Approved -> Notify Community
          if (item.status === 'active' || item.status === 'approved') {
            console.log(`Sending community notification for active item ${item.id}`);
            // Send notification to all users in the community except the seller
            const { sendNotificationToCommunity } = require('./notifications');
            await sendNotificationToCommunity(
              item.communityId,
              'New Item in Marketplace',
              `${item.sellerName} is selling: "${item.title}" for ${item.price}`,
              {
                type: 'marketplace',
                itemId: item.id,
                communityId: item.communityId,
                sellerId: item.sellerId,
              },
              item.sellerId // Exclude the seller
            );
          } 
          // Case 2: Item is Pending -> Notify Admins
          else if (item.status === 'pending') {
            console.log(`Sending admin notification for pending item ${item.id}`);
            
            // Find admins in the community
            const communityUsers = await firestore
              .collection('users')
              .where('communityId', '==', item.communityId)
              .get();

            const admins = communityUsers.docs.filter(doc => {
              const userData = doc.data();
              return userData.isAdmin === true || userData.role === 'admin';
            });

            if (admins.length === 0) {
              console.log(`No admins found for community ${item.communityId} to notify about item ${item.id}`);
              continue;
            }

            const { sendNotificationToUser } = require('./notifications');
            
            for (const adminDoc of admins) {
              // Skip if the seller is an admin (don't notify them of their own pending item)
              if (adminDoc.id === item.sellerId) continue;

              console.log(`Sending pending item notification to admin ${adminDoc.id}`);
              await sendNotificationToUser(
                adminDoc.id,
                'New Item Pending Approval',
                `${item.sellerName} posted: "${item.title}". Review it now.`,
                {
                  type: 'marketplace',
                  itemId: item.id,
                  communityId: item.communityId,
                  sellerId: item.sellerId,
                  isForAdmin: 'true',
                  action: 'review_item'
                }
              );
            }
          }
        }
      } catch (error) {
        console.error('Error processing new marketplace items:', error);
      }
    });
};

// Monitor for new chat messages
const monitorChatMessages = () => {
  const db = getDatabase();

  // Cache to track processed message IDs to prevent duplicates
  // Key: messageId, Value: timestamp
  const processedMessageIds = new Map();
  
  // Periodic cleanup of old message IDs from cache (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    for (const [id, timestamp] of processedMessageIds.entries()) {
      // Remove messages older than 2 minutes
      if (now - timestamp > 2 * 60 * 1000) {
        processedMessageIds.delete(id);
      }
    }
  }, 5 * 60 * 1000);

  console.log('Starting monitoring for new chat messages...');

  // Listen for new messages in all chats
  db.ref('/chats').on('child_changed', async (snapshot) => {
    try {
      const chatData = snapshot.val();
      const chatId = snapshot.key;

      if (!chatData || !chatData.messages) {
        return;
      }

      // Get all messages
      const messages = chatData.messages || {};
      const messageKeys = Object.keys(messages);

      if (messageKeys.length === 0) {
        return;
      }

      // Get the latest message
      const latestMessageKey = messageKeys[messageKeys.length - 1];
      const latestMessage = messages[latestMessageKey];

      // Check for either text or message property
      const messageText = latestMessage.text || latestMessage.message;

      if (!latestMessage || !latestMessage.senderId || !messageText) {
        return;
      }
      
      // Check if we've already processed this message ID
      if (processedMessageIds.has(latestMessageKey)) {
        console.log(`[CHAT DEBUG] Skipping duplicate notification for message ${latestMessageKey}`);
        return;
      }

      // Check if the message was just added (within the last 10 seconds)
      const now = Date.now();
      if (latestMessage.timestamp && now - latestMessage.timestamp > 10000) {
        return;
      }

      console.log(`New chat message detected in chat ${chatId}`);

      // Add to processed cache immediately
      processedMessageIds.set(latestMessageKey, now);

      // Determine the recipient
      const recipientId = latestMessage.senderId === chatData.buyerId
        ? chatData.sellerId
        : chatData.buyerId;

      // Get sender's name
      const senderSnapshot = await db.ref(`/users/${latestMessage.senderId}`).once('value');
      const senderData = senderSnapshot.val();
      const senderName = senderData?.fullName || senderData?.username || 'Someone';

      // Send notification to the recipient
      const { sendNotificationToUser } = require('./notifications');
      await sendNotificationToUser(
        recipientId,
        'New Message',
        `${senderName}: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`,
        {
          type: 'chat',
          chatId,
          messageId: latestMessageKey,
          senderId: latestMessage.senderId,
          itemId: chatData.itemId,
        }
      );
    } catch (error) {
      console.error('Error processing new chat message:', error);
    }
  });
};

// Monitor for new reports
const monitorNewReports = () => {
  const firestore = getFirestore();

  // Store the server start time to filter out old reports
  const serverStartTime = Date.now();
  console.log(`[REPORT DEBUG] Server started at: ${new Date(serverStartTime).toISOString()}`);

  console.log('Starting monitoring for new reports...');

  // Listen for new reports
  firestore.collection('reports')
    .orderBy('createdAt', 'desc')
    .limit(20)
    .onSnapshot(async (snapshot) => {
      try {
        console.log('[REPORT DEBUG] Received reports snapshot');

        // Process only added documents
        const addedDocs = snapshot.docChanges()
          .filter(change => change.type === 'added')
          .map(change => ({
            id: change.doc.id,
            ...change.doc.data()
          }));

        console.log(`[REPORT DEBUG] Found ${addedDocs.length} new reports`);

        if (addedDocs.length === 0) {
          return;
        }

        // Get current time
        const now = Date.now();

        // Process reports that have valid createdAt timestamp
        const validReports = addedDocs.filter(report => {
          console.log(`[REPORT DEBUG] Processing report ${report.id}`);

          // Check required fields
          if (!report.userId) {
            console.log(`[REPORT DEBUG] Report ${report.id} missing userId`);
            return false;
          }

          if (!report.communityId) {
            console.log(`[REPORT DEBUG] Report ${report.id} missing communityId`);
            return false;
          }

          // Check if report has createdAt timestamp
          if (!report.createdAt) {
            console.log(`[REPORT DEBUG] Report ${report.id} missing createdAt timestamp`);
            return false;
          }

          // Convert Firestore timestamp to milliseconds
          const createdAtMs = report.createdAt.toMillis ?
            report.createdAt.toMillis() :
            (report.createdAt._seconds ? report.createdAt._seconds * 1000 : 0);

          // Skip reports created before server start (prevents duplicate notifications on restart)
          if (createdAtMs < serverStartTime) {
            console.log(`[REPORT DEBUG] Skipping report ${report.id} - created before server start`);
            return false;
          }

          // Only process reports created in the last 5 minutes
          if (now - createdAtMs > 5 * 60 * 1000) {
            console.log(`[REPORT DEBUG] Skipping report ${report.id} - too old (${Math.floor((now - createdAtMs)/1000)} seconds)`);
            return false;
          }

          console.log(`[REPORT DEBUG] Report ${report.id} created at: ${new Date(createdAtMs).toISOString()}`);
          console.log(`[REPORT DEBUG] Report ${report.id} passed all checks, will send notification`);
          return true;
        });

        console.log(`[REPORT DEBUG] ${validReports.length} reports passed filtering out of ${addedDocs.length} total`);

        if (validReports.length === 0) {
          return;
        }

        for (const report of validReports) {
          console.log(`[REPORT DEBUG] Preparing to send notification for report: ${report.id}`);
          console.log(`[REPORT DEBUG] Community ID: ${report.communityId}`);
          console.log(`[REPORT DEBUG] Reporter ID: ${report.userId}`);
          console.log(`[REPORT DEBUG] Issue Type: ${report.issueType}`);

          try {
            // Get all users in the community first, then filter for admins
            // This avoids the need for a composite index and matches how community notices work
            const communityUsers = await firestore
              .collection('users')
              .where('communityId', '==', report.communityId)
              .get();

            console.log(`[REPORT DEBUG] Found ${communityUsers.size} users in community ${report.communityId}`);

            if (communityUsers.empty) {
              console.log(`[REPORT DEBUG] No users found for community ${report.communityId}`);
              continue;
            }

            // Filter for admins from the community users
            const communityAdmins = communityUsers.docs.filter(doc => {
              const userData = doc.data();
              return userData.isAdmin === true || userData.role === 'admin';
            });

            console.log(`[REPORT DEBUG] Found ${communityAdmins.length} admins in community ${report.communityId}`);

            if (communityAdmins.length === 0) {
              console.log(`[REPORT DEBUG] No admins found for community ${report.communityId}`);
              continue;
            }

            // Send notification to each admin
            const { sendNotificationToUser } = require('./notifications');
            
            for (const adminDoc of communityAdmins) {
              const adminId = adminDoc.id;
              
              // Don't send notification to the reporter if they are also an admin
              if (adminId === report.userId) {
                console.log(`[REPORT DEBUG] Skipping notification to ${adminId} (reporter is admin)`);
                continue;
              }

              console.log(`[REPORT DEBUG] Sending notification to admin ${adminId}`);
              
              await sendNotificationToUser(
                adminId,
                'New Community Report',
                `A new report has been submitted: "${report.issueType}"${report.description ? ` - ${report.description.substring(0, 50)}${report.description.length > 50 ? '...' : ''}` : ''}`,
                {
                  type: 'reports',
                  reportId: report.id,
                  communityId: report.communityId,
                  userId: report.userId,
                  issueType: report.issueType,
                  priority: 'high',
                  forceAlert: 'true',
                  timestamp: Date.now()
                }
              );
            }

            console.log(`[REPORT DEBUG] Notifications sent for report ${report.id}`);
          } catch (error) {
            console.error(`[REPORT ERROR] Failed to send notification for report ${report.id}:`, error);
          }
        }
      } catch (error) {
        console.error('[REPORT ERROR] Error processing new reports:', error);
      }
    });
};

// Monitor for report status updates
const monitorReportStatusUpdates = () => {
  const firestore = getFirestore();

  // Track previous status of reports to detect changes
  const reportStatusCache = new Map();
  let isInitialized = false;

  console.log('Starting monitoring for report status updates...');

  // Listen for updates to reports
  firestore.collection('reports')
    .onSnapshot(async (snapshot) => {
      try {
        console.log('[REPORT STATUS DEBUG] Received report status snapshot');
        
        // On first snapshot, initialize the cache with all existing reports
        if (!isInitialized) {
          console.log('[REPORT STATUS DEBUG] Initializing cache with existing reports...');
          snapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.status) {
              reportStatusCache.set(doc.id, data.status);
              console.log(`[REPORT STATUS DEBUG] Cached initial status for report ${doc.id}: ${data.status}`);
            }
          });
          isInitialized = true;
          console.log(`[REPORT STATUS DEBUG] Cache initialized with ${reportStatusCache.size} reports`);
          return; // Don't process changes on first snapshot
        }
        
        // Process only modified documents
        const modifiedDocs = snapshot.docChanges()
          .filter(change => {
            // Only process server-side modifications (not local writes)
            const isModified = change.type === 'modified';
            const isLocal = change.doc.metadata?.hasPendingWrites ?? false;
            return isModified && !isLocal;
          })
          .map(change => ({
            id: change.doc.id,
            ...change.doc.data()
          }));

        console.log(`[REPORT STATUS DEBUG] Found ${modifiedDocs.length} modified reports`);

        if (modifiedDocs.length === 0) {
          return;
        }

        for (const report of modifiedDocs) {
          const reportId = report.id;
          const currentStatus = report.status;
          const previousStatus = reportStatusCache.get(reportId);

          console.log(`[REPORT STATUS DEBUG] Report ${reportId}: previous="${previousStatus}", current="${currentStatus}"`);

          // If we haven't seen this report before, cache it but don't skip notification
          // This handles the case where the server starts after a report was created
          if (!previousStatus) {
            console.log(`[REPORT STATUS DEBUG] First time seeing report ${reportId} in changes, caching status: ${currentStatus}`);
            reportStatusCache.set(reportId, currentStatus);
            
            // If status is not "pending", it means the report was updated while server was offline
            // We should still send notification for non-pending statuses
            if (currentStatus !== 'pending') {
              console.log(`[REPORT STATUS DEBUG] Status is not pending (${currentStatus}), will send notification`);
              // Don't skip - continue to send notification
            } else {
              console.log(`[REPORT STATUS DEBUG] Status is pending, skipping notification for new report`);
              continue;
            }
          }

          // Check if status has changed (only if we have a previous status)
          if (previousStatus && currentStatus === previousStatus) {
            console.log(`[REPORT STATUS DEBUG] No status change for report ${reportId}`);
            continue;
          }

          if (previousStatus) {
            console.log(`[REPORT STATUS DEBUG] Report status update detected for report ${reportId}: ${previousStatus} -> ${currentStatus}`);
          } else {
            console.log(`[REPORT STATUS DEBUG] Report status detected for report ${reportId}: ${currentStatus} (no previous status cached)`);
          }

          // Update the cache with new status
          reportStatusCache.set(reportId, currentStatus);

          // Validate required fields before sending notification
          if (!report.userId) {
            console.log(`[REPORT STATUS ERROR] Report ${reportId} missing userId, cannot send notification`);
            continue;
          }

          if (!report.issueType) {
            console.log(`[REPORT STATUS ERROR] Report ${reportId} missing issueType, using default`);
          }

          // Format status for display (replace underscores with spaces and capitalize)
          const formattedStatus = currentStatus
            .replace(/_/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');

          console.log(`[REPORT STATUS DEBUG] Sending status update notification to user ${report.userId}`);

          // Check if the user is an admin to prevent admins from receiving their own report status updates
          const recipientDoc = await firestore.collection('users').doc(report.userId).get();
          const isRecipientAdmin = recipientDoc.exists && (recipientDoc.data().isAdmin === true || recipientDoc.data().role === 'admin');
          
          if (isRecipientAdmin && report.updatedBy) {
            // If recipient is admin and they updated it themselves, skip notification
            if (report.updatedBy === report.userId) {
              console.log(`[REPORT STATUS DEBUG] Skipping notification - admin ${report.userId} updated their own report`);
              continue;
            }
          }

          // Store the notification in Firestore for the notification UI
          // Store in community_notifications to be consistent with other notifications
          const notificationData = {
            title: 'Report Status Updated',
            body: `Your report "${report.issueType || 'Community Issue'}" has been updated to: ${formattedStatus}`,
            type: 'reports',
            data: {
              reportId: report.id,
              status: currentStatus,
              previousStatus: previousStatus || 'pending',
              communityId: report.communityId,
              issueType: report.issueType,
              userId: report.userId // Include userId in data for filtering
            },
            communityId: report.communityId, // Include communityId to store in community_notifications
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: 'system'
          };

          let notificationId;
          try {
            const notificationRef = await firestore.collection('community_notifications').add(notificationData);
            notificationId = notificationRef.id;
            console.log(`[REPORT STATUS DEBUG] Stored notification in community_notifications collection with ID: ${notificationId}`);
            console.log(`[REPORT STATUS DEBUG] Notification data:`, JSON.stringify(notificationData, null, 2));

            // Create notification status record WITH communityId (consistent with other community notifications)
            const statusRef = await firestore.collection('notification_status').add({
              userId: report.userId,
              notificationId: notificationId,
              communityId: report.communityId, // Include communityId
              read: false,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[REPORT STATUS DEBUG] Created notification_status record with ID: ${statusRef.id}`);
            console.log(`[REPORT STATUS DEBUG] Status record links user ${report.userId} to notification ${notificationId} in community_notifications`);
          } catch (storeError) {
            console.error(`[REPORT STATUS ERROR] Error storing notification:`, storeError);
            // Generate a local ID if Firestore fails
            notificationId = `local_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
          }

          // Send FCM push notification to the report creator
          const { sendNotificationToUser } = require('./notifications');
          await sendNotificationToUser(
            report.userId,
            'Report Status Updated',
            `Your report "${report.issueType || 'Community Issue'}" has been updated to: ${formattedStatus}`,
            {
              type: 'reports',
              reportId: report.id,
              status: currentStatus,
              previousStatus: previousStatus || 'pending',
              communityId: report.communityId,
              priority: 'high',
              forceAlert: 'true',
              timestamp: Date.now(),
              notificationId: notificationId
            }
          );

          console.log(`[REPORT STATUS DEBUG] Successfully sent status update notification for report ${reportId}`);
        }
      } catch (error) {
        console.error('[REPORT STATUS ERROR] Error processing report status updates:', error);
      }
    });
};

// Monitor for new volunteer posts
const monitorVolunteerPosts = () => {
  const firestore = getFirestore();

  // Store the server start time to filter out old posts
  const serverStartTime = Date.now();
  console.log(`[VOLUNTEER DEBUG] Server started at: ${new Date(serverStartTime).toISOString()}`);

  console.log('Starting monitoring for new volunteer posts...');

  // Listen for new volunteer posts
  firestore.collection('volunteer_posts')
    .orderBy('date', 'desc')
    .limit(20)
    .onSnapshot(async (snapshot) => {
      try {
        console.log('[VOLUNTEER DEBUG] Received volunteer posts snapshot');

        // Process only added documents
        const addedDocs = snapshot.docChanges()
          .filter(change => change.type === 'added')
          .map(change => ({
            id: change.doc.id,
            ...change.doc.data()
          }));

        console.log(`[VOLUNTEER DEBUG] Found ${addedDocs.length} new volunteer posts`);

        if (addedDocs.length === 0) {
          return;
        }

        // Get current time
        const now = Date.now();

        // Process all posts that have a valid date timestamp
        const validPosts = addedDocs.filter(post => {
          console.log(`[VOLUNTEER DEBUG] Processing post ${post.id}`);
          console.log('[VOLUNTEER DEBUG] Full post data:', JSON.stringify(post, null, 2));

          // Check required fields - support both adminId and userId fields
          const creatorId = post.adminId || post.userId;
          if (!creatorId) {
            console.log(`[VOLUNTEER DEBUG] Post ${post.id} missing creator ID (adminId/userId)`);
            return false;
          }

          if (!post.communityId) {
            console.log(`[VOLUNTEER DEBUG] Post ${post.id} missing communityId`);
            return false;
          }

          // Check if post has date timestamp
          if (!post.date) {
            console.log(`[VOLUNTEER DEBUG] Post ${post.id} missing date timestamp`);
            return false;
          }

          // Convert Firestore timestamp to milliseconds
          const createdAtMs = post.date.toMillis ?
            post.date.toMillis() :
            (post.date._seconds ? post.date._seconds * 1000 : 0);

          // Skip posts created before server start (prevents duplicate notifications on restart)
          if (createdAtMs < serverStartTime) {
            console.log(`[VOLUNTEER DEBUG] Skipping post ${post.id} - created before server start`);
            return false;
          }

          // Only process posts created in the last 5 minutes
          if (now - createdAtMs > 5 * 60 * 1000) {
            console.log(`[VOLUNTEER DEBUG] Skipping post ${post.id} - too old (${Math.floor((now - createdAtMs)/1000)} seconds)`);
            return false;
          }

          console.log(`[VOLUNTEER DEBUG] Post ${post.id} created at: ${new Date(createdAtMs).toISOString()}`);

          // Check if the event date is valid and in the future
          if (post.eventDate) {
            const eventDateMs = post.eventDate.toMillis ?
              post.eventDate.toMillis() :
              (post.eventDate._seconds ? post.eventDate._seconds * 1000 : 0);

            if (eventDateMs < now) {
              console.log(`[VOLUNTEER DEBUG] Post ${post.id} has past event date: ${new Date(eventDateMs).toISOString()}`);
              return false;
            }
          }

          console.log(`[VOLUNTEER DEBUG] Post ${post.id} passed all checks, will send notification`);
          return true;
        });

        console.log(`[VOLUNTEER DEBUG] ${validPosts.length} posts passed filtering out of ${addedDocs.length} total`);

        if (validPosts.length === 0) {
          return;
        }

        for (const post of validPosts) {
          console.log(`[VOLUNTEER DEBUG] Preparing to send notification for post: ${post.id}`);
          console.log(`[VOLUNTEER DEBUG] Community ID: ${post.communityId}`);
          console.log(`[VOLUNTEER DEBUG] Post Creator: ${post.adminName || post.userName || 'Someone'}`);
          console.log(`[VOLUNTEER DEBUG] Post Creator ID: ${post.adminId || post.userId}`);

          // Send notification to all users in the community except the creator
          const { sendNotificationToCommunity } = require('./notifications');
          try {
            const result = await sendNotificationToCommunity(
              post.communityId,
              'New Volunteer Opportunity',
              `${post.adminName || post.userName || 'Someone'} posted: "${post.title}"`,
              {
                type: 'volunteer',
                volunteerId: post.id,
                postId: post.id,
                communityId: post.communityId,
                userId: post.adminId || post.userId,
                priority: 'high',
                forceAlert: 'true',
                timestamp: Date.now()
              },
              post.adminId || post.userId
            );

            console.log(`[VOLUNTEER DEBUG] Notification result for post ${post.id}:`, result);
          } catch (error) {
            console.error(`[VOLUNTEER ERROR] Failed to send notification for post ${post.id}:`, error);
          }
        }
      } catch (error) {
        console.error('[VOLUNTEER ERROR] Error processing new volunteer posts:', error);
      }
    });
};

// Helper function to get persistent tracking data from Firestore
const getTrackingData = async (firestore, postId) => {
  try {
    const trackingDoc = await firestore.collection('volunteer_tracking').doc(postId).get();
    if (trackingDoc.exists) {
      const data = trackingDoc.data();
      return {
        processedUsers: new Set(data.processedUsers || []),
        previousJoinedUsers: data.previousJoinedUsers || []
      };
    }
  } catch (error) {
    console.error(`[VOLUNTEER JOIN ERROR] Error getting tracking data for post ${postId}:`, error);
  }

  return {
    processedUsers: new Set(),
    previousJoinedUsers: []
  };
};

// Helper function to save persistent tracking data to Firestore
const saveTrackingData = async (firestore, postId, processedUsers, previousJoinedUsers) => {
  try {
    await firestore.collection('volunteer_tracking').doc(postId).set({
      processedUsers: Array.from(processedUsers),
      previousJoinedUsers: previousJoinedUsers,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error(`[VOLUNTEER JOIN ERROR] Error saving tracking data for post ${postId}:`, error);
  }
};

// Monitor for users joining volunteer posts
const monitorVolunteerPostJoins = () => {
  const firestore = getFirestore();

  // Generate unique instance ID to detect multiple instances
  const instanceId = `instance_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // Track server startup time to prevent false notifications immediately after restart
  const serverStartTime = Date.now();
  const STARTUP_GRACE_PERIOD = 30 * 1000; // 30 seconds

  console.log(`[VOLUNTEER JOIN DEBUG] Starting monitoring for users joining volunteer posts... Instance ID: ${instanceId}`);

  // Listen for updates to volunteer posts
  firestore.collection('volunteer_posts')
    .onSnapshot(async (snapshot) => {
      try {
        console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Processing volunteer post changes`);

        // Process all document changes
        const changes = snapshot.docChanges();

        // Process modified documents
        const modifiedDocs = changes
          .filter(change => {
            // Only process 'modified' changes that are not local
            const isModified = change.type === 'modified';
            const isLocal = change.doc.metadata?.hasPendingWrites ?? false;
            console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Change type: ${change.type}, isLocal: ${isLocal}, docId: ${change.doc.id}`);
            return isModified && !isLocal;
          })
          .map(change => {
            const docData = change.doc.data();
            const docId = change.doc.id;
            console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Mapping document ${docId} with data:`, Object.keys(docData));
            return {
              id: docId,
              ...docData
            };
          });

        console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Found ${modifiedDocs.length} modified volunteer posts`);

        if (modifiedDocs.length === 0) {
          return;
        }

        for (const post of modifiedDocs) {
          console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Processing changes for post: ${post.id}`);
          console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Post title: "${post.title}"`);
          console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Post creator (adminId): ${post.adminId}`);

          // Add additional debugging to understand the post structure
          console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Full post data:`, JSON.stringify(post, null, 2));

          // Skip if we don't have a valid post ID
          if (!post.id || post.id.trim() === '') {
            console.log(`[VOLUNTEER JOIN ERROR] [${instanceId}] Post is missing valid ID, skipping. Post data:`, JSON.stringify(post, null, 2));
            continue;
          }

          // Skip if we don't have the admin ID
          if (!post.adminId) {
            console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Warning: Post ${post.id} is missing adminId`);
            continue;
          }

          // Get the current joined users
          const currentJoinedUsers = Array.isArray(post.joinedUsers) ? post.joinedUsers : [];

          console.log(`[VOLUNTEER JOIN DEBUG] Current joined users: [${currentJoinedUsers.join(', ')}]`);

          // Get persistent tracking data from Firestore
          console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Loading tracking data for post ${post.id} from Firestore...`);
          const trackingData = await getTrackingData(firestore, post.id);
          const alreadyProcessed = trackingData.processedUsers;
          const previousUsers = trackingData.previousJoinedUsers;

          console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Loaded from Firestore - Already processed users: [${Array.from(alreadyProcessed).join(', ')}]`);
          console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Loaded from Firestore - Previous joined users: [${previousUsers.join(', ')}]`);

          // If this is the first time we have tracking data for this post, we need to be smart about initialization
          if (previousUsers.length === 0 && alreadyProcessed.size === 0) {
            console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] First time tracking post ${post.id}, initializing tracking`);

            const timeSinceServerStart = Date.now() - serverStartTime;

            // If we're within the startup grace period, be conservative to avoid false notifications
            if (timeSinceServerStart < STARTUP_GRACE_PERIOD && currentJoinedUsers.length > 0) {
              console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Within startup grace period (${timeSinceServerStart}ms < ${STARTUP_GRACE_PERIOD}ms) - marking existing users as processed`);

              // Mark all current users as already processed to prevent false notifications on startup
              currentJoinedUsers.forEach(userId => {
                if (userId !== post.adminId) {
                  alreadyProcessed.add(userId);
                }
              });

              await saveTrackingData(firestore, post.id, alreadyProcessed, currentJoinedUsers);
              console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Initialized tracking for post ${post.id} (startup grace period), skipping notifications for existing users`);
              continue;
            } else {
              console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Past startup grace period (${timeSinceServerStart}ms >= ${STARTUP_GRACE_PERIOD}ms) - will process current users as potential new joiners`);

              // Initialize with empty previous state so current users will be detected as new
              await saveTrackingData(firestore, post.id, alreadyProcessed, []);
            }
          }

          console.log(`[VOLUNTEER JOIN DEBUG] Already processed users for post ${post.id}: [${Array.from(alreadyProcessed).join(', ')}]`);
          console.log(`[VOLUNTEER JOIN DEBUG] Previous joined users for post ${post.id}: [${previousUsers.join(', ')}]`);

          // Find users who were added since the last snapshot (actual new joiners)
          const actualNewJoiners = currentJoinedUsers.filter(userId => {
            // Skip if the joined user is the post creator
            if (userId === post.adminId) {
              console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Skipping post creator ${userId} for post ${post.id}`);
              return false;
            }

            const wasInPrevious = previousUsers.includes(userId);
            const alreadyNotified = alreadyProcessed.has(userId);

            console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] User ${userId}: wasInPrevious=${wasInPrevious}, alreadyNotified=${alreadyNotified}`);

            // Only include users who weren't in the previous snapshot AND haven't been processed yet
            // This handles both new joins and prevents duplicates on server restart
            return !wasInPrevious && !alreadyNotified;
          });

          // Find users who were removed since the last snapshot (cancellations)
          const removedUsers = previousUsers.filter(userId => {
            return !currentJoinedUsers.includes(userId);
          });

          console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Actual new joiners found: [${actualNewJoiners.join(', ')}]`);
          console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Users who left/cancelled: [${removedUsers.join(', ')}]`);

          // Handle cancellations - remove from processed users so they can rejoin later
          if (removedUsers.length > 0) {
            console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Cleaning up processed users for cancellations: [${removedUsers.join(', ')}]`);
            removedUsers.forEach(userId => {
              alreadyProcessed.delete(userId);
            });
          }

          // Update the tracking data in Firestore
          await saveTrackingData(firestore, post.id, alreadyProcessed, currentJoinedUsers);

          if (actualNewJoiners.length === 0) {
            console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] No actual new joiners for post ${post.id}, skipping notifications`);
            continue;
          }

          // Process only the actual new joiners
          for (const newJoiner of actualNewJoiners) {
            try {
              // Get user's name from Realtime Database first
              const db = getDatabase();
              let userName = 'Someone';
              try {
                const userSnapshot = await db.ref(`/users/${newJoiner}`).once('value');
                const userData = userSnapshot.val();
                if (userData) {
                  userName = userData.fullName || userData.displayName || userData.username || userName;
                } else {
                  // Fallback to Firestore if not found in RTDB
                  const userDoc = await firestore.collection('users').doc(newJoiner).get();
                  if (userDoc.exists) {
                    const firestoreData = userDoc.data();
                    userName = firestoreData.fullName || firestoreData.displayName || firestoreData.username || userName;
                  }
                }
              } catch (nameError) {
                console.error(`[VOLUNTEER JOIN ERROR] Error getting user name: ${nameError}`);
              }

              console.log(`[VOLUNTEER JOIN DEBUG] Sending notification about NEW joiner ${userName} (${newJoiner}) to admin ${post.adminId}`);

              // Send notification to the post creator (admin)
              const { sendNotificationToUser } = require('./notifications');
              await sendNotificationToUser(
                post.adminId,
                'New Volunteer Joined',
                `${userName} joined your volunteer post: "${post.title}"`,
                {
                  type: 'volunteer',
                  volunteerId: post.id,
                  postId: post.id,
                  communityId: post.communityId,
                  joinerId: newJoiner,
                  priority: 'high',
                  forceAlert: 'true',
                  timestamp: Date.now()
                }
              );

              console.log(`[VOLUNTEER JOIN DEBUG] Successfully sent notification for post ${post.id} to admin ${post.adminId}`);

              // Also send a confirmation notification to the joiner
              await sendNotificationToUser(
                newJoiner,
                'Joined Volunteer Post',
                `You have successfully joined the volunteer post: "${post.title}"`,
                {
                  type: 'volunteer',
                  volunteerId: post.id,
                  postId: post.id,
                  communityId: post.communityId,
                  status: 'joined',
                  priority: 'high',
                  forceAlert: 'true',
                  timestamp: Date.now()
                }
              );

              console.log(`[VOLUNTEER JOIN DEBUG] Successfully sent confirmation notification to joiner ${newJoiner}`);

              // Mark this user as processed for this post
              alreadyProcessed.add(newJoiner);
              console.log(`[VOLUNTEER JOIN DEBUG] [${instanceId}] Marked user ${newJoiner} as processed for post ${post.id}`);

              // Save updated tracking data to Firestore
              await saveTrackingData(firestore, post.id, alreadyProcessed, currentJoinedUsers);

            } catch (userError) {
              console.error(`[VOLUNTEER JOIN ERROR] Error processing user ${newJoiner}:`, userError);
              console.error(userError);
            }
          }
        }
      } catch (error) {
        console.error('[VOLUNTEER JOIN ERROR] Error processing volunteer post joins:', error);
        console.error(error);
      }
    });
};

// Monitor for likes on comments
const monitorCommentLikes = () => {
  const db = getDatabase();
  const firestore = getFirestore();

  console.log('Starting monitoring for likes on comments...');

  // Listen for changes to notices that have comments with likes
  db.ref('/community_notices').on('child_changed', async (snapshot) => {
    try {
      const noticeData = snapshot.val();
      const noticeId = snapshot.key;

      if (!noticeData || !noticeData.comments) {
        return;
      }

      // Get all comments
      const comments = noticeData.comments || {};

      // Convert to array for easier processing
      const commentsArray = Object.entries(comments).map(([commentId, commentData]) => ({
        id: commentId,
        ...commentData
      }));

      // Process each comment to check for new likes
      for (const comment of commentsArray) {
        // Skip comments with no likes
        if (!comment.likes) {
          continue;
        }

        // Find likes added in the last 10 seconds
        const now = Date.now();
        const recentLikes = Object.entries(comment.likes)
          .filter(([_, likeData]) => {
            const createdAt = likeData.createdAt || 0;
            return (now - createdAt) < 10000; // 10 seconds
          })
          .map(([userId, _]) => userId);

        if (recentLikes.length === 0) {
          continue;
        }

        console.log(`[COMMENT_LIKE DEBUG] Recent likes detected on comment ${comment.id} in notice ${noticeId}: ${recentLikes.join(', ')}`);

        // Enhanced check: Don't send notifications to authors of their own content
        // Check if the comment author is also the notice author
        const isCommentFromNoticeAuthor = comment.authorId === noticeData.authorId;
        if (isCommentFromNoticeAuthor) {
          console.log(`[COMMENT_LIKE DEBUG] Comment ${comment.id} is from the notice author: ${comment.authorId}`);
        }

        // Process each like separately
        for (const likerId of recentLikes) {
          // Don't send notification if the comment author and like author are the same
          if (likerId === comment.authorId) {
            console.log(`[COMMENT_LIKE DEBUG] Skipping notification as user ${likerId} liked their own comment`);
            continue;
          }

          // FIX: The post author SHOULD receive notifications when people like their comments
          // The only time we want to skip notification is if the post author and comment author are the same
          // AND the liker is different (which is handled by the previous condition)

          // Log action for debugging
          if (likerId === noticeData.authorId) {
            console.log(`[COMMENT_LIKE DEBUG] Post author ${likerId} liked a comment from user ${comment.authorId}`);
          }

          // Check if either user is an admin and log for debugging purposes
          let likerIsAdmin = false;
          let commentAuthorIsAdmin = false;
          let noticeAuthorIsAdmin = false;

          try {
            const [likerDoc, commentAuthorDoc, noticeAuthorDoc] = await Promise.all([
              firestore.collection('users').doc(likerId).get(),
              firestore.collection('users').doc(comment.authorId).get(),
              firestore.collection('users').doc(noticeData.authorId).get()
            ]);

            likerIsAdmin = likerDoc.exists && (likerDoc.data().isAdmin || likerDoc.data().role === 'admin');
            commentAuthorIsAdmin = commentAuthorDoc.exists && (commentAuthorDoc.data().isAdmin || commentAuthorDoc.data().role === 'admin');
            noticeAuthorIsAdmin = noticeAuthorDoc.exists && (noticeAuthorDoc.data().isAdmin || noticeAuthorDoc.data().role === 'admin');

            if (likerIsAdmin) {
              console.log(`[COMMENT_LIKE DEBUG] Liker ${likerId} is an admin`);
            }

            if (commentAuthorIsAdmin) {
              console.log(`[COMMENT_LIKE DEBUG] Comment author ${comment.authorId} is an admin`);
            }

            if (noticeAuthorIsAdmin) {
              console.log(`[COMMENT_LIKE DEBUG] Notice author ${noticeData.authorId} is an admin`);
            }
          } catch (error) {
            console.error(`[COMMENT_LIKE ERROR] Error checking admin status: ${error.message}`);
          }

          // Get liker's name with enhanced retrieval - check multiple data sources
          let displayName = 'Someone';

          try {
            // First try Realtime Database
            const likerSnapshot = await db.ref(`/users/${likerId}`).once('value');
            const likerData = likerSnapshot.val();

            if (likerData) {
              console.log(`[COMMENT_LIKE DEBUG] Found user in RTDB: ${likerId}`);
              displayName = likerData.fullName || likerData.displayName || likerData.username || displayName;
            } else {
              console.log(`[COMMENT_LIKE DEBUG] User not found in RTDB: ${likerId}`);
            }

            // If we still don't have a name, check Firestore
            if (displayName === 'Someone') {
              const userDocRef = await firestore.collection('users').doc(likerId).get();
              if (userDocRef.exists) {
                const userData = userDocRef.data();
                console.log(`[COMMENT_LIKE DEBUG] Found user in Firestore: ${likerId}`);
                displayName = userData.fullName || userData.displayName || userData.username || displayName;
              } else {
                console.log(`[COMMENT_LIKE DEBUG] User not found in Firestore: ${likerId}`);
              }
            }

            // Final check in userProfiles collection if it exists
            if (displayName === 'Someone') {
              const profileDocRef = await firestore.collection('userProfiles').doc(likerId).get();
              if (profileDocRef.exists) {
                const profileData = profileDocRef.data();
                console.log(`[COMMENT_LIKE DEBUG] Found user in userProfiles: ${likerId}`);
                displayName = profileData.fullName || profileData.displayName || profileData.name || displayName;
              }
            }

            // If we STILL don't have a name, use first part of email or ID
            if (displayName === 'Someone') {
              // Try to get email from auth
              try {
                const userRecord = await admin.auth().getUser(likerId);
                if (userRecord && userRecord.email) {
                  displayName = userRecord.email.split('@')[0]; // Use email username
                  console.log(`[COMMENT_LIKE DEBUG] Using email from Auth: ${displayName}`);
                } else if (userRecord && userRecord.displayName) {
                  displayName = userRecord.displayName;
                  console.log(`[COMMENT_LIKE DEBUG] Using displayName from Auth: ${displayName}`);
                }
              } catch (authError) {
                console.log(`[COMMENT_LIKE DEBUG] Auth lookup failed: ${authError.message}`);
                // If everything fails, use shortened user ID instead of the full one
                displayName = likerId.substring(0, 8) + '...';
              }
            }
          } catch (error) {
            console.error(`[COMMENT_LIKE ERROR] Error retrieving user data: ${error.message}`);
            displayName = likerId.substring(0, 8) + '...'; // Shortened ID as fallback
          }

          console.log(`[COMMENT_LIKE DEBUG] Final display name for ${likerId}: ${displayName}`);

          // Get comment text for the notification
          let commentText = comment.text || comment.content || '';
          if (commentText.length > 30) {
            commentText = commentText.substring(0, 30) + '...';
          }

          // If comment text is empty or undefined, use a default message
          if (!commentText || commentText.trim() === '') {
            commentText = '(No comment text)';
          }

          console.log(`[COMMENT_LIKE DEBUG] Sending notification to ${comment.authorId} about like from ${displayName} on comment: "${commentText}"`);

          // Send notification to the comment author with enhanced data
          const { sendNotificationToUser } = require('./notifications');
          await sendNotificationToUser(
            comment.authorId,
            'New Like on Your Comment',
            `${displayName} liked your comment: "${commentText}"`,
            {
              type: 'socialInteractions',
              noticeId,
              commentId: comment.id,
              communityId: noticeData.communityId,
              likerId: likerId,
              commentText: commentText,
              // Include author IDs to help with filtering
              commentAuthorId: comment.authorId,
              noticeAuthorId: noticeData.authorId,
              // Add admin status information
              likerIsAdmin: likerIsAdmin ? 'true' : 'false',
              commentAuthorIsAdmin: commentAuthorIsAdmin ? 'true' : 'false',
              noticeAuthorIsAdmin: noticeAuthorIsAdmin ? 'true' : 'false',
              isUserAdmin: commentAuthorIsAdmin ? 'true' : 'false' // Flag if recipient is admin
            }
          );
        }
      }
    } catch (error) {
      console.error('[COMMENT_LIKE ERROR] Error processing comment likes:', error);
    }
  });
};

// Monitor for comment replies
const monitorCommentReplies = () => {
  const db = getDatabase();
  const firestore = getFirestore();

  console.log('Starting monitoring for comment replies...');

  // Listen for changes in community notices that might contain new replies
  db.ref('/community_notices').on('child_changed', async (snapshot) => {
    try {
      const noticeData = snapshot.val();
      const noticeId = snapshot.key;

      if (!noticeData || !noticeData.comments) {
        return;
      }

      // Process each comment to check for replies
      const commentsObj = noticeData.comments || {};

      for (const commentId in commentsObj) {
        const comment = commentsObj[commentId];

        // Skip if no replies
        if (!comment.replies) {
          continue;
        }

        // Convert replies object to array with IDs
        const repliesObj = comment.replies || {};
        const repliesArray = Object.entries(repliesObj).map(([replyId, data]) => ({
          id: replyId,
          ...data,
          createdAt: data.createdAt || 0
        }));

        // Skip if no replies
        if (repliesArray.length === 0) {
          continue;
        }

        // Sort by createdAt (newest first)
        repliesArray.sort((a, b) => b.createdAt - a.createdAt);

        // Get the latest reply
        const latestReply = repliesArray[0];

        // Check if the reply was just added (within the last 10 seconds)
        const now = Date.now();
        if (now - latestReply.createdAt > 10000) {
          continue;
        }

        console.log(`[REPLY DEBUG] Latest reply on comment ${commentId} in notice ${noticeId}:`, JSON.stringify(latestReply));

        // Check if this is a reply to a specific user (mentioned with @username) before skipping based on author
        const content = latestReply.content || '';
        const mentionMatch = content.match(/@([a-zA-Z0-9_]+(?:\s+[a-zA-Z0-9_]+)*)/);
        let mentionedUsername = null;
        let mentionedUserId = null;
        let replyToUserId = null;

        // First check if this is a reply to another reply (using replyToId)
        if (latestReply.replyToId) {
          console.log(`[REPLY DEBUG] This is a reply to another reply: ${latestReply.replyToId}`);

          // Find the reply that this is responding to
          for (const replyObj of repliesArray) {
            if (replyObj.id === latestReply.replyToId) {
              replyToUserId = replyObj.authorId;
              console.log(`[REPLY DEBUG] Found reply target user: ${replyToUserId}`);
              break;
            }
          }
        }

        if (mentionMatch && mentionMatch[1]) {
          mentionedUsername = mentionMatch[1].trim();
          console.log(`[REPLY DEBUG] Username mention detected: "${mentionedUsername}"`);

          // Look up the user ID by their username/name
          try {
            // Add more logging to help troubleshoot
            console.log(`[REPLY DEBUG] Searching for user with displayName "${mentionedUsername}" in Firestore`);

            // Search for mentioned user in Firestore by displayName or username
            const usersSnapshot = await firestore.collection('users')
              .where('displayName', '==', mentionedUsername)
              .limit(1)
              .get();

            if (!usersSnapshot.empty) {
              const mentionedUserDoc = usersSnapshot.docs[0];
              mentionedUserId = mentionedUserDoc.id;
              console.log(`[REPLY DEBUG] Found mentioned user ID: ${mentionedUserId}`);
            } else {
              console.log(`[REPLY DEBUG] No user found with exact displayName match, trying alternative lookups`);

              // Try a more flexible search approach - get all users and do client-side filtering
              const allUsersSnapshot = await firestore.collection('users')
                .limit(100)  // Limit to first 100 users to avoid excessive data transfer
                .get();

              const potentialMatches = [];
              allUsersSnapshot.forEach(doc => {
                const userData = doc.data();
                const displayName = userData.displayName || userData.fullName || userData.username || '';

                // Check if display name contains the mentioned username (case insensitive)
                if (displayName.toLowerCase().includes(mentionedUsername.toLowerCase())) {
                  potentialMatches.push({
                    id: doc.id,
                    displayName: displayName,
                    exactMatch: displayName.toLowerCase() === mentionedUsername.toLowerCase()
                  });
                }
              });

              console.log(`[REPLY DEBUG] Found ${potentialMatches.length} potential matches:`, JSON.stringify(potentialMatches));

              // Use the best match (prefer exact match, otherwise first partial match)
              const exactMatch = potentialMatches.find(match => match.exactMatch);
              if (exactMatch) {
                mentionedUserId = exactMatch.id;
                console.log(`[REPLY DEBUG] Using exact match: ${mentionedUserId} (${exactMatch.displayName})`);
              } else if (potentialMatches.length > 0) {
                mentionedUserId = potentialMatches[0].id;
                console.log(`[REPLY DEBUG] Using best partial match: ${mentionedUserId} (${potentialMatches[0].displayName})`);
              } else {
                // Final attempt: try to find the user in Firebase Auth
                try {
                  console.log(`[REPLY DEBUG] No matches found in Firestore, trying Firebase Auth lookup`);
                  // This is a basic implementation - in a real app, you'd need proper security rules
                  // Get a list of users from auth (up to 1000 users)
                  const listUsersResult = await admin.auth().listUsers(1000);

                  // Search for matching displayName in auth users
                  const authMatch = listUsersResult.users.find(user => {
                    const authDisplayName = user.displayName || '';
                    return authDisplayName.toLowerCase().includes(mentionedUsername.toLowerCase());
                  });

                  if (authMatch) {
                    mentionedUserId = authMatch.uid;
                    console.log(`[REPLY DEBUG] Found user in Firebase Auth: ${mentionedUserId} (${authMatch.displayName || authMatch.email})`);
                  } else {
                    console.log(`[REPLY DEBUG] No matching user found in Firebase Auth`);
                  }
                } catch (authError) {
                  console.error(`[REPLY ERROR] Error looking up user in Firebase Auth: ${authError.message}`);
                }
              }
            }
          } catch (error) {
            console.error(`[REPLY ERROR] Error processing user mention: ${error.message}`);
          }
        }

        // If we have a replyToId but couldn't find a mention, use the replyToUserId
        if (!mentionedUserId && replyToUserId) {
          mentionedUserId = replyToUserId;
          console.log(`[REPLY DEBUG] Using replyToUserId as mentionedUserId: ${mentionedUserId}`);
        }

        // If the reply author is the same as the comment author AND there's no mention/replyTo, skip notification
        // However, if there's a mention to another user, we should continue processing to send the mention notification
        if (latestReply.authorId === comment.authorId && !mentionedUserId) {
          console.log(`[REPLY DEBUG] Skipping notification as reply author ${latestReply.authorId} is the same as comment author and no mention was found`);
          continue;
        } else if (latestReply.authorId === comment.authorId && mentionedUserId) {
          console.log(`[REPLY DEBUG] Comment author is replying with a mention to user ${mentionedUserId}, will send mention notification`);
          // Continue processing for the mention notification
        }

        // Get commenter's name for the notification
        let replyAuthorName = 'Someone';

        try {
          // Try multiple sources to get the reply author's name
          // First try Realtime Database
          const authorSnapshot = await db.ref(`/users/${latestReply.authorId}`).once('value');
          const authorData = authorSnapshot.val();

          if (authorData) {
            replyAuthorName = authorData.fullName || authorData.displayName || authorData.username || replyAuthorName;
          } else {
            // If not in RTDB, check Firestore
            const userDocRef = await firestore.collection('users').doc(latestReply.authorId).get();
            if (userDocRef.exists) {
              const userData = userDocRef.data();
              replyAuthorName = userData.fullName || userData.displayName || userData.username || replyAuthorName;
            } else {
              // Final check in userProfiles collection
              const profileDocRef = await firestore.collection('userProfiles').doc(latestReply.authorId).get();
              if (profileDocRef.exists) {
                const profileData = profileDocRef.data();
                replyAuthorName = profileData.fullName || profileData.displayName || profileData.name || replyAuthorName;
              }
            }
          }
        } catch (error) {
          console.error(`[REPLY ERROR] Error retrieving reply author data: ${error.message}`);
        }

        // Format the reply content for notification
        let replyContent = latestReply.content || '';
        if (typeof replyContent !== 'string') {
          replyContent = String(replyContent || '');
        }

        if (replyContent.length > 50) {
          replyContent = replyContent.substring(0, 50) + '...';
        }

        if (!replyContent || replyContent.trim() === '') {
          replyContent = '(No reply text)';
        }

        console.log(`[REPLY DEBUG] Sending notification to ${comment.authorId} about reply from ${replyAuthorName}: "${replyContent}"`);

        // Send notification to the comment author
        const { sendNotificationToUser } = require('./notifications');

        // Only send notification to comment author if they're not the same as reply author
        if (comment.authorId !== latestReply.authorId) {
          await sendNotificationToUser(
            comment.authorId,
            'New Reply to Your Comment',
            `${replyAuthorName} replied to your comment: "${replyContent}"`,
            {
              type: 'socialInteractions',
              noticeId,
              commentId,
              replyId: latestReply.id,
              communityId: noticeData.communityId,
              authorId: latestReply.authorId,
              replyText: replyContent,
              parentCommentId: commentId,
              parentCommentAuthorId: comment.authorId
            }
          );
        }

        // If there's a mention, send notification to the mentioned user (if not already sent above)
        if (mentionedUserId && mentionedUserId !== latestReply.authorId) {
          // If the mentioned user is the comment author and the reply author is different, we've already sent them a notification above
          // Only need to send another notification if they're not the comment author, or if the reply author is the comment author
          if (mentionedUserId !== comment.authorId || latestReply.authorId === comment.authorId) {
            console.log(`[REPLY DEBUG] Sending mention notification to user ${mentionedUserId}`);

            // Send notification to the mentioned user
            await sendNotificationToUser(
              mentionedUserId,
              'You Were Mentioned in a Reply',
              `${replyAuthorName} mentioned you in a reply: "${replyContent}"`,
              {
                type: 'socialInteractions',
                noticeId,
                commentId,
                replyId: latestReply.id,
                communityId: noticeData.communityId,
                authorId: latestReply.authorId,
                replyText: replyContent,
                mentioned: true,
                mentionedUserId: mentionedUserId
              }
            );
          }
        }
      }
    } catch (error) {
      console.error('[REPLY ERROR] Error processing comment replies:', error);

      // Record the error for debugging
      try {
        await firestore.collection('notification_errors').add({
          type: 'commentReply',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          error: error.message,
          stack: error.stack
        });
      } catch (logError) {
        console.error('Failed to log error:', logError);
      }
    }
  });
};

// Monitor for likes on comment replies
const monitorCommentReplyLikes = () => {
  const db = getDatabase();
  const firestore = getFirestore();

  console.log('Starting monitoring for likes on comment replies...');

  // Listen for changes to notices that have comments with replies that have likes
  db.ref('/community_notices').on('child_changed', async (snapshot) => {
    try {
      const noticeData = snapshot.val();
      const noticeId = snapshot.key;

      if (!noticeData || !noticeData.comments) {
        return;
      }

      // Get all comments
      const comments = noticeData.comments || {};

      // Process each comment to check for replies with likes
      for (const commentId in comments) {
        const comment = comments[commentId];

        // Skip comments with no replies
        if (!comment.replies) {
          continue;
        }

        // Process each reply to check for likes
        const replies = comment.replies || {};

        for (const replyId in replies) {
          const reply = replies[replyId];

          // Skip replies with no likes
          if (!reply.likes) {
            continue;
          }

          // Find likes added in the last 10 seconds
          const now = Date.now();
          const recentLikes = Object.entries(reply.likes)
            .filter(([_, likeData]) => {
              const createdAt = likeData.createdAt || 0;
              return (now - createdAt) < 10000; // 10 seconds
            })
            .map(([userId, _]) => userId);

          if (recentLikes.length === 0) {
            continue;
          }

          console.log(`[REPLY_LIKE DEBUG] Recent likes detected on reply ${replyId} in comment ${commentId}, notice ${noticeId}: ${recentLikes.join(', ')}`);

          // Process each like separately
          for (const likerId of recentLikes) {
            // Don't send notification if the reply author and like author are the same
            if (likerId === reply.authorId) {
              console.log(`[REPLY_LIKE DEBUG] Skipping notification as user ${likerId} liked their own reply`);
              continue;
            }

            // Get liker's name for the notification
            let displayName = 'Someone';
            let likerIsAdmin = false;
            let replyAuthorIsAdmin = false;
            let commentAuthorIsAdmin = false;
            let noticeAuthorIsAdmin = false;

            try {
              // Try multiple sources to get the liker's name
              // First check Realtime Database
              const userSnapshot = await db.ref(`/users/${likerId}`).once('value');
              const userData = userSnapshot.val();

              if (userData) {
                displayName = userData.fullName || userData.displayName || userData.username || displayName;
                likerIsAdmin = userData.isAdmin || userData.admin || false;
              } else {
                // If not in RTDB, check Firestore
                const userDocRef = await firestore.collection('users').doc(likerId).get();
                if (userDocRef.exists) {
                  const userFirestoreData = userDocRef.data();
                  displayName = userFirestoreData.fullName || userFirestoreData.displayName || userFirestoreData.username || displayName;
                  likerIsAdmin = userFirestoreData.isAdmin || userFirestoreData.admin || false;
                }
              }

              // Check if the reply author is an admin
              const replyAuthorDocRef = await firestore.collection('users').doc(reply.authorId).get();
              if (replyAuthorDocRef.exists) {
                const replyAuthorData = replyAuthorDocRef.data();
                replyAuthorIsAdmin = replyAuthorData.isAdmin || replyAuthorData.admin || false;
              }

              // Check if the comment author is an admin
              const commentAuthorDocRef = await firestore.collection('users').doc(comment.authorId).get();
              if (commentAuthorDocRef.exists) {
                const commentAuthorData = commentAuthorDocRef.data();
                commentAuthorIsAdmin = commentAuthorData.isAdmin || commentAuthorData.admin || false;
              }

              // Check if the notice author is an admin
              const noticeAuthorDocRef = await firestore.collection('users').doc(noticeData.authorId).get();
              if (noticeAuthorDocRef.exists) {
                const noticeAuthorData = noticeAuthorDocRef.data();
                noticeAuthorIsAdmin = noticeAuthorData.isAdmin || noticeAuthorData.admin || false;
              }

              // If we STILL don't have a name, use first part of email or ID
              if (displayName === 'Someone') {
                // Try to get email from auth
                try {
                  const userRecord = await admin.auth().getUser(likerId);
                  if (userRecord && userRecord.email) {
                    displayName = userRecord.email.split('@')[0]; // Use email username
                    console.log(`[REPLY_LIKE DEBUG] Using email from Auth: ${displayName}`);
                  } else if (userRecord && userRecord.displayName) {
                    displayName = userRecord.displayName;
                    console.log(`[REPLY_LIKE DEBUG] Using displayName from Auth: ${displayName}`);
                  }
                } catch (authError) {
                  console.log(`[REPLY_LIKE DEBUG] Auth lookup failed: ${authError.message}`);
                  // If everything fails, use shortened user ID instead of the full one
                  displayName = likerId.substring(0, 8) + '...';
                }
              }
            } catch (error) {
              console.error(`[REPLY_LIKE ERROR] Error retrieving user data: ${error.message}`);
              displayName = likerId.substring(0, 8) + '...'; // Shortened ID as fallback
            }

            console.log(`[REPLY_LIKE DEBUG] Final display name for ${likerId}: ${displayName}`);

            // Get reply text for the notification
            let replyText = reply.text || reply.content || '';
            if (replyText.length > 30) {
              replyText = replyText.substring(0, 30) + '...';
            }

            // If reply text is empty or undefined, use a default message
            if (!replyText || replyText.trim() === '') {
              replyText = '(No reply text)';
            }

            console.log(`[REPLY_LIKE DEBUG] Sending notification to ${reply.authorId} about like from ${displayName} on reply: "${replyText}"`);

            // Send notification to the reply author with enhanced data
            const { sendNotificationToUser } = require('./notifications');
            await sendNotificationToUser(
              reply.authorId,
              'New Like on Your Reply',
              `${displayName} liked your reply: "${replyText}"`,
              {
                type: 'socialInteractions',
                noticeId,
                commentId,
                replyId,
                communityId: noticeData.communityId,
                likerId: likerId,
                replyText: replyText,
                // Include author IDs to help with filtering
                replyAuthorId: reply.authorId,
                commentAuthorId: comment.authorId,
                noticeAuthorId: noticeData.authorId,
                // Add admin status information
                likerIsAdmin: likerIsAdmin ? 'true' : 'false',
                replyAuthorIsAdmin: replyAuthorIsAdmin ? 'true' : 'false',
                commentAuthorIsAdmin: commentAuthorIsAdmin ? 'true' : 'false',
                noticeAuthorIsAdmin: noticeAuthorIsAdmin ? 'true' : 'false',
                isUserAdmin: replyAuthorIsAdmin ? 'true' : 'false' // Flag if recipient is admin
              }
            );
          }
        }
      }
    } catch (error) {
      console.error('[REPLY_LIKE ERROR] Error processing reply likes:', error);
    }
  });
};

// Monitor for marketplace item status updates (Approval/Rejection)
const monitorMarketplaceItemStatusUpdates = () => {
  const firestore = getFirestore();

  // Track previous status of items to detect changes
  const itemStatusCache = new Map();
  let isInitialized = false;

  console.log('Starting monitoring for marketplace item status updates...');

  // Listen for updates to market items
  firestore.collection('market_items')
    .onSnapshot(async (snapshot) => {
      try {
        // On first snapshot, initialize the cache
        if (!isInitialized) {
          snapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.status) {
              itemStatusCache.set(doc.id, data.status);
            }
          });
          isInitialized = true;
          console.log(`[MARKET STATUS DEBUG] Cache initialized with ${itemStatusCache.size} items`);
          return; 
        }

        // Process document changes
        const changes = snapshot.docChanges();
        
        if (changes.length === 0) return;

        for (const change of changes) {
          // We care about 'added' (to update cache for new items) and 'modified' (to detect status changes)
          // We ignore 'removed' for now, or we could clean up the cache
          if (change.type === 'removed') {
            itemStatusCache.delete(change.doc.id);
            continue;
          }
          
          const item = change.doc.data();
          const itemId = change.doc.id;
          const currentStatus = item.status;
          
          // Skip local writes
          if (change.doc.metadata?.hasPendingWrites) continue;

          if (change.type === 'added') {
            // Just update the cache so we have a baseline for future modifications
            if (currentStatus) {
              itemStatusCache.set(itemId, currentStatus);
              console.log(`[MARKET STATUS DEBUG] New item added to cache: ${itemId} with status ${currentStatus}`);
            }
            continue;
          }

          // Handle 'modified'
          const previousStatus = itemStatusCache.get(itemId);

          // Update cache
          itemStatusCache.set(itemId, currentStatus);

          if (!previousStatus || currentStatus === previousStatus) continue;

          console.log(`[MARKET STATUS DEBUG] Item ${itemId} status changed: ${previousStatus} -> ${currentStatus}`);

          // Only care about status changes to 'approved'/'active' or 'rejected'
          if (previousStatus === 'pending') {
            const { sendNotificationToUser, sendNotificationToCommunity } = require('./notifications');
            
            if (currentStatus === 'approved' || currentStatus === 'active') {
              console.log(`[MARKET STATUS DEBUG] Item approved. Notifying seller ${item.sellerId}`);
              
              // Notify Seller
              await sendNotificationToUser(
                item.sellerId,
                'Item Approved',
                `Your item "${item.title}" has been approved and is now live in the marketplace.`,
                {
                  type: 'marketplace',
                  itemId: itemId,
                  communityId: item.communityId,
                  status: 'approved',
                  timestamp: Date.now()
                }
              );

              // Notify Community about the new item (now that it's approved)
              console.log(`[MARKET STATUS DEBUG] Item approved. Notifying community ${item.communityId}`);
              
              // Note: We exclude the seller. The admin who approved it might still receive this notification
              // if they are a member of the community, which is expected behavior for "New Item" alerts.
              await sendNotificationToCommunity(
                item.communityId,
                'New Item in Marketplace',
                `${item.sellerName} is selling: "${item.title}" for ${item.price}`,
                {
                  type: 'marketplace',
                  itemId: itemId,
                  communityId: item.communityId,
                  sellerId: item.sellerId,
                },
                item.sellerId // Exclude the seller
              );

            } else if (currentStatus === 'rejected') {
              console.log(`[MARKET STATUS DEBUG] Item rejected. Notifying seller ${item.sellerId}`);
              
              const reason = item.rejectionReason ? ` Reason: ${item.rejectionReason}` : '';
              
              await sendNotificationToUser(
                item.sellerId,
                'Item Rejected',
                `Your item "${item.title}" has been rejected.${reason}`,
                {
                  type: 'marketplace',
                  itemId: itemId,
                  communityId: item.communityId,
                  status: 'rejected',
                  timestamp: Date.now()
                }
              );
            }
          }
        }
      } catch (error) {
        console.error('[MARKET STATUS ERROR] Error processing item status updates:', error);
      }
    });
};

// Start all monitoring functions
const startAllMonitoring = () => {
  try {
    monitorCommunityNotices();
    monitorCommunityNoticeComments();
    monitorCommunityNoticeLikes();
    monitorMarketplaceItems();
    monitorMarketplaceItemStatusUpdates();
    monitorChatMessages();
    monitorNewReports();
    monitorReportStatusUpdates();
    monitorVolunteerPosts();
    monitorVolunteerPostJoins();
    monitorCommentLikes();
    monitorCommentReplies();
    monitorCommentReplyLikes();

    console.log('All monitoring services started successfully');
  } catch (error) {
    console.error('Error starting monitoring services:', error);
    console.error('Server will continue running, but some notifications may not work');
  }
};

module.exports = {
  monitorCommunityNotices,
  monitorCommunityNoticeComments,
  monitorCommunityNoticeLikes,
  monitorMarketplaceItems,
  monitorMarketplaceItemStatusUpdates,
  monitorChatMessages,
  monitorNewReports,
  monitorReportStatusUpdates,
  monitorVolunteerPosts,
  monitorVolunteerPostJoins,
  monitorCommentLikes,
  monitorCommentReplies,
  monitorCommentReplyLikes,
  startAllMonitoring
};
