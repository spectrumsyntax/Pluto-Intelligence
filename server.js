/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: A general-purpose AI assistant capable of research synthesis.
 * Update: Added self-healing browser discovery and diagnostic route.
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
    // 1. Priority: ENV variable
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    // 2. Priority: Standard Docker location for ghcr.io image
    const dockerPath = '/usr/bin/google-chrome-stable';
    if (fs.existsSync(dockerPath)) return dockerPath;

    // 3. Dynamic Discovery
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
 * Surgical Scraper
 */
async function extractConversationData(url) {
    let browser;
    try {
        const chromePath = resolveChromePath();
        console.log(`[Pluto Scraper] Attempting launch at: ${chromePath}`);
        
        browser = await puppeteer.launch({ 
            executablePath: chromePath,
            headless: "new", 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ] 
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        const content = await page.evaluate(() => {
            const targets = ['.markdown.prose', '.message-content', 'article'];
            let data = [];
            targets.forEach(s => {
                document.querySelectorAll(s).forEach(el => data.push(el.innerText.trim()));
            });
            return data.length > 0 ? data.join('\n\n') : document.body.innerText;
        });
        
        return content.substring(0, 10000);
    } catch (e) {
        console.error(`[Scraper Error]: ${e.message}`);
        return `ERROR: ${e.message}`;
    } finally {
        if (browser) await browser.close();
    }
}

/** ROUTES **/

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).send('Pluto Engine Active'));

// Diagnostic Route: Use this to see what's happening inside the container
app.get('/debug', (req, res) => {
    try {
        const binaryExists = fs.existsSync('/usr/bin/google-chrome-stable');
        const binFolder = fs.readdirSync('/usr/bin').filter(f => f.includes('chrome') || f.includes('chromium'));
        res.json({
            status: "online",
            port: PORT,
            binaryExists,
            browserBinariesInPath: binFolder,
            envPath: process.env.PUPPETEER_EXECUTABLE_PATH
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Pluto Backend Active on port ${PORT}`);
});