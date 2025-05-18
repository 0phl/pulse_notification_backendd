import 'dart:io';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:firebase_core/firebase_core.dart';
import '../models/notification_model.dart';

// Top-level function to handle background messages
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  // Ensure Firebase is initialized
  await Firebase.initializeApp();

  debugPrint('==========================================');
  debugPrint('RECEIVED BACKGROUND MESSAGE!');
  debugPrint('Message data: ${message.data}');

  if (message.notification != null) {
    debugPrint('Title: ${message.notification!.title}');
    debugPrint('Body: ${message.notification!.body}');
    debugPrint('==========================================');
  } else {
    debugPrint('No notification payload in the message');
    debugPrint('==========================================');
  }

  // You can perform background tasks here, but keep them lightweight
  // For example, you might want to store the notification in Firestore
  // but avoid heavy processing
}

class NotificationService with WidgetsBindingObserver {
  static final NotificationService _instance = NotificationService._internal();
  factory NotificationService() => _instance;

  NotificationService._internal() {
    // Register for app lifecycle events
    WidgetsBinding.instance.addObserver(this);
  }

  final FirebaseMessaging _messaging = FirebaseMessaging.instance;
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  final FirebaseAuth _auth = FirebaseAuth.instance;

  FlutterLocalNotificationsPlugin? _localNotifications;
  AndroidNotificationChannel? _androidChannel;

  bool _initialized = false;
  String? _token;
  DateTime? _lastTokenRefresh;

  // Handle app lifecycle state changes
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    debugPrint('App lifecycle state changed to: $state');

