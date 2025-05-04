const admin = require('firebase-admin');
const { getDatabase, getFirestore } = require('./firebase');
const { sendNotificationToUser, sendNotificationToCommunity } = require('./notifications');

// Monitor for new community notices
const monitorCommunityNotices = () => {
  const db = getDatabase();
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
      
      console.log(`New community notice detected: ${noticeId}`);
      
      // Send notification to all users in the community except the author
      await sendNotificationToCommunity(
        noticeData.communityId,
        noticeData.title || 'New Community Notice',
        noticeData.content?.substring(0, 100) || 'A new notice has been posted in your community.',
        {
          type: 'communityNotices',
          noticeId,
          communityId: noticeData.communityId,
          authorId: noticeData.authorId,
        },
        noticeData.authorId // Exclude the author
      );
    } catch (error) {
      console.error('Error processing new community notice:', error);
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
      await sendNotificationToUser(
        noticeData.authorId,
        'New Comment on Your Notice',
        `${latestComment.authorName} commented: "${latestComment.text.substring(0, 50)}${latestComment.text.length > 50 ? '...' : ''}"`,
        {
          type: 'socialInteractions',
          noticeId,
          commentId: latestComment.id,
          communityId: noticeData.communityId,
          authorId: latestComment.authorId,
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
      const likeKeys = Object.keys(likes);
      
      if (likeKeys.length === 0) {
        return;
      }
      
      // Get the latest like (this is a simplification - in reality, we'd need to track which likes are new)
      // For a production system, you might want to store a timestamp with each like
      const latestLikerId = likeKeys[likeKeys.length - 1];
      
      // Don't send notification if the liker is the same as the notice author
      if (latestLikerId === noticeData.authorId) {
        return;
      }
      
      console.log(`New like detected on notice ${noticeId} by user ${latestLikerId}`);
      
      // Get liker's name
      const likerSnapshot = await db.ref(`/users/${latestLikerId}`).once('value');
      const likerData = likerSnapshot.val();
      const likerName = likerData?.fullName || likerData?.username || 'Someone';
      
      // Send notification to the notice author
      await sendNotificationToUser(
        noticeData.authorId,
        'New Like on Your Notice',
        `${likerName} liked your notice: "${noticeData.title}"`,
        {
          type: 'socialInteractions',
          noticeId,
          communityId: noticeData.communityId,
          likerId: latestLikerId,
        }
      );
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
  firestore.collection('market_items')
    .where('status', '==', 'active')
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
        
        for (const item of addedDocs) {
          console.log(`New marketplace item detected: ${item.id}`);
          
          // Send notification to all users in the community except the seller
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
      } catch (error) {
        console.error('Error processing new marketplace items:', error);
      }
    });
};

// Monitor for new chat messages
const monitorChatMessages = () => {
  const db = getDatabase();
  
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
      
      if (!latestMessage || !latestMessage.senderId || !latestMessage.text) {
        return;
      }
      
      // Check if the message was just added (within the last 10 seconds)
      const now = Date.now();
      if (latestMessage.timestamp && now - latestMessage.timestamp > 10000) {
        return;
      }
      
      console.log(`New chat message detected in chat ${chatId}`);
      
      // Determine the recipient
      const recipientId = latestMessage.senderId === chatData.buyerId
        ? chatData.sellerId
        : chatData.buyerId;
      
      // Get sender's name
      const senderSnapshot = await db.ref(`/users/${latestMessage.senderId}`).once('value');
      const senderData = senderSnapshot.val();
      const senderName = senderData?.fullName || senderData?.username || 'Someone';
      
      // Get item data if available
      let itemTitle = 'an item';
      if (chatData.itemId) {
        try {
          const itemDoc = await getFirestore().collection('market_items').doc(chatData.itemId).get();
          if (itemDoc.exists) {
            itemTitle = itemDoc.data().title || 'an item';
          }
        } catch (error) {
          console.error('Error getting item data:', error);
        }
      }
      
      // Send notification to the recipient
      await sendNotificationToUser(
        recipientId,
        'New Message',
        `${senderName}: "${latestMessage.text.substring(0, 50)}${latestMessage.text.length > 50 ? '...' : ''}"`,
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

// Monitor for report status updates
const monitorReportStatusUpdates = () => {
  const firestore = getFirestore();
  
  console.log('Starting monitoring for report status updates...');
  
  // Listen for updates to reports
  firestore.collection('reports')
    .onSnapshot(async (snapshot) => {
      try {
        // Process only modified documents
        const modifiedDocs = snapshot.docChanges()
          .filter(change => change.type === 'modified')
          .map(change => ({
            id: change.doc.id,
            ...change.doc.data(),
            oldData: change.doc.metadata.hasPendingWrites ? null : change.doc.data()
          }));
        
        if (modifiedDocs.length === 0) {
          return;
        }
        
        for (const report of modifiedDocs) {
          // Skip if we don't have the old data (local change)
          if (!report.oldData) {
            continue;
          }
          
          // Check if status has changed
          if (report.status === report.oldData.status) {
            continue;
          }
          
          console.log(`Report status update detected for report ${report.id}: ${report.oldData.status} -> ${report.status}`);
          
          // Send notification to the report creator
          await sendNotificationToUser(
            report.userId,
            'Report Status Updated',
            `Your report "${report.issueType}" has been updated to: ${report.status.replace('_', ' ')}`,
            {
              type: 'reports',
              reportId: report.id,
              status: report.status,
            }
          );
        }
      } catch (error) {
        console.error('Error processing report status updates:', error);
      }
    });
};

// Monitor for new volunteer posts
const monitorVolunteerPosts = () => {
  const firestore = getFirestore();
  
  console.log('Starting monitoring for new volunteer posts...');
  
  // Listen for new volunteer posts
  firestore.collection('volunteer_posts')
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
        
        for (const post of addedDocs) {
          console.log(`New volunteer post detected: ${post.id}`);
          
          // Send notification to all users in the community except the creator
          await sendNotificationToCommunity(
            post.communityId,
            'New Volunteer Opportunity',
            `${post.userName} posted: "${post.title}"`,
            {
              type: 'volunteer',
              postId: post.id,
              communityId: post.communityId,
              userId: post.userId,
            },
            post.userId // Exclude the creator
          );
        }
      } catch (error) {
        console.error('Error processing new volunteer posts:', error);
      }
    });
};

