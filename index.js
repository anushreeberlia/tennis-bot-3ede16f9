const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const puppeteer = require('puppeteer');
const { Expo } = require('expo-server-sdk');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/data.json';

app.use(cors());
app.use(express.json());

// Initialize Expo SDK
const expo = new Expo();

// In-memory storage for demo (in production, would use persistent DB)
let courtData = {
  lastCheck: null,
  availableCourts: [],
  logs: [],
  pushTokens: [],
  isMonitoring: true
};

// Ensure data directory exists and load existing data
async function initializeData() {
  try {
    const dataDir = path.dirname(DB_PATH);
    await fs.mkdir(dataDir, { recursive: true });
    
    try {
      const data = await fs.readFile(DB_PATH, 'utf8');
      courtData = { ...courtData, ...JSON.parse(data) };
      console.log('Loaded existing data from', DB_PATH);
    } catch (err) {
      console.log('No existing data found, starting fresh');
    }
  } catch (error) {
    console.error('Error initializing data:', error);
  }
}

// Save data to persistent storage
async function saveData() {
  try {
    await fs.writeFile(DB_PATH, JSON.stringify(courtData, null, 2));
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// Add log entry
function addLog(message, type = 'info') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    type
  };
  courtData.logs.unshift(logEntry);
  
  // Keep only last 100 logs
  if (courtData.logs.length > 100) {
    courtData.logs = courtData.logs.slice(0, 100);
  }
  
  console.log(`[${type.toUpperCase()}] ${message}`);
  saveData();
}

// Get upcoming Fridays
function getUpcomingFridays(count = 4) {
  const fridays = [];
  const today = new Date();
  let current = new Date(today);
  
  // Find next Friday
  const daysToFriday = (5 - current.getDay() + 7) % 7;
  if (daysToFriday === 0 && current.getHours() >= 18) {
    // If it's Friday evening, start from next Friday
    current.setDate(current.getDate() + 7);
  } else {
    current.setDate(current.getDate() + daysToFriday);
  }
  
  for (let i = 0; i < count; i++) {
    fridays.push(new Date(current));
    current.setDate(current.getDate() + 7);
  }
  
  return fridays;
}

// Scrape court availability
async function scrapeCourtAvailability() {
  let browser;
  try {
    addLog('Starting court availability check...');
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    addLog('Navigating to Joe DiMaggio tennis courts...');
    await page.goto('https://rec.us/joedimaggio', { waitUntil: 'networkidle2' });
    
    // Look for tennis courts
    await page.waitForTimeout(3000);
    
    // Try to find tennis-related elements
    const tennisElements = await page.evaluate(() => {
      const elements = [];
      const textNodes = document.querySelectorAll('*');
      
      for (let element of textNodes) {
        const text = element.textContent?.toLowerCase() || '';
        if (text.includes('tennis') || text.includes('court')) {
          elements.push({
            tag: element.tagName,
            text: element.textContent?.trim().substring(0, 100),
            className: element.className
          });
        }
      }
      
      return elements.slice(0, 10); // Limit results
    });
    
    addLog(`Found ${tennisElements.length} tennis-related elements`);
    
    // Look for availability buttons or booking links
    const availabilityData = await page.evaluate(() => {
      const bookingElements = [];
      const buttons = document.querySelectorAll('button, a, .booking, .available, .reserve');
      
      for (let element of buttons) {
        const text = element.textContent?.toLowerCase() || '';
        if (text.includes('book') || text.includes('reserve') || text.includes('available') || text.includes('friday')) {
          bookingElements.push({
            text: element.textContent?.trim().substring(0, 50),
            href: element.href || null,
            className: element.className,
            id: element.id
          });
        }
      }
      
      return bookingElements.slice(0, 20);
    });
    
    addLog(`Found ${availabilityData.length} potential booking elements`);
    
    // Simulate finding available courts (in real implementation, would parse actual availability)
    const upcomingFridays = getUpcomingFridays();
    const mockAvailableCourts = [];
    
    // Randomly simulate some availability for demo
    const currentHour = new Date().getHours();
    if (currentHour % 2 === 0) { // Mock availability every other hour
      mockAvailableCourts.push({
        date: upcomingFridays[0].toDateString(),
        time: '6:00 PM - 8:00 PM',
        court: 'Court 1',
        available: true
      });
    }
    
    if (currentHour % 3 === 0) {
      mockAvailableCourts.push({
        date: upcomingFridays[1].toDateString(),
        time: '7:00 PM - 9:00 PM',
        court: 'Court 2',
        available: true
      });
    }
    
    // Check if this is new availability
    const previousAvailable = courtData.availableCourts.length;
    const newAvailable = mockAvailableCourts.length;
    
    courtData.availableCourts = mockAvailableCourts;
    courtData.lastCheck = new Date().toISOString();
    
    if (newAvailable > previousAvailable) {
      addLog(`🎾 New courts available! Found ${newAvailable} available slots`, 'success');
      await sendPushNotifications(mockAvailableCourts);
    } else {
      addLog(`Check completed. ${newAvailable} courts available (no change)`);
    }
    
    await saveData();
    
  } catch (error) {
    addLog(`Error scraping courts: ${error.message}`, 'error');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Send push notifications
async function sendPushNotifications(availableCourts) {
  if (courtData.pushTokens.length === 0) {
    addLog('No push tokens registered, skipping notifications');
    return;
  }
  
  const messages = [];
  
  // Validate and filter tokens
  const validTokens = courtData.pushTokens.filter(token => {
    if (!Expo.isExpoPushToken(token)) {
      addLog(`Invalid push token found: ${token}`, 'error');
      return false;
    }
    return true;
  });
  
  if (validTokens.length === 0) {
    addLog('No valid push tokens found', 'error');
    return;
  }
  
  addLog(`Preparing to send notifications to ${validTokens.length} devices`);
  
  for (const token of validTokens) {
    messages.push({
      to: token,
      sound: 'default',
      title: '🎾 Tennis Courts Available!',
      body: `${availableCourts.length} courts available for upcoming Fridays at Joe DiMaggio`,
      data: { 
        availableCourts,
        timestamp: new Date().toISOString()
      },
      priority: 'high',
      channelId: 'default'
    });
  }
  
  try {
    const chunks = expo.chunkPushNotifications(messages);
    addLog(`Sending ${messages.length} notifications in ${chunks.length} chunks`);
    
    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        
        // Log results
        ticketChunk.forEach((ticket, index) => {
          if (ticket.status === 'error') {
            addLog(`Push notification error: ${ticket.message}`, 'error');
          } else {
            addLog(`Push notification sent successfully: ${ticket.id}`);
          }
        });
        
      } catch (chunkError) {
        addLog(`Error sending notification chunk: ${chunkError.message}`, 'error');
      }
    }
    
  } catch (error) {
    addLog(`Error preparing push notifications: ${error.message}`, 'error');
  }
}

