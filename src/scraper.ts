import fs from 'fs';
import puppeteer, { Browser, Page } from 'puppeteer-extra';
import assert from 'assert';
import cron from 'node-cron';
import twilio from 'twilio';
import dotenv from 'dotenv';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin())

// Load environment variables
dotenv.config();

const getEnvVar = (name: string): string => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

// const ZARA_URL = getEnvVar('ZARA_URL');
const ZARA_URL = 'https://www.zara.com/us/en/carpenter-pocket-pants-p04676401.html?v1=381227758'

console.log(ZARA_URL)

// Twilio configuration
const accountSid = getEnvVar('TWILIO_ACCOUNT_SID');
const authToken = getEnvVar('TWILIO_AUTH_TOKEN');
const twilioPhoneNumber = getEnvVar('TWILIO_PHONE_NUMBER');
const yourPhoneNumber = getEnvVar('YOUR_PHONE_NUMBER');

const twilioClient = twilio(accountSid, authToken);

interface SizeInfo {
  size: string;
  inStock: boolean;
}

let lastStockStatus = "unset";
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5

async function sendSMS(message: string) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: twilioPhoneNumber,
      to: yourPhoneNumber
    });
    console.log('SMS sent successfully');
  } catch (error) {
    console.error('Error sending SMS:', error);
  }
}

async function checkStock(): Promise<void> {
  let browser: Browser | null = null;
  
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
      // headless: false
    });
    const page: Page = await browser.newPage();
    
    await page.goto(ZARA_URL, { waitUntil: 'networkidle0' });
    fs.writeFileSync('/tmp/test.html', await page.content());
    
    const sizeInfos: SizeInfo[] = await page.$$eval('.size-selector-list__item', (elements) =>
      elements.map((element) => ({
        size: element.querySelector('.product-size-info__main-label')?.textContent?.trim() || 'Unknown',
        inStock: !element.classList.contains('size-selector-list__item--out-of-stock'),
      }))
    );
    
    const size30Status = sizeInfos.find(({ size }) => size.includes('30'));
    assert(size30Status, `Size 30 information not found, ${JSON.stringify(sizeInfos, null, 2)}`);

    if (size30Status.inStock) {
      console.log('Size 30 is in stock!');
      await sendSMS('Size 30 is now in stock at Zara! Check the link: ' + ZARA_URL);
      process.exit(0);
    }

    const stockStatus: string[] = sizeInfos.map(({ size, inStock }) => `${size}: ${inStock ? 'In Stock' : 'Out of Stock'}`);
    const stockStatusString: string = stockStatus.join('\n');

    lastStockStatus = stockStatusString;
    consecutiveErrors = 0; // Reset error count on successful check
  } catch (error) {
    console.error('Error occurred while scraping:', error);
    consecutiveErrors++;
    
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      const errorMessage = `Error occurred ${MAX_CONSECUTIVE_ERRORS} times in a row. Last error: ${error}`;
      console.error(errorMessage);
      await sendSMS(errorMessage);
      process.exit(1);
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

let statusUpdateStarted = false

// Run the stock check every minute
cron.schedule(process.env.CHECK_CRON || '* * * * *', () => {
  console.log('Running stock check...');
  checkStock().then(() => {
    if (!statusUpdateStarted) {
        statusUpdateStarted = true
        // cron.schedule('* * * * *', async () => {
        cron.schedule('0 18 * * *', async () => {
            console.log('Sending last stock status...');
            if (!lastStockStatus) return
            await sendSMS('Daily Zara stock update:\n' + lastStockStatus);
        });
    }
  });
});

// Send a text with the last stock status every 24 hours at 6pm
// cron.schedule('0 18 * * *', async () => {
// cron.schedule('* * * * *', async () => {
//     console.log('Sending last stock status...');
//     if (!lastStockStatus) return
//     await sendSMS('Daily Zara stock update:\n' + lastStockStatus);
// });

// Initial startup
async function startup() {
  console.log('Starting Zara Stock Checker');
  await sendSMS('Zara Stock Checker has started.');
  await checkStock();
}

startup();