    // When app resumes from background, refresh FCM token if needed
    if (state == AppLifecycleState.resumed) {
      _onAppResumed();
    }
  }

  // Handle app resumed from background
  Future<void> _onAppResumed() async {
    debugPrint('App resumed from background, checking FCM token...');

    // Only refresh token if it's been more than 1 hour since last refresh
    // or if we don't have a token yet
    final now = DateTime.now();
    if (_token == null ||
        _lastTokenRefresh == null ||
        now.difference(_lastTokenRefresh!).inHours >= 1) {
      debugPrint('Token refresh needed on app resume');

      try {
        // Force token refresh
        await _messaging.deleteToken();
        _token = await _messaging.getToken();

        if (_token != null) {
          debugPrint('FCM token refreshed on app resume: $_token');
          _lastTokenRefresh = now;
          await _updateToken(_token!);
        } else {
          debugPrint('Failed to refresh FCM token on app resume');
        }
      } catch (e) {
        debugPrint('Error refreshing FCM token on app resume: $e');
      }
    } else {
      debugPrint('Token refresh not needed (last refresh was recent)');
    }
  }

  // Initialize the notification service
  Future<void> initialize() async {
    if (_initialized) return;

    try {
      debugPrint('Initializing NotificationService...');

      // Request permission
      await _requestPermission();

      // Configure FCM handlers
      _configureForegroundMessageHandler();
      _configureBackgroundMessageHandler();
      _configureMessageOpenedAppHandler();

      // Check if user is logged in
      final user = _auth.currentUser;
      if (user != null) {
        debugPrint('User is logged in: ${user.uid}');

        // Check if user_tokens document exists and if loggedOut flag is set
        try {
          final userTokenDoc = await _firestore.collection('user_tokens').doc(user.uid).get();

          if (userTokenDoc.exists) {
            final data = userTokenDoc.data();
            final wasLoggedOut = data?['loggedOut'] == true;
            final tokens = data?['tokens'] as List<dynamic>? ?? [];

            debugPrint('User token document exists - loggedOut: $wasLoggedOut, token count: ${tokens.length}');

            if (wasLoggedOut || tokens.isEmpty) {
              debugPrint('User was logged out or has no tokens, forcing token refresh');

              // Force delete the token first to ensure a clean state
              try {
                await _messaging.deleteToken();
                debugPrint('Deleted existing token to force refresh');
              } catch (e) {
                debugPrint('Error deleting token: $e');
              }
            }
          } else {
            debugPrint('User token document does not exist, will create one');
          }
        } catch (e) {
          debugPrint('Error checking user_tokens document: $e');
        }
      } else {
        debugPrint('No user is logged in');
      }

      // Get and save FCM token
      await _getAndSaveToken();

      // Set last token refresh time
      _lastTokenRefresh = DateTime.now();

      // Listen for token refreshes
      _messaging.onTokenRefresh.listen((token) {
        debugPrint('FCM token refreshed automatically: $token');
        _lastTokenRefresh = DateTime.now();
        _updateToken(token);
      });

      // Ensure user_tokens document exists with correct settings
      await _ensureUserTokensDocumentExists();

      // Clean up read notifications to save storage space
      if (user != null) {
        try {
          await cleanupReadNotifications();
        } catch (e) {
          debugPrint('Warning: Could not clean up read notifications: $e');
        }
      }

      // Try to set up local notifications, but don't fail if it doesn't work
      try {
        await _setupLocalNotifications();
      } catch (e) {
        debugPrint('Warning: Could not set up local notifications: $e');
        debugPrint('Push notifications may still work, but foreground notifications might not show');
      }

      // Verify token was saved correctly
      if (user != null) {
        try {
          final verifyDoc = await _firestore.collection('user_tokens').doc(user.uid).get();
          if (verifyDoc.exists) {
            final data = verifyDoc.data();
            final tokens = data?['tokens'] as List<dynamic>? ?? [];
            final loggedOut = data?['loggedOut'] as bool? ?? false;

            debugPrint('Final verification - Token count: ${tokens.length}, loggedOut: $loggedOut');

            if (tokens.isEmpty || loggedOut) {
              debugPrint('WARNING: After initialization, tokens still empty or user still marked as logged out!');
              debugPrint('Will force one more token refresh...');

              // Force one more token refresh as a last resort
              try {
                await _messaging.deleteToken();
                final newToken = await _messaging.getToken();
                if (newToken != null) {
                  await _updateToken(newToken);
                  debugPrint('Final forced token refresh completed');
                }
              } catch (e) {
                debugPrint('Error during final token refresh: $e');
              }
            }
          }
        } catch (e) {
          debugPrint('Error during final token verification: $e');
        }
      }

      _initialized = true;
      debugPrint('NotificationService initialized successfully');
    } catch (e) {
      debugPrint('Error initializing NotificationService: $e');
      // Still mark as initialized to prevent repeated initialization attempts
      _initialized = true;
    }
  }

  // Ensure user_tokens document exists
  Future<void> _ensureUserTokensDocumentExists() async {
    final user = _auth.currentUser;
    if (user == null) {
      debugPrint('Cannot ensure user_tokens document: User not logged in');
      return;
    }

    try {
      debugPrint('Checking if user_tokens document exists for user: ${user.uid}');
      final docSnapshot = await _firestore.collection('user_tokens').doc(user.uid).get();

      if (!docSnapshot.exists) {
        debugPrint('User_tokens document does not exist, creating default document');
        // Create default document
        await _firestore.collection('user_tokens').doc(user.uid).set({
          'notificationPreferences': {
            'communityNotices': true,
            'socialInteractions': true,
            'marketplace': true,
            'chat': true,
            'reports': true,
            'volunteer': true,
          },
          'tokens': [],
          'createdAt': FieldValue.serverTimestamp(),
          'loggedOut': false, // Ensure loggedOut is set to false for new documents
        });
        debugPrint('Created user_tokens document for user: ${user.uid}');
      } else {
        debugPrint('User_tokens document already exists for user: ${user.uid}');
        final data = docSnapshot.data();
        if (data != null) {
          // Check if user was previously logged out
          final wasLoggedOut = data['loggedOut'] == true;

          // Check if we need to update the document
          bool needsUpdate = false;
          Map<String, dynamic> updateData = {};

          // Check if notificationPreferences exists
          if (!data.containsKey('notificationPreferences')) {
            debugPrint('notificationPreferences field missing, will add default preferences');
            updateData['notificationPreferences'] = {
              'communityNotices': true,
              'socialInteractions': true,
              'marketplace': true,
              'chat': true,
              'reports': true,
              'volunteer': true,
            };
            needsUpdate = true;
          }

          // Reset loggedOut flag if it was previously set to true
          if (wasLoggedOut) {
            debugPrint('User was previously logged out, will reset loggedOut flag');
            updateData['loggedOut'] = false;
            needsUpdate = true;
          }

          // Apply updates if needed
          if (needsUpdate) {
            await _firestore.collection('user_tokens').doc(user.uid).update(updateData);
            debugPrint('Updated user_tokens document with new settings');
          }

          final tokens = data['tokens'] as List<dynamic>? ?? [];
          debugPrint('Current tokens count: ${tokens.length}');

          // Check if tokens field is properly initialized
          if (tokens.isEmpty) {
            debugPrint('Tokens array is empty, will get a new token');
            // Force token refresh if the tokens array is empty
            await _getAndSaveToken();
          } else {
            debugPrint('Tokens array contains ${tokens.length} entries');
          }
        }
      }
    } catch (e) {
      debugPrint('Error ensuring user_tokens document exists: $e');
      debugPrint(e.toString());
    }
  }

  // Request notification permission
  Future<void> _requestPermission() async {
    try {
      debugPrint('Requesting notification permission...');

      // For all platforms, use Firebase Messaging to request permission
      NotificationSettings settings = await _messaging.requestPermission(
        alert: true,
        announcement: false,
        badge: true,
        carPlay: false,
        criticalAlert: false,
        provisional: false,
        sound: true,
      );

      debugPrint('Notification permission status: ${settings.authorizationStatus}');

      // Check if permission was granted
      if (settings.authorizationStatus == AuthorizationStatus.authorized) {
        debugPrint('User granted permission');
      } else if (settings.authorizationStatus == AuthorizationStatus.provisional) {
        debugPrint('User granted provisional permission');
      } else {
        debugPrint('User declined or has not accepted permission');
      }
    } catch (e) {
      debugPrint('Error requesting notification permission: $e');
      debugPrint(e.toString());
      // Continue anyway, as the app might still receive notifications
    }
  }

  // Setup local notifications for foreground messages with improved reliability
  Future<void> _setupLocalNotifications() async {
    try {
      debugPrint('Setting up local notifications...');
      _localNotifications = FlutterLocalNotificationsPlugin();

      // Android initialization
      // Regular channel for normal notifications with enhanced settings
      const AndroidNotificationChannel channel = AndroidNotificationChannel(
        'high_importance_channel',
        'High Importance Notifications',
        importance: Importance.max, // Use max importance for better reliability
        description: 'This channel is used for important notifications.',
        enableVibration: true,
        enableLights: true,
        showBadge: true,
        playSound: true,
      );

      // Admin-specific channel with highest importance
      const AndroidNotificationChannel adminChannel = AndroidNotificationChannel(
        'admin_high_importance_channel',
        'Admin Notifications',
        importance: Importance.max, // Use max importance for better reliability
        description: 'For important notifications for administrators',
        enableVibration: true,
        enableLights: true,
        showBadge: true,
        playSound: true,
      );

      // Create the Android notification channels
      final androidPlugin = _localNotifications!
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();

      if (androidPlugin != null) {
        debugPrint('Creating Android notification channels...');

        // Create main channels
        await androidPlugin.createNotificationChannel(channel);
        await androidPlugin.createNotificationChannel(adminChannel);

        // Create fallback channel for reliability
        const AndroidNotificationChannel fallbackChannel = AndroidNotificationChannel(
          'fallback_channel',
          'Fallback Notifications',
          importance: Importance.high,
          description: 'Used when other channels fail',
          enableVibration: true,
          playSound: true,
        );

        await androidPlugin.createNotificationChannel(fallbackChannel);
        debugPrint('Android notification channels created successfully');
      } else {
        debugPrint('Android plugin is null, cannot create notification channels');
      }

      _androidChannel = channel;

      // Initialize settings
      const AndroidInitializationSettings initializationSettingsAndroid =
          AndroidInitializationSettings('@drawable/notification_icon');

      // For newer versions, we use DarwinInitializationSettings
      const DarwinInitializationSettings initializationSettingsDarwin =
          DarwinInitializationSettings(
        requestSoundPermission: true,
        requestBadgePermission: true,
        requestAlertPermission: true,
      );

      const InitializationSettings initializationSettings = InitializationSettings(
        android: initializationSettingsAndroid,
        iOS: initializationSettingsDarwin,
      );

      // For newer versions, we use a different callback approach
      await _localNotifications!.initialize(
        initializationSettings,
        onDidReceiveNotificationResponse: (NotificationResponse response) async {
          // Handle notification tap
          debugPrint('Notification tapped: ${response.payload}');

          // You can navigate to a specific screen based on the payload
          // For example, if the payload is a JSON string containing route information
          if (response.payload != null) {
            // Parse the payload and navigate accordingly
            // Example: Navigator.pushNamed(context, payload['route'], arguments: payload['data']);
          }
        },
      );

      // Verify channels were created successfully on Android
      if (androidPlugin != null) {
        final List<AndroidNotificationChannel>? channels = await androidPlugin.getNotificationChannels();
        if (channels != null) {
          debugPrint('Notification channels: ${channels.length}');
          for (final channel in channels) {
            debugPrint('Channel: ${channel.id} - ${channel.name} - ${channel.importance}');
          }
        }
      }

      debugPrint('Local notifications setup complete');
    } catch (e) {
      debugPrint('Error setting up local notifications: $e');
      // Don't rethrow - we want to continue even if this fails
    }
  }

  // Configure foreground message handler with improved reliability
  void _configureForegroundMessageHandler() {
    FirebaseMessaging.onMessage.listen((RemoteMessage message) async {
      debugPrint('==========================================');
      debugPrint('RECEIVED FOREGROUND MESSAGE! ${DateTime.now().toIso8601String()}');
      debugPrint('Message data: ${message.data}');

      try {
        if (message.notification != null) {
          debugPrint('Title: ${message.notification!.title}');
          debugPrint('Body: ${message.notification!.body}');
          debugPrint('Android: ${message.notification!.android?.toString()}');
          debugPrint('Apple: ${message.notification!.apple?.toString()}');
          debugPrint('==========================================');

          // Always show notification immediately for better reliability
          await _showLocalNotification(message);
        } else {
          debugPrint('No notification payload in the message');
          debugPrint('==========================================');

          // Even without notification payload, we should process data messages
          await _processDataMessage(message);
        }
      } catch (e) {
        // Catch any errors to prevent the listener from breaking
        debugPrint('Error processing foreground message: $e');

        // Try to show notification anyway as a fallback
        try {
          await _showLocalNotification(message);
        } catch (fallbackError) {
          debugPrint('Fallback notification also failed: $fallbackError');
        }
      }
    });

    debugPrint('Improved foreground message handler configured');
  }

  // Process data-only messages
  Future<void> _processDataMessage(RemoteMessage message) async {
    // Handle data-only messages (no visible notification)
    if (message.data.isNotEmpty) {
      debugPrint('Processing data-only message: ${message.data}');

      // Store in Firestore if needed
      await _storeNotificationInFirestore(message);
    }
  }

  // Configure background message handler
  void _configureBackgroundMessageHandler() {
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
  }

  // Configure message opened app handler
  void _configureMessageOpenedAppHandler() {
    FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
      debugPrint('A new onMessageOpenedApp event was published!');
      debugPrint('Message data: ${message.data}');

      // Handle the notification tap
      // For example, navigate to a specific screen based on the message data
      if (message.data.containsKey('type')) {
        final String type = message.data['type'];

        switch (type) {
          case 'community_notice':
            // Navigate to community notice details
            // Example: Navigator.pushNamed(context, '/community-notice', arguments: message.data['noticeId']);
            break;
          case 'chat':
            // Navigate to chat screen
            // Example: Navigator.pushNamed(context, '/chat', arguments: message.data['chatId']);
            break;
          case 'marketplace':
            // Navigate to marketplace item
            // Example: Navigator.pushNamed(context, '/marketplace-item', arguments: message.data['itemId']);
            break;
          default:
            // Default action
            break;
        }
      }
    });
  }

  // Store notification in Firestore
  Future<void> _storeNotificationInFirestore(RemoteMessage message) async {
    debugPrint('Storing notification in Firestore...');

    try {
      final user = _auth.currentUser;
      if (user == null) {
        debugPrint('Cannot store notification: User not logged in');
        return;
      }

      // Check if this notification already exists in Firestore
      // This prevents duplicate notifications when the server sends the same notification
      bool isDuplicate = false;

      // Check if the message contains a notificationId from the server
      if (message.data.containsKey('notificationId')) {
        final String notificationId = message.data['notificationId'];
        debugPrint('Message contains notificationId: $notificationId');

        // Check if a notification status already exists for this notification
        final existingStatus = await _firestore
            .collection('notification_status')
            .where('userId', isEqualTo: user.uid)
            .where('notificationId', isEqualTo: notificationId)
            .limit(1)
            .get();

        if (existingStatus.docs.isNotEmpty) {
          debugPrint('Notification already exists in Firestore, skipping creation');
          isDuplicate = true;
        }
      }

      // If not a duplicate, create the notification
      if (!isDuplicate) {
        // Determine if this is a community notification
        final bool isCommunityNotification = message.data.containsKey('communityId');
        final String? communityId = message.data['communityId'];

        // Create notification record in the appropriate collection
        DocumentReference notificationRef;

        if (isCommunityNotification && communityId != null) {
          // Check if the notification already exists in community_notifications
          if (message.data.containsKey('notificationId')) {
            final String notificationId = message.data['notificationId'];
            final existingDoc = await _firestore.collection('community_notifications').doc(notificationId).get();

            if (existingDoc.exists) {
              notificationRef = existingDoc.reference;
              debugPrint('Using existing community notification: ${notificationRef.id}');
            } else {
              // Create a new community notification
              notificationRef = await _firestore.collection('community_notifications').add({
                'title': message.notification?.title ?? message.data['title'],
                'body': message.notification?.body ?? message.data['body'],
                'type': message.data['type'] ?? 'communityNotices',
                'data': message.data,
                'communityId': communityId,
                'createdAt': FieldValue.serverTimestamp(),
                'createdBy': message.data['authorId'] ?? 'system',
              });
              debugPrint('Created new community notification: ${notificationRef.id}');
            }
          } else {
            // Create a new community notification without an existing ID
            notificationRef = await _firestore.collection('community_notifications').add({
              'title': message.notification?.title ?? message.data['title'],
              'body': message.notification?.body ?? message.data['body'],
              'type': message.data['type'] ?? 'communityNotices',
              'data': message.data,
              'communityId': communityId,
              'createdAt': FieldValue.serverTimestamp(),
              'createdBy': message.data['authorId'] ?? 'system',
            });
            debugPrint('Created new community notification: ${notificationRef.id}');
          }
        } else {
          // Create a user notification
          notificationRef = await _firestore.collection('user_notifications').add({
            'title': message.notification?.title ?? message.data['title'],
            'body': message.notification?.body ?? message.data['body'],
            'type': message.data['type'] ?? 'general',
            'data': message.data,
            'createdAt': FieldValue.serverTimestamp(),
            'createdBy': 'system',
          });
          debugPrint('Created user notification: ${notificationRef.id}');
        }

        // Create a status record for this user
        await _firestore.collection('notification_status').add({
          'userId': user.uid,
          'notificationId': notificationRef.id,
          'communityId': isCommunityNotification ? communityId : null,
          'read': false,
          'createdAt': FieldValue.serverTimestamp(),
        });

        debugPrint('Notification status created for user ${user.uid}');
      }
    } catch (e) {
      debugPrint('Error storing notification in Firestore: $e');
    }
  }

  // Show a local notification with improved reliability
  Future<void> _showLocalNotification(RemoteMessage message) async {
    debugPrint('Attempting to show local notification...');
    debugPrint('Message data: ${message.data}');

    try {
      // Store the notification in Firestore first
      await _storeNotificationInFirestore(message);
    } catch (e) {
      debugPrint('Error storing notification in Firestore: $e');
      // Continue anyway to try showing the notification
    }

    // Skip local notification if plugins aren't available
    if (_localNotifications == null) {
      debugPrint('Local notifications plugin not available, trying to initialize it now');
      try {
        await _setupLocalNotifications();
      } catch (e) {
        debugPrint('Failed to initialize local notifications: $e');
        return;
      }
    }

    // If still null after initialization attempt, we can't continue
    if (_localNotifications == null) {
      debugPrint('Local notifications still not available after initialization attempt');
      return;
    }

    // Get notification details from the message
    final RemoteNotification? notification = message.notification;

    // Check if this is an admin notification
    final bool isAdminNotification = message.data['isForAdmin'] == 'true';

    try {
      // Determine notification title and body
      final String title = notification?.title ?? message.data['title'] ?? 'New Notification';
      final String body = notification?.body ?? message.data['body'] ?? 'You have a new notification';

      debugPrint('Showing local notification:');
      debugPrint('- Title: $title');
      debugPrint('- Body: $body');

      // Determine which channel to use based on whether this is an admin notification
      final String channelId = isAdminNotification
          ? 'admin_high_importance_channel'
          : 'high_importance_channel';

      debugPrint('Using notification channel: $channelId (isAdminNotification: $isAdminNotification)');

      // Generate a unique notification ID
      final int notificationId = DateTime.now().millisecondsSinceEpoch.remainder(100000);

      // Show the notification with enhanced settings
      await _localNotifications!.show(
        notificationId,
        title,
        body,
        NotificationDetails(
          android: AndroidNotificationDetails(
            channelId,
            isAdminNotification ? 'Admin Notifications' : 'High Importance Notifications',
            channelDescription: isAdminNotification
                ? 'For important notifications for administrators'
                : 'This channel is used for important notifications.',
            icon: '@drawable/notification_icon',
            importance: Importance.max,
            priority: Priority.max,
            color: const Color(0xFF00C49A),
            enableVibration: true,
            enableLights: true,
            playSound: true,
            ticker: 'New PULSE notification',
            visibility: NotificationVisibility.public,
          ),
          iOS: DarwinNotificationDetails(
            presentAlert: true,
            presentBadge: true,
            presentSound: true,
            sound: 'default',
            badgeNumber: 1,
            categoryIdentifier: isAdminNotification ? 'ADMIN_NOTIFICATION' : 'NOTIFICATION',
            interruptionLevel: InterruptionLevel.active,
          ),
        ),
        payload: message.data.toString(),
      );

      debugPrint('Local notification shown successfully with ID: $notificationId');
    } catch (e) {
      debugPrint('ERROR showing local notification: $e');

      // Try one more time with minimal settings as a last resort
      try {
        debugPrint('Attempting fallback notification with minimal settings');

        final String title = notification?.title ?? message.data['title'] ?? 'New Notification';
        final String body = notification?.body ?? message.data['body'] ?? 'You have a new notification';

        await _localNotifications!.show(
          0, // Use a fixed ID for the fallback
          title,
          body,
          const NotificationDetails(
            android: AndroidNotificationDetails(
              'fallback_channel',
              'Fallback Notifications',
              channelDescription: 'Used when other channels fail',
              importance: Importance.high,
              priority: Priority.high,
            ),
          ),
        );

        debugPrint('Fallback notification shown successfully');
      } catch (fallbackError) {
        debugPrint('Fallback notification also failed: $fallbackError');
      }
    }
  }

  // Get and save FCM token with improved reliability
  Future<void> _getAndSaveToken() async {
    try {
      debugPrint('Attempting to get FCM token...');

      // First check if we have permission
      try {
        final settings = await _messaging.getNotificationSettings();
        debugPrint('FCM Permission status: ${settings.authorizationStatus}');

        // If permission is not granted, request it
        if (settings.authorizationStatus != AuthorizationStatus.authorized &&
            settings.authorizationStatus != AuthorizationStatus.provisional) {
          debugPrint('Permission not granted, requesting permission...');
          await _requestPermission();

          // Check permission status again after requesting
          final newSettings = await _messaging.getNotificationSettings();
          debugPrint('FCM Permission status after request: ${newSettings.authorizationStatus}');

          if (newSettings.authorizationStatus != AuthorizationStatus.authorized &&
              newSettings.authorizationStatus != AuthorizationStatus.provisional) {
            debugPrint('Permission still not granted after request');
          }
        }
      } catch (settingsError) {
        debugPrint('Error getting notification settings: $settingsError');
        // Continue anyway, we'll try to get the token
      }

      // Delete any existing token to force a fresh one
      try {
        debugPrint('Deleting any existing token to ensure a fresh one...');
        await _messaging.deleteToken();
        debugPrint('Existing token deleted successfully');
      } catch (deleteError) {
        debugPrint('Error deleting existing token (may not exist yet): $deleteError');
        // Continue anyway
      }

      // Try to get a new token with retry logic
      int retryCount = 0;
      const maxRetries = 3;

      while (_token == null && retryCount < maxRetries) {
        try {
          debugPrint('Getting FCM token (attempt ${retryCount + 1})...');
          _token = await _messaging.getToken();

          if (_token != null) {
            debugPrint('FCM Token obtained: $_token');
          } else {
            debugPrint('FCM token is null after getToken() call');
            // Wait before retry
            await Future.delayed(const Duration(seconds: 2));
          }
        } catch (tokenError) {
          debugPrint('Error getting token (attempt ${retryCount + 1}): $tokenError');
          // Wait before retry
          await Future.delayed(const Duration(seconds: 2));
        }

        retryCount++;
      }

      // Print token to make it easier to test
      if (_token != null) {
        debugPrint('==========================================');
        debugPrint('FCM TOKEN FOR TESTING: $_token');
        debugPrint('Copy this token to use in Firebase Console');
        debugPrint('==========================================');

        // Save the token with updated logic
        await _updateToken(_token!);

        // Verify token was saved by reading it back
        final user = _auth.currentUser;
        if (user != null) {
          try {
            final verifyDoc = await _firestore.collection('user_tokens').doc(user.uid).get();
            if (verifyDoc.exists) {
              final data = verifyDoc.data();
              final tokens = data?['tokens'] as List<dynamic>? ?? [];
              final loggedOut = data?['loggedOut'] as bool? ?? false;

              debugPrint('Verification - Token count: ${tokens.length}, loggedOut: $loggedOut');

              if (tokens.isEmpty || loggedOut) {
                debugPrint('WARNING: Tokens still empty or user still marked as logged out after update!');

                // Force update with direct set operation as a last resort
                final now = Timestamp.now();
                final tokenData = {
                  'token': _token,
                  'platform': Platform.isAndroid ? 'android' : 'ios',
                  'createdAt': now,
                  'lastActive': now,
                  'appVersion': '1.0.0',
                };

                await _firestore.collection('user_tokens').doc(user.uid).set({
                  'tokens': [tokenData],
                  'loggedOut': false,
                  'lastActive': FieldValue.serverTimestamp(),
                  'lastTokenUpdate': now,
                  'notificationPreferences': {
                    'communityNotices': true,
                    'socialInteractions': true,
                    'marketplace': true,
                    'chat': true,
                    'reports': true,
                    'volunteer': true,
                  },
                }, SetOptions(merge: true));

                debugPrint('Forced token update with merge operation');

                // Verify one more time
                final finalVerifyDoc = await _firestore.collection('user_tokens').doc(user.uid).get();
                if (finalVerifyDoc.exists) {
                  final finalData = finalVerifyDoc.data();
                  final finalTokens = finalData?['tokens'] as List<dynamic>? ?? [];
                  debugPrint('Final verification - Token count: ${finalTokens.length}');
                }
              }
            }
          } catch (e) {
            debugPrint('Error verifying token update: $e');
          }
        }
      } else {
        debugPrint('ERROR: FCM token is null after $maxRetries attempts!');
        debugPrint('This might be due to missing Firebase Messaging plugin registration');
        debugPrint('Check your Android/iOS configuration and rebuild the app');

        // Try one more time with a longer delay as a last resort
        try {
          debugPrint('Making one final attempt to get FCM token after a longer delay...');
          await Future.delayed(const Duration(seconds: 5));
          _token = await _messaging.getToken();

          if (_token != null) {
            debugPrint('Final attempt successful! FCM Token: $_token');
            await _updateToken(_token!);
          } else {
            debugPrint('Final attempt also failed to get FCM token');
          }
        } catch (finalError) {
          debugPrint('Error in final token attempt: $finalError');
        }
      }
    } catch (e) {
      debugPrint('Error in _getAndSaveToken: $e');
      debugPrint(e.toString());
    }
  }

  // Get FCM token - public method to access the token
  Future<String?> getFcmToken() async {
    try {
      debugPrint('getFcmToken called');

      // If we already have a token, return it
      if (_token != null) {
        debugPrint('Returning existing token: $_token');
        return _token;
      }

      debugPrint('No existing token, attempting to get a new one...');

      // First check if we have permission
      try {
        final settings = await _messaging.getNotificationSettings();
        debugPrint('FCM Permission status: ${settings.authorizationStatus}');

        // If permission is not granted, request it
        if (settings.authorizationStatus != AuthorizationStatus.authorized &&
            settings.authorizationStatus != AuthorizationStatus.provisional) {
          debugPrint('Permission not granted, requesting permission...');
          final newSettings = await _messaging.requestPermission(
            alert: true,
            announcement: false,
            badge: true,
            carPlay: false,
            criticalAlert: false,
            provisional: false,
            sound: true,
          );
          debugPrint('New permission status: ${newSettings.authorizationStatus}');
        }
      } catch (settingsError) {
        debugPrint('Error getting notification settings: $settingsError');
        // Continue anyway, we'll try to get the token
      }

      // Get a new token
      try {
        debugPrint('Getting new FCM token...');
        _token = await _messaging.getToken();
        debugPrint('New token obtained: $_token');

        if (_token != null) {
          // Save the token
          await _updateToken(_token!);
          return _token;
        } else {
          debugPrint('WARNING: New token is null');
          return null;
        }
      } catch (tokenError) {
        debugPrint('Error getting new token: $tokenError');
        return 'Error: $tokenError';
      }
    } catch (e) {
      debugPrint('Error in getFcmToken: $e');
      return 'Error: $e';
    }
  }

  // Update token in Firestore with improved reliability for real-time notifications
  Future<void> _updateToken(String token) async {
    final user = _auth.currentUser;
    if (user == null) {
      debugPrint('Cannot update token: User not logged in');
      return;
    }

    try {
      debugPrint('Updating FCM token for user: ${user.uid} at ${DateTime.now().toIso8601String()}');
      debugPrint('Token to save: $token');

      // Update last token refresh time
      _lastTokenRefresh = DateTime.now();

      // Use current timestamp instead of FieldValue.serverTimestamp() for array items
      final now = Timestamp.now();
      final tokenData = {
        'token': token,
        'platform': Platform.isAndroid ? 'android' : 'ios',
        'createdAt': now,
        'lastActive': now,
        'appVersion': '1.0.0', // Add app version for better tracking
        'refreshedAt': now, // Track when token was refreshed
        'deviceInfo': {
          'platform': Platform.operatingSystem,
          'version': Platform.operatingSystemVersion,
        },
      };

      // Get existing tokens
      final userTokenDoc = await _firestore.collection('user_tokens').doc(user.uid).get();

      if (userTokenDoc.exists) {
        debugPrint('User token document exists, updating...');
        final data = userTokenDoc.data();

        // Check if tokens field exists and is a List
        final tokens = data?['tokens'] as List<dynamic>? ?? [];
        debugPrint('Current tokens count: ${tokens.length}');

        // Remove any expired or duplicate tokens (keep only the most recent 3)
        List<dynamic> updatedTokens = [...tokens];

        // Remove the current token if it exists (we'll add it back as the most recent)
        updatedTokens.removeWhere((t) => t['token'] == token);

        // Add the new token at the beginning (most recent)
        updatedTokens.insert(0, tokenData);

        // Keep only the 3 most recent tokens to avoid accumulating old tokens
        // if (updatedTokens.length > 3) {
        //   updatedTokens = updatedTokens.sublist(0, 3);
        // }

        // Update document with optimized settings
        debugPrint('Updating document with ${updatedTokens.length} tokens');

        // Check if the user was previously logged out
        final wasLoggedOut = data?['loggedOut'] == true;
        if (wasLoggedOut) {
          debugPrint('User was previously logged out, resetting loggedOut flag');
        }

        // Always set loggedOut to false when updating tokens, regardless of previous state
        await _firestore.collection('user_tokens').doc(user.uid).update({
          'tokens': updatedTokens,
          'lastActive': FieldValue.serverTimestamp(),
          'lastTokenUpdate': now,
          // Always reset loggedOut flag when updating tokens
          'loggedOut': false,
          'deviceInfo': {
            'platform': Platform.operatingSystem,
            'version': Platform.operatingSystemVersion,
            'lastActive': now,
          },
        });

        debugPrint('FCM token updated in Firestore successfully');
      } else {
        debugPrint('User token document does not exist, creating new document');

        // Create new token document with optimized settings
        await _firestore.collection('user_tokens').doc(user.uid).set({
          'tokens': [tokenData],
          'notificationPreferences': {
            'communityNotices': true,
            'socialInteractions': true,
            'marketplace': true,
            'chat': true,
            'reports': true,
            'volunteer': true,
          },
          'createdAt': FieldValue.serverTimestamp(),
          'lastActive': now,
          'lastTokenUpdate': now,
          'loggedOut': false, // Explicitly set loggedOut to false for new documents
          'deviceInfo': {
            'platform': Platform.operatingSystem,
            'version': Platform.operatingSystemVersion,
            'lastActive': now,
          },
        });

        debugPrint('New FCM token document created in Firestore');
      }

      // Verify token was saved by reading it back
      final verifyDoc = await _firestore.collection('user_tokens').doc(user.uid).get();
      if (verifyDoc.exists) {
        final data = verifyDoc.data();
        final tokens = data?['tokens'] as List<dynamic>? ?? [];
        final loggedOut = data?['loggedOut'] as bool? ?? false;
        bool tokenFound = false;

        for (final t in tokens) {
          if (t['token'] == token) {
            tokenFound = true;
            break;
          }
        }

        if (tokenFound) {
          debugPrint('Token verified in Firestore');
          if (loggedOut) {
            debugPrint('WARNING: User still marked as logged out after update! Forcing update...');
            // Force update loggedOut flag if it's still true
            await _firestore.collection('user_tokens').doc(user.uid).update({
              'loggedOut': false,
            });
          }
        } else {
          debugPrint('WARNING: Token not found in Firestore after update! Forcing update...');

          // Force update with direct set operation as a last resort
          await _firestore.collection('user_tokens').doc(user.uid).set({
            'tokens': [tokenData],
            'loggedOut': false,
            'lastActive': FieldValue.serverTimestamp(),
          }, SetOptions(merge: true));

          debugPrint('Forced token update with merge operation');
        }
      }
    } catch (e) {
      debugPrint('Error updating FCM token: $e');
      debugPrint(e.toString());

      // Fallback to simple update if the detailed update fails
      try {
        // Create a simple token object
        final simpleTokenData = {
          'token': token,
          'platform': Platform.isAndroid ? 'android' : 'ios',
          'createdAt': Timestamp.now(),
        };

        // Update with minimal data - always set loggedOut to false
        await _firestore.collection('user_tokens').doc(user.uid).set({
          'tokens': [simpleTokenData],
          'lastActive': FieldValue.serverTimestamp(),
          'loggedOut': false,
        }, SetOptions(merge: true));

        debugPrint('Token updated with fallback method');
      } catch (fallbackError) {
        debugPrint('Fallback token update also failed: $fallbackError');
      }
    }
  }

  // Get user notifications using the new structure
  Stream<QuerySnapshot> getUserNotifications() {
    final user = _auth.currentUser;
    if (user == null) {
      return const Stream.empty();
    }

    // Get notification status records for this user
    return _firestore
        .collection('notification_status')
        .where('userId', isEqualTo: user.uid)
        .orderBy('createdAt', descending: true)
        .limit(50)
        .snapshots();
  }

  // Get notification details by ID
  Future<Map<String, dynamic>?> getNotificationDetails(String notificationId, bool isCommunityNotification) async {
    try {
      final collection = isCommunityNotification ? 'community_notifications' : 'user_notifications';
      final doc = await _firestore.collection(collection).doc(notificationId).get();

      if (doc.exists) {
        return doc.data();
      }
      return null;
    } catch (e) {
      debugPrint('Error getting notification details: $e');
      return null;
    }
  }

  // Test admin notification specifically
  Future<void> testAdminNotification() async {
    return testLocalNotification(isAdminTest: true);
  }

  // Test local notification
  Future<void> testLocalNotification({bool isAdminTest = false}) async {
    debugPrint('Testing local notification... (Admin test: $isAdminTest)');

    // First try to create a notification in Firestore using the new structure
    // This will at least show up in the app's notification list
    try {
      final user = _auth.currentUser;
      if (user != null) {
        // Create a single notification record
        final notificationRef = await _firestore.collection('user_notifications').add({
          'title': isAdminTest ? 'Test Admin Notification' : 'Test Notification',
          'body': isAdminTest
              ? 'This is a test admin notification from PULSE app'
              : 'This is a test notification from PULSE app',
          'type': 'test',
          'data': {
            'test': true,
            'isForAdmin': isAdminTest ? 'true' : 'false',
          },
          'createdAt': FieldValue.serverTimestamp(),
          'createdBy': 'system',
        });

        // Create a status record for this user
        await _firestore.collection('notification_status').add({
          'userId': user.uid,
          'notificationId': notificationRef.id,
          'read': false,
          'createdAt': FieldValue.serverTimestamp(),
        });

        debugPrint('Test notification created in Firestore using new structure');
      } else {
        debugPrint('Cannot create test notification in Firestore: User not logged in');
      }
    } catch (e) {
      debugPrint('ERROR creating test notification in Firestore: $e');
    }

    // Then try to show a local notification
    if (_localNotifications == null || _androidChannel == null) {
      debugPrint('Local notifications not available, cannot send test notification');
      throw Exception('Local notifications not available');
    }

    try {
      // Determine which channel to use based on whether this is an admin test
      final String channelId = isAdminTest
          ? 'admin_high_importance_channel'
          : _androidChannel!.id;

      debugPrint('Using notification channel for test: $channelId');

      await _localNotifications!.show(
        0,
        isAdminTest ? 'Test Admin Notification' : 'Test Notification',
        isAdminTest
            ? 'This is a test admin notification from PULSE app'
            : 'This is a test notification from PULSE app',
        NotificationDetails(
          android: AndroidNotificationDetails(
            channelId,
            isAdminTest ? 'Admin Notifications' : _androidChannel!.name,
            channelDescription: isAdminTest
                ? 'For important notifications for administrators'
                : _androidChannel!.description,
            icon: '@drawable/notification_icon',
            importance: Importance.high,
            priority: Priority.high,
            color: const Color(0xFF00C49A),
          ),
          iOS: DarwinNotificationDetails(
            presentAlert: true,
            presentBadge: true,
            presentSound: true,
            categoryIdentifier: isAdminTest ? 'ADMIN_NOTIFICATION' : null,
          ),
        ),
        payload: isAdminTest ? 'test_admin_notification' : 'test_notification',
      );

      debugPrint('Test notification sent successfully');
    } catch (e) {
      debugPrint('Error sending test notification: $e');
      throw Exception('Failed to send test notification: $e');
    }
  }

  // Mark notification as read and delete from notification_status to save storage
  // Returns the notification data before deleting so it can still be displayed
  Future<Map<String, dynamic>?> markNotificationAsRead(String statusId) async {
    try {
      // First get the notification status document to retrieve the notificationId and communityId
      final statusDoc = await _firestore.collection('notification_status').doc(statusId).get();

      if (!statusDoc.exists) {
        debugPrint('Notification status not found: $statusId');
        return null;
      }

      final statusData = statusDoc.data() as Map<String, dynamic>;
      final notificationId = statusData['notificationId'] as String?;
      final communityId = statusData['communityId'] as String?;

      if (notificationId == null) {
        debugPrint('Notification ID not found in status document');
        return null;
      }

      // Determine which collection to query based on whether it's a community notification
      final collection = communityId != null ? 'community_notifications' : 'user_notifications';

      // Get the actual notification document
      final notificationDoc = await _firestore.collection(collection).doc(notificationId).get();

      if (!notificationDoc.exists) {
        debugPrint('Notification document not found: $notificationId');
        return null;
      }

      // Get the notification data
      final notificationData = notificationDoc.data() as Map<String, dynamic>;

      // Create a combined data object with both status and notification data
      final combinedData = {
        ...notificationData,
        'statusId': statusId,
        'notificationId': notificationId,
        'read': true,
        'communityId': communityId,
      };

      // Delete the notification status document to save storage
      await _firestore.collection('notification_status').doc(statusId).delete();
      debugPrint('Notification status deleted to save storage: $statusId');

      return combinedData;
    } catch (e) {
      debugPrint('Error marking notification as read: $e');
      return null;
    }
  }

  // Mark all notifications as read for the current user and delete from notification_status
  // Returns a list of notification data that can still be displayed
  Future<List<Map<String, dynamic>>> markAllNotificationsAsRead() async {
    final user = _auth.currentUser;
    if (user == null) return [];

    try {
      // Get all unread notifications for this user
      final unreadNotifications = await _firestore
          .collection('notification_status')
          .where('userId', isEqualTo: user.uid)
          .where('read', isEqualTo: false)
          .get();

      if (unreadNotifications.docs.isEmpty) {
        debugPrint('No unread notifications to mark as read');
        return [];
      }

      // Process each notification to get its data before deleting
      final List<Map<String, dynamic>> notificationDataList = [];
      final batch = _firestore.batch();

      for (final doc in unreadNotifications.docs) {
        try {
          final statusData = doc.data();
          final notificationId = statusData['notificationId'] as String?;
          final communityId = statusData['communityId'] as String?;

          if (notificationId != null) {
            // Determine which collection to query
            final collection = communityId != null ? 'community_notifications' : 'user_notifications';

            // Get the actual notification document
            final notificationDoc = await _firestore.collection(collection).doc(notificationId).get();

            if (notificationDoc.exists) {
              final notificationData = notificationDoc.data() as Map<String, dynamic>;

              // Create a combined data object
              final combinedData = {
                ...notificationData,
                'statusId': doc.id,
                'notificationId': notificationId,
                'read': true,
                'communityId': communityId,
              };

              notificationDataList.add(combinedData);
            }
          }

          // Mark for deletion
          batch.delete(doc.reference);
        } catch (e) {
          debugPrint('Error processing notification: $e');
        }
      }

      // Execute the batch delete
      await batch.commit();

      debugPrint('Marked and deleted ${unreadNotifications.docs.length} notifications');
      return notificationDataList;
    } catch (e) {
      debugPrint('Error marking all notifications as read: $e');
      return [];
    }
  }

  // Delete notification
  Future<void> deleteNotification(String statusId) async {
    try {
      // Only delete the status record, not the actual notification
      // This preserves the notification for other users
      await _firestore.collection('notification_status').doc(statusId).delete();

      debugPrint('Notification status deleted');
    } catch (e) {
      debugPrint('Error deleting notification status: $e');
    }
  }

  // Clean up old read notifications for the current user
  // This deletes only notifications that are older than the specified days
  // to save storage while keeping recent read notifications visible
  Future<void> cleanupReadNotifications({int olderThanDays = 30}) async {
    final user = _auth.currentUser;
    if (user == null) return;

    try {
      // Calculate the cutoff date (notifications older than this will be deleted)
      final cutoffDate = DateTime.now().subtract(Duration(days: olderThanDays));
      final cutoffTimestamp = Timestamp.fromDate(cutoffDate);

      // Get all read notifications for this user that are older than the cutoff date
      final readNotifications = await _firestore
          .collection('notification_status')
          .where('userId', isEqualTo: user.uid)
          .where('read', isEqualTo: true)
          .get();

      // Filter locally to get only old notifications
      // (Firestore doesn't support multiple field filters without composite indexes)
      final oldNotifications = readNotifications.docs.where((doc) {
        final data = doc.data();
        final createdAt = data['createdAt'] as Timestamp?;
        return createdAt != null && createdAt.compareTo(cutoffTimestamp) < 0;
      }).toList();

      // Delete old read notifications
      if (oldNotifications.isNotEmpty) {
        final batch = _firestore.batch();

        for (final doc in oldNotifications) {
          batch.delete(doc.reference);
        }

        await batch.commit();
        debugPrint('Cleaned up ${oldNotifications.length} old read notifications from Firestore');
      } else {
        debugPrint('No old read notifications to clean up');
      }
    } catch (e) {
      debugPrint('Error cleaning up read notifications: $e');
    }
  }


  // Get notification preferences
  Future<Map<String, bool>> getNotificationPreferences() async {
    final user = _auth.currentUser;
    if (user == null) {
      return {
        'communityNotices': true,
        'socialInteractions': true,
        'marketplace': true,
        'chat': true,
        'reports': true,
        'volunteer': true,
      };
    }

    try {
      final userTokenDoc = await _firestore.collection('user_tokens').doc(user.uid).get();

      if (userTokenDoc.exists) {
        final data = userTokenDoc.data();
        final preferences = data?['notificationPreferences'] as Map<String, dynamic>? ?? {};

        return {
          'communityNotices': preferences['communityNotices'] ?? true,
          'socialInteractions': preferences['socialInteractions'] ?? true,
          'marketplace': preferences['marketplace'] ?? true,
          'chat': preferences['chat'] ?? true,
          'reports': preferences['reports'] ?? true,
          'volunteer': preferences['volunteer'] ?? true,
        };
      }
    } catch (e) {
      debugPrint('Error getting notification preferences: $e');
    }

    // Default preferences
    return {
      'communityNotices': true,
      'socialInteractions': true,
      'marketplace': true,
      'chat': true,
      'reports': true,
      'volunteer': true,
    };
  }

  // Update user notification preferences
  Future<void> updateNotificationPreferences(Map<String, bool> preferences) async {
    final user = _auth.currentUser;
    if (user == null) return;

    try {
      // Check if document exists first
      final docSnapshot = await _firestore.collection('user_tokens').doc(user.uid).get();

      if (docSnapshot.exists) {
        // Update existing document
        await _firestore.collection('user_tokens').doc(user.uid).update({
          'notificationPreferences': preferences,
        });
      } else {
        // Create new document with preferences
        await _firestore.collection('user_tokens').doc(user.uid).set({
          'notificationPreferences': preferences,
          'tokens': [],
          'createdAt': FieldValue.serverTimestamp(),
        });
      }

      debugPrint('Notification preferences updated');
    } catch (e) {
      debugPrint('Error updating notification preferences: $e');
    }
  }

  // Subscribe to topic
  Future<void> subscribeToTopic(String topic) async {
    await _messaging.subscribeToTopic(topic);
    debugPrint('Subscribed to topic: $topic');
  }

  // Unsubscribe from topic
  Future<void> unsubscribeFromTopic(String topic) async {
    await _messaging.unsubscribeFromTopic(topic);
    debugPrint('Unsubscribed from topic: $topic');
  }

  // Get unread notification count for the current user
  Future<int> getUnreadNotificationCount() async {
    final user = _auth.currentUser;
    if (user == null) return 0;

    try {
      final unreadNotifications = await _firestore
          .collection('notification_status')
          .where('userId', isEqualTo: user.uid)
          .where('read', isEqualTo: false)
          .count()
          .get();

      return unreadNotifications.count ?? 0;
    } catch (e) {
      debugPrint('Error getting unread notification count: $e');
      return 0;
    }
  }

  // Get a stream of unread notification counts
  Stream<int> getUnreadNotificationCountStream() {
    final user = _auth.currentUser;
    if (user == null) return Stream.value(0);

    try {
      return _firestore
          .collection('notification_status')
          .where('userId', isEqualTo: user.uid)
          .where('read', isEqualTo: false)
          .snapshots()
          .map((snapshot) => snapshot.docs.length);
    } catch (e) {
      debugPrint('Error getting unread notification count stream: $e');
      return Stream.value(0);
    }
  }

  // Get community notifications stream
  Stream<QuerySnapshot> getCommunityNotificationsStream() {
    final user = _auth.currentUser;
    if (user == null) {
      // Return an empty stream if no user is logged in
      return const Stream.empty();
    }

    // Get notifications for the current user
    return _firestore
        .collection('notification_status')
        .where('userId', isEqualTo: user.uid)
        .orderBy('createdAt', descending: true)
        .snapshots();
  }

  // Get community notifications for the user's community
  // This can be used to display notifications even after they're deleted from notification_status
  Future<List<Map<String, dynamic>>> getCommunityNotifications(String communityId, {int limit = 20}) async {
    try {
      debugPrint('Fetching community notifications for community: $communityId');

      // Get notifications for the community
      final snapshot = await _firestore
          .collection('community_notifications')
          .where('communityId', isEqualTo: communityId)
          .orderBy('createdAt', descending: true)
          .limit(limit)
          .get();

      if (snapshot.docs.isEmpty) {
        debugPrint('No community notifications found');
        return [];
      }

      debugPrint('Found ${snapshot.docs.length} community notifications');

      // Convert to a list of maps
      final List<Map<String, dynamic>> notifications = [];
      for (final doc in snapshot.docs) {
        final data = doc.data();

        // Create a complete notification object
        final notificationData = {
          ...data,
          'notificationId': doc.id,
          'statusId': doc.id, // Use the notification ID as the status ID for read notifications
          'read': true, // Assume read since we're fetching directly
          'source': 'community',
        };

        notifications.add(notificationData);
        debugPrint('Added notification: ${doc.id} - ${data['title']}');
      }

      return notifications;
    } catch (e) {
      debugPrint('Error getting community notifications: $e');
      return [];
    }
  }

  // Get user's community ID
  Future<String?> getUserCommunityId() async {
    final user = _auth.currentUser;
    if (user == null) return null;

    try {
      final userDoc = await _firestore.collection('users').doc(user.uid).get();
      if (!userDoc.exists) return null;

      final userData = userDoc.data() as Map<String, dynamic>;
      return userData['communityId'] as String?;
    } catch (e) {
      debugPrint('Error getting user community ID: $e');
      return null;
    }
  }

  // Reset FCM token after login
  Future<void> resetTokenAfterLogin() async {
    try {
      final user = _auth.currentUser;
      if (user == null) {
        debugPrint('Cannot reset token: No user is logged in');
        return;
      }

      final userId = user.uid;
      debugPrint('Resetting FCM token after login for user: $userId');

      // Force delete the existing token to ensure a clean state
      try {
        await _messaging.deleteToken();
        debugPrint('Deleted existing token to force refresh');
      } catch (e) {
        debugPrint('Error deleting token: $e');
      }

      // Get a new token
      String? newToken;
      try {
        newToken = await _messaging.getToken();
        debugPrint('New token obtained after login: $newToken');
      } catch (e) {
        debugPrint('Error getting new token: $e');
      }

      if (newToken == null) {
        debugPrint('Failed to get new token after login');
        return;
      }

      // Directly set the token and loggedOut flag in Firestore
      final now = Timestamp.now();
      final tokenData = {
        'token': newToken,
        'platform': Platform.isAndroid ? 'android' : 'ios',
        'createdAt': now,
        'lastActive': now,
      };

      // Update the document with the new token and reset loggedOut flag
      await _firestore.collection('user_tokens').doc(userId).set({
        'tokens': [tokenData],
        'loggedOut': false,
        'lastActive': FieldValue.serverTimestamp(),
        'lastTokenUpdate': now,
        'notificationPreferences': {
          'communityNotices': true,
          'socialInteractions': true,
          'marketplace': true,
          'chat': true,
          'reports': true,
          'volunteer': true,
        },
      }, SetOptions(merge: true));

      debugPrint('FCM token reset after login for user: $userId');

      // Verify the update was successful
      final verifyDoc = await _firestore.collection('user_tokens').doc(userId).get();
      if (verifyDoc.exists) {
        final data = verifyDoc.data();
        final tokens = data?['tokens'] as List<dynamic>? ?? [];
        final loggedOut = data?['loggedOut'] as bool? ?? false;

        debugPrint('Verification after login - Token count: ${tokens.length}, loggedOut: $loggedOut');

        if (loggedOut || tokens.isEmpty) {
          debugPrint('WARNING: Tokens still empty or user still marked as logged out! Forcing update...');

          // Force update with direct set operation as a last resort
          await _firestore.collection('user_tokens').doc(userId).update({
            'tokens': [tokenData],
            'loggedOut': false,
          });

          debugPrint('Forced token update after login');
        }
      }
    } catch (e) {
      debugPrint('Error resetting FCM token after login: $e');
    }
  }

  // Check and refresh FCM token if needed
  Future<void> checkAndRefreshToken() async {
    debugPrint('Manually checking FCM token status...');

    final user = _auth.currentUser;
    if (user == null) {
      debugPrint('Cannot check token: User not logged in');
      return;
    }

    try {
      // Check if we have a token
      if (_token == null) {
        debugPrint('No token exists, getting a new one');
        await _getAndSaveToken();
        return;
      }

      // Check if token is still valid by trying to get the current token
      final currentToken = await _messaging.getToken();

      // If tokens don't match, update with the new one
      if (currentToken != _token) {
        debugPrint('Token mismatch detected:');
        debugPrint('Stored token: $_token');
        debugPrint('Current token: $currentToken');

        if (currentToken != null) {
          _token = currentToken;
          _lastTokenRefresh = DateTime.now();
          await _updateToken(currentToken);
          debugPrint('Token updated successfully');
        } else {
          debugPrint('Current token is null, forcing refresh');
          await _messaging.deleteToken();
          final newToken = await _messaging.getToken();

          if (newToken != null) {
            _token = newToken;
            _lastTokenRefresh = DateTime.now();
            await _updateToken(newToken);
            debugPrint('Token refreshed successfully');
          } else {
            debugPrint('Failed to get new token during check');
          }
        }
      } else {
        debugPrint('Token is still valid, no refresh needed');

        // Update last active time in Firestore
        final user = _auth.currentUser;
        if (user != null) {
          await _firestore.collection('user_tokens').doc(user.uid).update({
            'lastActive': FieldValue.serverTimestamp(),
          });
          debugPrint('Updated last active time for token');
        }
      }
    } catch (e) {
      debugPrint('Error checking FCM token: $e');

      // Try to recover by getting a new token
      try {
        await _messaging.deleteToken();
        _token = await _messaging.getToken();

        if (_token != null) {
          _lastTokenRefresh = DateTime.now();
          await _updateToken(_token!);
          debugPrint('Token recovered after error');
        }
      } catch (recoveryError) {
        debugPrint('Error during token recovery: $recoveryError');
      }
    }
  }

  // Remove FCM tokens when user logs out
  Future<void> removeUserTokens() async {
    try {
      final user = _auth.currentUser;
      if (user == null) {
        debugPrint('Cannot remove tokens: No user is logged in');
        return;
      }

      final userId = user.uid;
      debugPrint('Removing FCM tokens for user: $userId');

      // Delete the current token from Firebase Messaging first
      try {
        await _messaging.deleteToken();
        debugPrint('FCM token deleted from device');
      } catch (e) {
        debugPrint('Error deleting FCM token from device: $e');
      }

      // Get the current token document
      final tokenDoc = await _firestore.collection('user_tokens').doc(userId).get();

      if (tokenDoc.exists) {
        // Update the document to clear tokens
        await _firestore.collection('user_tokens').doc(userId).set({
          'tokens': [],
          'lastActive': FieldValue.serverTimestamp(),
          'loggedOut': true,
          'loggedOutAt': FieldValue.serverTimestamp(),
        }, SetOptions(merge: true));

        debugPrint('FCM tokens removed for user: $userId');

        // Verify the update was successful
        final verifyDoc = await _firestore.collection('user_tokens').doc(userId).get();
        if (verifyDoc.exists) {
          final data = verifyDoc.data();
          final tokens = data?['tokens'] as List<dynamic>? ?? [];
          final loggedOut = data?['loggedOut'] as bool? ?? false;

          debugPrint('Verification after logout - Token count: ${tokens.length}, loggedOut: $loggedOut');

          if (!loggedOut || tokens.isNotEmpty) {
            debugPrint('WARNING: Tokens not properly cleared or loggedOut flag not set! Forcing update...');

            // Force update with direct set operation as a last resort
            await _firestore.collection('user_tokens').doc(userId).update({
              'tokens': [],
              'loggedOut': true,
            });

            debugPrint('Forced token removal');
          }
        }
      } else {
        debugPrint('No token document found for user: $userId');

        // Create a document with loggedOut set to true
        await _firestore.collection('user_tokens').doc(userId).set({
          'tokens': [],
          'loggedOut': true,
          'loggedOutAt': FieldValue.serverTimestamp(),
          'notificationPreferences': {
            'communityNotices': true,
            'socialInteractions': true,
            'marketplace': true,
            'chat': true,
            'reports': true,
            'volunteer': true,
          },
        });

        debugPrint('Created user_tokens document with loggedOut=true for user: $userId');
      }
    } catch (e) {
      debugPrint('Error removing FCM tokens: $e');

      // Last resort fallback
      try {
        final user = _auth.currentUser;
        if (user != null) {
          await _firestore.collection('user_tokens').doc(user.uid).update({
            'tokens': [],
            'loggedOut': true,
          });
          debugPrint('Used fallback method to remove tokens');
        }
      } catch (fallbackError) {
        debugPrint('Fallback token removal also failed: $fallbackError');
      }
    }
  }
}
