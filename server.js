/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: General-purpose AI Research & Synthesis Engine.
 * Logic: Scrapes AI share links, synthesizes context, and enables interactive chat.
 * Concurrency Fix: Added a "Scrape Queue" to prevent Render from crashing when multiple users hit the server.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const puppeteer = require('puppeteer'); 
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const LLAMA_API_KEY = process.env.LLAMA_API_KEY;
const LLAMA_MODEL = process.env.LLAMA_MODEL || "llama-3.3-70b-versatile";
const LLAMA_API_URL = process.env.LLAMA_API_URL || "https://api.groq.com/openai/v1/chat/completions";

// Global browser instance
let globalBrowser = null;

/**
 * CONCURRENCY QUEUE LOGIC
 * Render Free/Starter tiers have very low RAM. 
 * We use a "Lock" to ensure only 1 or 2 pages are being scraped at a time globally.
 */
let activeScrapes = 0;
const MAX_CONCURRENT_SCRAPES = 1; // Safest for Render memory

async function waitForTurn() {
    while (activeScrapes >= MAX_CONCURRENT_SCRAPES) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    activeScrapes++;
}

/**
 * Resolve Chrome Path for Render/Docker environment
 */
function resolveChromePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const dockerPath = '/usr/bin/google-chrome-stable';
    if (fs.existsSync(dockerPath)) return dockerPath;
    try {
        const dynamicPath = execSync('which google-chrome-stable || which google-chrome || which chromium').toString().trim();
        if (dynamicPath && fs.existsSync(dynamicPath)) return dynamicPath;
    } catch (e) {}
    return dockerPath;
}

/**
 * Get or launch the shared browser instance.
 */
async function getBrowser() {
    if (globalBrowser && globalBrowser.isConnected()) {
        return globalBrowser;
    }
    const chromePath = resolveChromePath();
    globalBrowser = await puppeteer.launch({ 
        executablePath: chromePath,
        headless: "new", 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--no-zygote', 
            '--single-process',
            '--disable-gpu'
        ] 
    });
    return globalBrowser;
}

/**
 * AI Call with Exponential Backoff
 */
async function callLlamaWithRetry(messages, retries = 5) {
    const defaultDelays = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(LLAMA_API_URL, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${LLAMA_API_KEY}`
                },
                body: JSON.stringify({ model: LLAMA_MODEL, messages, temperature: 0.7, max_tokens: 8192 })
            });
            const result = await response.json();
            if ((response.status === 429 || response.status === 503) && i < retries - 1) {
                await new Promise(res => setTimeout(res, defaultDelays[i]));
                continue;
            }
            if (!response.ok) throw new Error(result.error?.message || `API Error: ${response.status}`);
            return result;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, defaultDelays[i]));
        }
    }
}

function sanitizeScrapedContent(text) {
    if (!text) return "";
    return text
        .replace(/Terms of Service|Privacy Policy|Cookie Preferences|Report conversation|By messaging ChatGPT|Check important info|Sign in|Explore our other|Try Gemini|Try ChatGPT|Verify you are human/gi, "")
        .replace(/[^\x20-\x7E\n]/g, " ") 
        .trim()
        .substring(0, 18000);
}

/**
 * Surgical Scraper - Uses queuing to manage memory
 */
async function extractConversationData(url) {
    let page;
    // Wait for other users' scrapes to finish to save memory
    await waitForTurn();
    
    try {
        const browser = await getBrowser();
        console.log(`[Pluto Scraper] Scraping: ${url}`);
        
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Block images and CSS to save massive amounts of RAM
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Auto-scroll logic
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 200;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if(totalHeight >= scrollHeight){
                        clearInterval(timer);
                        resolve();
                    }
                }, 150);
            });
        });

        await new Promise(r => setTimeout(r, 4000));

        const result = await page.evaluate(() => {
            const selectors = [
                '.markdown', '.message-content', '.model-response-text',
                'div[data-message-author-role]', 'article', '.p-4.md\\:p-6',
                '.conversation-container', 'div[class*="message"]', 'div[class*="content"]', 'main' 
            ];
            let data = [];
            selectors.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    const txt = el.innerText.trim();
                    if (txt.length > 60) data.push(txt);
                });
            });
            return { content: data.join('\n\n---\n\n'), title: document.title };
        });
        
        await page.close();
        activeScrapes--; // Release the lock
        return sanitizeScrapedContent(result.content);
    } catch (e) {
        if (page) await page.close();
        activeScrapes--; // Release the lock even on error
        return `DATA_ERROR: ${e.message}`;
    }
}

app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    try {
        let foundation = "";
        if (links && links.length > 0) {
            // We use a regular loop instead of Promise.all to prevent simultaneous memory spikes
            const transcripts = [];
            for (const l of links) {
                if (l.url) transcripts.push(await extractConversationData(l.url));
            }
            
            const validData = transcripts.filter(t => !t.startsWith("DATA_ERROR")).join('\n\n');

            if (validData.length < 200) {
                const errorLog = transcripts.find(t => t.startsWith("DATA_ERROR")) || "No content found.";
                throw new Error(`Extraction Failed: ${errorLog}`);
            }

            const result = await callLlamaWithRetry([
                { 
                    role: "system", 
                    content: `You are Pluto Intelligence, an elite research synthesizer developed by Spectrum SyntaX. 
                    Guidelines: Created by Spectrum SyntaX. Gen Z mix for intro/outro only. Technical clarity for content. No meta-info.` 
                },
                { 
                    role: "user", 
                    content: `DATA:\n${validData}\n\nTOPIC: ${title}\n\nTASK: Provide a unified content summary and master briefing.` 
                }
            ]);
            foundation = result.choices?.[0]?.message?.content;
        } 
        else {
            const result = await callLlamaWithRetry([
                { role: "system", content: "You are Pluto, developed by Spectrum SyntaX. Greet the user with a Gen Z mix. Stay professional for technical queries." },
                { role: "user", content: `SESSION TITLE: ${title}` }
            ]);
            foundation = result.choices?.[0]?.message?.content;
        }
        res.json({ success: true, foundation });
    } catch (error) {
        console.error(`[Pluto Error] ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/chat', async (req, res) => {
    const { foundation, history } = req.body;
    try {
        const lastMsg = history[history.length - 1].content;
        const result = await callLlamaWithRetry([
            { role: "system", content: `You are Pluto Intelligence by Spectrum SyntaX. Grounded in the foundation. Professional for content, Gen Z for vibes.` },
            { role: "user", content: `KNOWLEDGE: ${foundation}\n\nUSER: ${lastMsg}` }
        ]);
        res.json({ success: true, reply: result.choices?.[0]?.message?.content });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Pluto Backend Active on port ${PORT}`));