// API Routes
app.get('/', (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  res.json({ 
    status: 'ok', 
    service: 'Court Monitor API',
    monitoring: courtData.isMonitoring,
    lastCheck: courtData.lastCheck,
    registeredTokens: courtData.pushTokens.length
  });
});

app.get('/api/status', (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  res.json({
    isMonitoring: courtData.isMonitoring,
    lastCheck: courtData.lastCheck,
    availableCourts: courtData.availableCourts.length,
    registeredDevices: courtData.pushTokens.length
  });
});

app.get('/api/courts', (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  res.json({
    courts: courtData.availableCourts,
    lastCheck: courtData.lastCheck
  });
});

app.get('/api/logs', (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  res.json({
    logs: courtData.logs.slice(0, 50) // Last 50 logs
  });
});

app.post('/api/register-push', (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    console.log(`${req.method} ${req.url} - 400`);
    return res.status(400).json({ error: 'Push token required' });
  }
  
  // Validate token format
  if (!Expo.isExpoPushToken(token)) {
    console.log(`${req.method} ${req.url} - 400`);
    return res.status(400).json({ error: 'Invalid push token format' });
  }
  
  if (!courtData.pushTokens.includes(token)) {
    courtData.pushTokens.push(token);
    addLog(`New device registered for notifications (${token.substring(0, 20)}...)`);
    saveData();
  } else {
    addLog(`Device token already registered (${token.substring(0, 20)}...)`);
  }
  
  console.log(`${req.method} ${req.url} - 200`);
  res.json({ success: true, totalTokens: courtData.pushTokens.length });
});

app.post('/api/toggle-monitoring', (req, res) => {
  courtData.isMonitoring = !courtData.isMonitoring;
  addLog(`Monitoring ${courtData.isMonitoring ? 'enabled' : 'disabled'}`);
  saveData();
  
  console.log(`${req.method} ${req.url} - 200`);
  res.json({ isMonitoring: courtData.isMonitoring });
});

app.post('/api/check-now', async (req, res) => {
  console.log(`${req.method} ${req.url} - 200`);
  res.json({ message: 'Check initiated', timestamp: new Date().toISOString() });
  
  // Run check in background
  scrapeCourtAvailability();
});

app.post('/api/test-notification', async (req, res) => {
  if (courtData.pushTokens.length === 0) {
    return res.status(400).json({ error: 'No registered devices' });
  }
  
  addLog('Sending test notifications...');
  
  const testCourts = [{
    date: 'Test Date',
    time: 'Test Time',
    court: 'Test Court',
    available: true
  }];
  
  await sendPushNotifications(testCourts);
  
  console.log(`${req.method} ${req.url} - 200`);
  res.json({ message: 'Test notifications sent', devices: courtData.pushTokens.length });
});

// Schedule court monitoring every 30 minutes
cron.schedule('*/30 * * * *', () => {
  if (courtData.isMonitoring) {
    addLog('Scheduled court check starting...');
    scrapeCourtAvailability();
  }
});

// Initialize and start server
async function start() {
  await initializeData();
  
  app.listen(PORT, () => {
    console.log(`Court Monitor API running on port ${PORT}`);
    addLog('Court Monitor API started');
    
    // Run initial check after 10 seconds
    setTimeout(() => {
      if (courtData.isMonitoring) {
        scrapeCourtAvailability();
      }
    }, 10000);
  });
}

start();