const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin SDK
const initializeApp = () => {
  try {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './service-account-key.json';
    
    // Check if service account file exists
    if (!fs.existsSync(serviceAccountPath)) {
      console.error(`Service account file not found at ${serviceAccountPath}`);
      console.error('Please create a service account key file and place it in the correct location');
      process.exit(1);
    }
    
    // Initialize Firebase Admin SDK
    admin.initializeApp({
      credential: admin.credential.cert(require(path.resolve(serviceAccountPath))),
      databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://pulse-app-ea5be-default-rtdb.asia-southeast1.firebasedatabase.app'
    });
    
    console.log('Firebase Admin SDK initialized successfully');
    
    return admin;
  } catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error);
    process.exit(1);
  }
};

// Get Firestore instance
const getFirestore = () => admin.firestore();

// Get Realtime Database instance
const getDatabase = () => admin.database();

// Get Firebase Messaging instance
const getMessaging = () => admin.messaging();

module.exports = {
  initializeApp,
  getFirestore,
  getDatabase,
  getMessaging
};
