# Deploying PULSE Notification Backend to Digital Ocean

This guide will help you deploy your notification backend to Digital Ocean App Platform, which will keep your server running 24/7 without sleep issues (unlike Render's free tier).

## Prerequisites

- Digital Ocean account with $200 credit
- GitHub repository containing this code
- Firebase service account JSON file

## Deployment Options

### Option 1: Deploy via Digital Ocean App Platform UI (Recommended)

#### Step 1: Prepare Your Repository

1. **Commit and push your code to GitHub:**
   ```bash
   git add .
   git commit -m "Add report notifications and Digital Ocean config"
   git push origin main
   ```

#### Step 2: Create App on Digital Ocean

1. **Go to Digital Ocean Dashboard:**
   - Navigate to https://cloud.digitalocean.com/apps
   - Click "Create App"

2. **Connect GitHub Repository:**
   - Choose "GitHub" as source
   - Authorize Digital Ocean to access your repositories
   - Select your repository
   - Choose the branch (usually `main`)
   - **Important:** Set "Source Directory" to `/pulse_notification_backendd`

3. **Configure Resources:**
   - Type: Web Service
   - Name: `pulse-notification-backend`
   - Region: Singapore (closest to Asia/Manila)
   - Build Command: `npm install`
   - Run Command: `npm start`
   - HTTP Port: `3000`
   - HTTP Routes: `/`

4. **Add Environment Variables:**
   Click "Edit" next to environment variables and add:
   
   - `NODE_ENV` = `production`
   - `PORT` = `3000`
   - `FIREBASE_DATABASE_URL` = `https://pulse-app-ea5be-default-rtdb.asia-southeast1.firebasedatabase.app`
   - `FIREBASE_SERVICE_ACCOUNT_JSON` = `[PASTE YOUR ENTIRE SERVICE ACCOUNT JSON HERE]`
     - **Important:** This should be the entire JSON content from your service-account-key.json file
     - Mark this as "Secret" (encrypted)
     - Format: `{"type":"service_account","project_id":"pulse-app-ea5be",...}`

5. **Configure Plan:**
   - Select "Basic" plan
   - Choose "Basic XXS" ($5/month) - This is the smallest plan that stays always-on
   - With your $200 credit, this gives you 40 months of free hosting!

6. **Add Health Check:**
   - Path: `/health`
   - Initial Delay: 30 seconds
   - Period: 10 seconds
   - Timeout: 5 seconds

7. **Review and Create:**
   - Review all settings
   - Click "Create Resources"
   - Wait for deployment (usually 5-10 minutes)

#### Step 3: Get Your App URL

After deployment completes:
1. You'll get a URL like: `https://pulse-notification-backend-xxxxx.ondigitalocean.app`
2. Test the health endpoint: `https://your-app-url.ondigitalocean.app/health`
3. You should see: `{"status":"ok","timestamp":"..."}`

#### Step 4: Update Your Flutter App

Update your Flutter app to use the new Digital Ocean URL:

```dart
// In your notification service or config file
static const String notificationServerUrl = 
  'https://pulse-notification-backend-xxxxx.ondigitalocean.app';
```

---

### Option 2: Deploy via doctl CLI

#### Prerequisites
```bash
# Install doctl (Digital Ocean CLI)
# Windows (using Chocolatey):
choco install doctl

# Mac:
brew install doctl

# Linux:
cd ~
wget https://github.com/digitalocean/doctl/releases/download/v1.98.1/doctl-1.98.1-linux-amd64.tar.gz
tar xf doctl-1.98.1-linux-amd64.tar.gz
sudo mv doctl /usr/local/bin
```

#### Setup
```bash
# Authenticate
doctl auth init

# Enter your Digital Ocean API token when prompted
```

#### Deploy

1. **Update the app.yaml file:**
   Edit `pulse_notification_backendd/.do/app.yaml`:
   - Replace `YOUR_GITHUB_USERNAME/YOUR_REPO_NAME` with your actual repo
   - Ensure all paths are correct

2. **Create the app:**
   ```bash
   cd pulse_notification_backendd
   doctl apps create --spec .do/app.yaml
   ```

3. **Add the Firebase service account secret:**
   ```bash
   # Get your app ID from the previous command output
   APP_ID="your-app-id"
   
   # Set the secret
   doctl apps update $APP_ID --env FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
   ```

4. **Monitor deployment:**
   ```bash
   doctl apps list
   doctl apps logs $APP_ID --follow
   ```

---

## Cost Breakdown

With Digital Ocean's $200 credit:

- **Basic XXS Plan:** $5/month
- **Total months:** 40 months (~3.3 years)
- **Bandwidth:** 1TB included (more than enough for notifications)
- **Always-on:** No sleep/wake delays

### Comparison with Render Free Tier:

| Feature | Render Free | Digital Ocean Basic XXS |
|---------|-------------|------------------------|
| Sleep after inactivity | Yes (15 min) | **No - Always On** |
| Wake-up time | 30-60 seconds | Instant (no wake-up) |
| Monthly cost | $0 | $5 ($0 with credit) |
| Bandwidth | Limited | 1TB included |
| Reliability | Medium | High |

---

## Post-Deployment

### 1. Verify Notifications Are Working

Test each notification type:
```bash
# Test health endpoint
curl https://your-app-url.ondigitalocean.app/health

# Check logs in Digital Ocean dashboard
# Apps > Your App > Runtime Logs
```

### 2. Monitor Your App

- **Logs:** Apps > pulse-notification-backend > Runtime Logs
- **Metrics:** Monitor CPU, Memory, Bandwidth usage
- **Alerts:** Set up alerts for downtime or errors

### 3. Enable Auto-Deploy

In Digital Ocean:
- Go to Settings > App-Level
- Enable "Autodeploy" - Your app will redeploy automatically when you push to GitHub

### 4. Update Flutter App Configuration

```dart
class NotificationConfig {
  // OLD (Render - with sleep issues)
  // static const String baseUrl = 'https://pulse-notification.onrender.com';
  
  // NEW (Digital Ocean - always-on)
  static const String baseUrl = 'https://pulse-notification-backend-xxxxx.ondigitalocean.app';
  
  static const String registerTokenUrl = '$baseUrl/api/tokens/register';
  static const String updatePreferencesUrl = '$baseUrl/api/tokens/preferences';
}
```

---

## Troubleshooting

### App Won't Start

1. **Check logs in Digital Ocean dashboard**
2. **Verify environment variables:**
   - FIREBASE_SERVICE_ACCOUNT_JSON is properly formatted
   - No line breaks or extra spaces in the JSON

### Notifications Not Working

1. **Check server logs for errors**
2. **Verify Firebase credentials are correct**
3. **Test the health endpoint**
4. **Ensure Flutter app is using the new URL**

### High Costs

- Monitor bandwidth usage in Digital Ocean dashboard
- Basic XXS should be sufficient for most notification needs
- Consider upgrading only if you consistently hit resource limits

---

## Security Best Practices

1. **Never commit sensitive files:**
   - `.env` file
   - `service-account-key.json`
   - These are already in `.gitignore`

2. **Use environment variables for all secrets**

3. **Enable HTTPS (automatic with Digital Ocean)**

4. **Monitor access logs regularly**

5. **Set up alerts for unusual activity**

---

## Scaling Considerations

As your app grows:

1. **Monitor metrics:**
   - Response times
   - Memory usage
   - CPU usage

2. **Upgrade plan if needed:**
   - Basic XXS: Good for up to 1000 users
   - Basic XS: For 1000-5000 users
   - Basic S: For 5000+ users

3. **Consider adding:**
   - Redis for caching
   - Database for notification history
   - Load balancing for multiple instances

---

## Support

- Digital Ocean Docs: https://docs.digitalocean.com/products/app-platform/
- Community: https://www.digitalocean.com/community/
- Status Page: https://status.digitalocean.com/

---

## Summary

✅ **Benefits of Digital Ocean:**
- No sleep delays - instant notifications
- Reliable uptime
- Better performance
- 40 months free with $200 credit
- Easy monitoring and logs
- Auto-deployment from GitHub

🎯 **Your notification backend will now work perfectly with:**
- ✅ Community notices
- ✅ Volunteer posts
- ✅ **New reports (just added)**
- ✅ Report status updates
- ✅ All other notification types

No more waiting for the server to wake up! 🚀