/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: A general-purpose AI assistant capable of research synthesis.
 * Integration: Environment-aware using .env for keys and configurations.
 * Fix: Optimized startup and robust multi-path browser detection.
 * Update: Enhanced self-healing browser discovery based on error analysis.
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

// Render expects the app to bind to process.env.PORT (default 10000)
const PORT = process.env.PORT || 10000; 
const LLAMA_API_KEY = process.env.LLAMA_API_KEY;
const LLAMA_MODEL = process.env.LLAMA_MODEL || "llama-3.3-70b-versatile";
const LLAMA_API_URL = process.env.LLAMA_API_URL || "https://api.groq.com/openai/v1/chat/completions";

/**
 * Robust Browser Path Resolver
 * Uses a combination of ENV checks, standard path scanning, and system commands.
 */
function resolveChromePath() {
    console.log("[Pluto Config] Initiating deep scan for browser binaries...");

    // 1. Check Environment Variable first
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    // 2. Try to locate via system 'which' command (Dynamic discovery)
    try {
        const dynamicPath = execSync('which google-chrome-stable || which google-chrome || which chromium').toString().trim();
        if (dynamicPath && fs.existsSync(dynamicPath)) {
            console.log(`[Pluto Config] Dynamic discovery found browser at: ${dynamicPath}`);
            return dynamicPath;
        }
    } catch (e) {
        console.warn("[Pluto Config] System 'which' command failed or no binary found.");
    }

    // 3. Fallback to exhaustive list of standard Linux paths
    const standardPaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/opt/google/chrome/google-chrome',
        '/usr/local/bin/google-chrome',
        '/usr/bin/google-chrome-unstable'
    ];

    for (const path of standardPaths) {
        if (fs.existsSync(path)) {
            console.log(`[Pluto Config] Found verified binary at: ${path}`);
            return path;
        }
    }

    // 4. Final attempt: Check Puppeteer's internal cache folder
    const internalCachePath = '/home/pptruser/.cache/puppeteer';
    if (fs.existsSync(internalCachePath)) {
        console.log("[Pluto Config] Found Puppeteer cache folder. Attempting internal use...");
    }

    console.error("[Pluto Config] CRITICAL: No Chrome executable found. Fallback to default.");
    return '/usr/bin/google-chrome-stable';
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
                    top_p: 1,
                    stream: false
                })
            });

            const result = await response.json();

            if ((response.status === 429 || response.status === 503) && i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, defaultDelays[i]));
                continue;
            }

            if (!response.ok) {
                throw new Error(result.error?.message || `API Error: ${response.status}`);
            }

            return result;
        } catch (fetchError) {
            if (i === retries - 1) throw fetchError;
            await new Promise(resolve => setTimeout(resolve, defaultDelays[i]));
        }
    }
}

function sanitizeScrapedContent(text) {
    if (!text) return "";
    return text
        .replace(/Terms of Service|Privacy Policy|Cookie Preferences|Report conversation|By messaging ChatGPT|Check important info|Sign in|Google|Docebo|LMS/gi, "")
        .replace(/pitfall|problem|issue|error|mistake/gi, "structural variation")
        .replace(/[^\x20-\x7E\n]/g, " ") 
        .substring(0, 10000);
}

/**
 * Surgical Scraper for AI Share Links
 */
async function extractConversationData(url) {
    let browser;
    try {
        const chromePath = resolveChromePath();
        console.log(`[Pluto Scraper] Launching: ${chromePath}`);

        browser = await puppeteer.launch({ 
            executablePath: chromePath,
            headless: "new", 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
                '--no-first-run',
                '--disable-extensions'
            ] 
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
        
        // Timeout handling for shared hosting
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        
        await page.waitForSelector('.markdown, .message-content, article', { timeout: 10000 }).catch(() => {
            console.warn("[Pluto Scraper] Standard selectors missed. Scraping whole body.");
        });

        const content = await page.evaluate(() => {
            const bubbles = ['.markdown.prose', '.message-content', 'div[id^="message-content"]', 'article div.flex-grow'];
            let data = [];
            bubbles.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    if (el.innerText.trim().length > 30) {
                        data.push(el.innerText.trim());
                    }
                });
            });
            return data.length === 0 ? document.body.innerText : data.join('\n\n---\n\n');
        });
        
        return sanitizeScrapedContent(content);
    } catch (e) {
        console.error(`[Scraper Fatal Error]: ${e.message}`);
        return `DATA_ERROR: ${e.message}`;
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * PHASE 1: WORKSPACE INITIALIZATION
 */
app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    if (!LLAMA_API_KEY) return res.status(500).json({ success: false, error: "API Key missing" });

    try {
        let foundation = "";
        if (links && links.length > 0 && links.some(l => l.url && l.url.trim() !== "")) {
            const transcripts = await Promise.all(
                links.filter(l => l.url && l.url.trim() !== "").map(l => extractConversationData(l.url))
            );
            const combinedData = transcripts.join('\n\n');

            const messages = [
                { role: "system", content: "You are Pluto, a highly advanced AI research assistant." },
                { role: "user", content: `DATA INPUT:\n${combinedData}\n\nTASK: Synthesize for session: "${title || 'Synthesis'}"` }
            ];

            const result = await callLlamaWithRetry(messages);
            foundation = result.choices?.[0]?.message?.content;
        } else {
            foundation = `Pluto initialized for session: ${title || 'Intelligence'}`;
        }

        res.json({ success: true, foundation });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PHASE 2: INTERACTIVE CHAT
 */
app.post('/api/chat', async (req, res) => {
    const { foundation, history } = req.body;
    try {
        const lastMsg = history[history.length - 1].content;
        const messages = [
            { role: "system", content: "You are Pluto, an intelligent AI. Use the FOUNDATION as grounding." },
            { role: "user", content: `FOUNDATION: ${foundation}\n\nQUERY: ${lastMsg}` }
        ];

        const result = await callLlamaWithRetry(messages);
        res.json({ success: true, reply: result.choices?.[0]?.message?.content });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health Checks
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).send('Pluto Engine Online'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Pluto Backend Active on port ${PORT}`);
});