// Monitor for users joining volunteer posts
const monitorVolunteerPostJoins = () => {
  const firestore = getFirestore();
  
  console.log('Starting monitoring for users joining volunteer posts...');
  
  // Listen for updates to volunteer posts
  firestore.collection('volunteer_posts')
    .onSnapshot(async (snapshot) => {
      try {
        // Process only modified documents
        const modifiedDocs = snapshot.docChanges()
          .filter(change => change.type === 'modified')
          .map(change => ({
            id: change.doc.id,
            ...change.doc.data(),
            oldData: change.doc.metadata.hasPendingWrites ? null : change.doc.data()
          }));
        
        if (modifiedDocs.length === 0) {
          return;
        }
        
        for (const post of modifiedDocs) {
          // Skip if we don't have the old data (local change)
          if (!post.oldData) {
            continue;
          }
          
          // Check if joinedUsers has changed
          if (!post.joinedUsers || !post.oldData.joinedUsers ||
              post.joinedUsers.length === post.oldData.joinedUsers.length) {
            continue;
          }
          
          // Find the new users who joined
          const newUsers = post.joinedUsers.filter(userId => 
            !post.oldData.joinedUsers.includes(userId)
          );
          
          if (newUsers.length === 0) {
            continue;
          }
          
          console.log(`New users joined volunteer post ${post.id}: ${newUsers.join(', ')}`);
          
          // For each new user, send notification to the post creator
          for (const newUserId of newUsers) {
            // Get new user's name
            const userDoc = await firestore.collection('users').doc(newUserId).get();
            const userData = userDoc.exists ? userDoc.data() : null;
            const userName = userData?.fullName || userData?.username || 'Someone';
            
            // Send notification to the post creator
            await sendNotificationToUser(
              post.userId,
              'New Volunteer Joined',
              `${userName} joined your volunteer post: "${post.title}"`,
              {
                type: 'volunteer',
                postId: post.id,
                communityId: post.communityId,
                joinerId: newUserId,
              }
            );
          }
        }
      } catch (error) {
        console.error('Error processing volunteer post joins:', error);
      }
    });
};

// Start all monitoring functions
const startAllMonitoring = () => {
  monitorCommunityNotices();
  monitorCommunityNoticeComments();
  monitorCommunityNoticeLikes();
  monitorMarketplaceItems();
  monitorChatMessages();
  monitorReportStatusUpdates();
  monitorVolunteerPosts();
  monitorVolunteerPostJoins();
  
  console.log('All monitoring services started successfully');
};

module.exports = {
  monitorCommunityNotices,
  monitorCommunityNoticeComments,
  monitorCommunityNoticeLikes,
  monitorMarketplaceItems,
  monitorChatMessages,
  monitorReportStatusUpdates,
  monitorVolunteerPosts,
  monitorVolunteerPostJoins,
  startAllMonitoring
};
