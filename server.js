/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: A general-purpose AI assistant capable of research synthesis.
 * Update: Increased navigation timeouts to 120s to resolve Render network delays.
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

// Render Port Binding
const PORT = process.env.PORT || 10000; 
const LLAMA_API_KEY = process.env.LLAMA_API_KEY;
const LLAMA_MODEL = process.env.LLAMA_MODEL || "llama-3.3-70b-versatile";
const LLAMA_API_URL = process.env.LLAMA_API_URL || "https://api.groq.com/openai/v1/chat/completions";

/**
 * Super-Resilient Browser Path Resolver
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
 * Surgical Scraper - Increased Timeout for Slow Connections
 */
async function extractConversationData(url) {
    let browser;
    try {
        const chromePath = resolveChromePath();
        console.log(`[Pluto Scraper] Launching: ${chromePath} for URL: ${url}`);

        browser = await puppeteer.launch({ 
            executablePath: chromePath,
            headless: "new", 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process'
            ] 
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
        
        // Timeout increased from 60s to 120s to allow for slow Render network speeds
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
        
        await page.waitForSelector('.markdown, .message-content, article', { timeout: 20000 }).catch(() => {
            console.warn("[Pluto Scraper] Selectors missed. Using body fallback.");
        });

        const content = await page.evaluate(() => {
            const targets = ['.markdown.prose', '.message-content', 'article'];
            let data = [];
            targets.forEach(s => {
                document.querySelectorAll(s).forEach(el => data.push(el.innerText.trim()));
            });
            return data.length > 0 ? data.join('\n\n') : document.body.innerText;
        });
        
        return sanitizeScrapedContent(content);
    } catch (e) {
        console.error(`[Scraper Error]: ${e.message}`);
        return `ERROR: ${e.message}`;
    } finally {
        if (browser) await browser.close();
    }
}

/** ROUTES **/

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).send('Pluto Backend Engine Active'));

app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    try {
        let foundation = "";
        if (links && links.length > 0) {
            const transcripts = await Promise.all(links.map(l => extractConversationData(l.url)));
            const combined = transcripts.join('\n\n');
            const result = await callLlamaWithRetry([
                { role: "system", content: "Synthesize research data accurately." },
                { role: "user", content: `DATA: ${combined}\n\nTITLE: ${title}` }
            ]);
            foundation = result.choices[0].message.content;
        } else {
            foundation = `Session: ${title || 'Intelligence'}`;
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
            { role: "system", content: `Grounding: ${foundation}` },
            { role: "user", content: lastMsg }
        ]);
        res.json({ success: true, reply: result.choices[0].message.content });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// STARTUP
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Pluto Backend Active on port ${PORT}`);
});