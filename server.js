/**
 * Pluto AI Platform - Backend (Node.js)
 * Update: Highly resilient browser discovery and instant-boot optimization.
 * This version specifically addresses the "/usr/bin/google-chrome-stable" not found error
 * by implementing a multi-strategy discovery engine.
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

// Render Port Binding: Standard is 10000, fallback to 3000 for local dev.
const PORT = process.env.PORT || 10000; 
const LLAMA_API_KEY = process.env.LLAMA_API_KEY;
const LLAMA_MODEL = process.env.LLAMA_MODEL || "llama-3.3-70b-versatile";
const LLAMA_API_URL = process.env.LLAMA_API_URL || "https://api.groq.com/openai/v1/chat/completions";

/**
 * Super-Resilient Browser Path Resolver
 * Performs a surgical scan of the container filesystem to find the Chrome binary.
 */
function resolveChromePath() {
    console.log("[Pluto Config] Initiating browser discovery sequence...");

    // 1. Check Environment Variable (Highest Priority)
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        console.log(`[Pluto Config] SUCCESS: Using path from ENV: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    // 2. Dynamic system search via 'which' (Highly effective on Linux)
    try {
        const dynamicPath = execSync('which google-chrome-stable || which google-chrome || which chromium || which chromium-browser').toString().trim();
        if (dynamicPath && fs.existsSync(dynamicPath)) {
            console.log(`[Pluto Config] SUCCESS: Dynamic discovery found binary at: ${dynamicPath}`);
            return dynamicPath;
        }
    } catch (e) {
        console.warn("[Pluto Config] System 'which' command yielded no results.");
    }

    // 3. Exhaustive hardcoded scan of common cloud/container paths
    const potentialPaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/opt/google/chrome/google-chrome',
        '/usr/local/bin/google-chrome',
        // Common Puppeteer cache subfolders in newer versions
        '/home/pptruser/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome',
        // General Render cache folder
        '/opt/render/.cache/puppeteer'
    ];

    for (const path of potentialPaths) {
        if (fs.existsSync(path)) {
            // Check if it's a directory (Render cache often maps the folder, not the binary)
            const stats = fs.lstatSync(path);
            if (stats.isFile()) {
                console.log(`[Pluto Config] SUCCESS: Found verified binary at: ${path}`);
                return path;
            }
        }
    }

    // 4. Emergency check for internal node_modules/puppeteer structure
    console.error("[Pluto Config] CRITICAL: Standard paths failed. Deployment may lack Chrome installation.");
    return '/usr/bin/google-chrome-stable'; // Last resort fallback
}

/**
 * Exponential Backoff Wrapper for Llama API
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
                body: JSON.stringify({
                    model: LLAMA_MODEL,
                    messages: messages,
                    temperature: 1.0, 
                    max_tokens: 8192, 
                    stream: false
                })
            });

            if ((response.status === 429 || response.status === 503) && i < retries - 1) {
                console.log(`[Pluto API] Rate limited. Retrying in ${defaultDelays[i]}ms...`);
                await new Promise(res => setTimeout(res, defaultDelays[i]));
                continue;
            }

            const result = await response.json();
            if (!response.ok) throw new Error(result.error?.message || `API Error: ${response.status}`);
            return result;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, defaultDelays[i]));
        }
    }
}

/**
 * Sanitize scraped content
 */
function sanitizeScrapedContent(text) {
    if (!text) return "";
    return text
        .replace(/Terms of Service|Privacy Policy|Cookie Preferences|Report conversation/gi, "")
        .replace(/[^\x20-\x7E\n]/g, " ") 
        .substring(0, 12000);
}

/**
 * Surgical Scraper - Optimized for Render Containers
 */
async function extractConversationData(url) {
    let browser;
    try {
        const chromePath = resolveChromePath();
        console.log(`[Pluto Scraper] Attempting to launch browser at ${chromePath}`);

        browser = await puppeteer.launch({ 
            executablePath: chromePath,
            headless: "new", 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', // Mandatory for Docker/Render
                '--disable-gpu',
                '--no-zygote',
                '--single-process', // Helps with resource constraints
                '--no-first-run'
            ] 
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Extended timeout for slow cloud network
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        const content = await page.evaluate(() => {
            const targets = ['.markdown.prose', '.message-content', 'article', 'main'];
            let data = [];
            targets.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    const text = el.innerText.trim();
                    if (text.length > 50) data.push(text);
                });
            });
            return data.length > 0 ? data.join('\n\n---\n\n') : document.body.innerText;
        });
        
        return sanitizeScrapedContent(content);
    } catch (e) {
        console.error(`[Scraper Fatal]: ${e.message}`);
        return `DATA_ERROR: Browser could not be initialized. Path: ${resolveChromePath()}`;
    } finally {
        if (browser) {
            await browser.close();
            console.log("[Pluto Scraper] Browser session closed.");
        }
    }
}

/** ROUTES **/

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).send('Pluto Backend Engine Live'));

app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    try {
        let foundation = "";
        if (links && links.length > 0) {
            const transcripts = await Promise.all(links.map(l => extractConversationData(l.url)));
            const combined = transcripts.join('\n\n');
            const result = await callLlamaWithRetry([
                { role: "system", content: "You are Pluto. Synthesize this research accurately." },
                { role: "user", content: `DATA:\n${combined}\n\nSESSION TITLE: ${title}` }
            ]);
            foundation = result.choices[0].message.content;
        } else {
            foundation = `Pluto initialized for: ${title || 'General Intelligence'}`;
        }
        res.json({ success: true, foundation });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/chat', async (req, res) => {
    const { foundation, history } = req.body;
    try {
        const lastMsg = history[history.length - 1].content;
        const result = await callLlamaWithRetry([
            { role: "system", content: `You are Pluto. Ground your answers in this foundation: ${foundation}` },
            { role: "user", content: lastMsg }
        ]);
        res.json({ success: true, reply: result.choices[0].message.content });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/** STARTUP **/

// Listen on 0.0.0.0 and PORT immediately to satisfy Render's readiness probe.
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Pluto Backend Active on port ${PORT}`);
    console.log(`[Startup] Expected Browser Path: ${resolveChromePath()}`);
});

// Set global timeout to 5 minutes to handle slow synthesis.
server.timeout = 300000;