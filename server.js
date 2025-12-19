/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: A general-purpose AI assistant capable of research synthesis.
 * Update: Deep logging and optimized navigation strategy to prevent timeouts.
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
    console.log("[Pluto System] Resolving Chrome path...");
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const dockerPath = '/usr/bin/google-chrome-stable';
    if (fs.existsSync(dockerPath)) return dockerPath;

    try {
        const dynamicPath = execSync('which google-chrome-stable || which google-chrome || which chromium').toString().trim();
        if (dynamicPath && fs.existsSync(dynamicPath)) return dynamicPath;
    } catch (e) {
        console.warn("[Pluto System] Dynamic path discovery failed.");
    }

    return dockerPath;
}

/**
 * Exponential Backoff Wrapper for Llama API
 */
async function callLlamaWithRetry(messages, retries = 5) {
    const defaultDelays = [1000, 2000, 4000, 8000, 16000];
    console.log(`[Pluto AI] Requesting synthesis from ${LLAMA_MODEL}...`);
    
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
                console.warn(`[Pluto AI] Rate limited. Retrying in ${defaultDelays[i]}ms...`);
                await new Promise(res => setTimeout(res, defaultDelays[i]));
                continue;
            }

            const result = await response.json();
            if (!response.ok) throw new Error(result.error?.message || `API Error: ${response.status}`);
            
            console.log("[Pluto AI] Response received successfully.");
            return result;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, defaultDelays[i]));
        }
    }
}

/**
 * Surgical Scraper - Advanced Logging & Optimized Navigation
 */
async function extractConversationData(url) {
    let browser;
    const sessionID = Math.random().toString(36).substring(7);
    try {
        const chromePath = resolveChromePath();
        console.log(`[Scraper][${sessionID}] Starting extraction for: ${url}`);

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
        
        console.log(`[Scraper][${sessionID}] Navigating... (Timeout: 120s)`);
        
        // Strategy change: Use 'domcontentloaded' instead of 'networkidle2' 
        // to get the text even if tracking scripts are hanging.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        
        console.log(`[Scraper][${sessionID}] Page reached. Waiting for text elements...`);
        
        // Short wait for any dynamic content to settle
        await new Promise(r => setTimeout(r, 2000));

        const content = await page.evaluate(() => {
            const targets = ['.markdown.prose', '.message-content', 'article', 'main'];
            let data = [];
            targets.forEach(s => {
                document.querySelectorAll(s).forEach(el => data.push(el.innerText.trim()));
            });
            return data.length > 0 ? data.join('\n\n') : document.body.innerText;
        });
        
        const preview = content.substring(0, 100).replace(/\n/g, ' ');
        console.log(`[Scraper][${sessionID}] Success! Extracted: "${preview}..."`);
        
        return content.substring(0, 15000);
    } catch (e) {
        console.error(`[Scraper][${sessionID}] FAILED: ${e.message}`);
        return `ERROR: ${e.message}`;
    } finally {
        if (browser) {
            console.log(`[Scraper][${sessionID}] Closing browser session.`);
            await browser.close();
        }
    }
}

/** ROUTES **/

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).send('Pluto Backend Engine Active'));

app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    console.log(`[Pluto Router] Init Request - Title: ${title}, Links: ${links?.length || 0}`);

    try {
        let foundation = "";
        if (links && links.length > 0) {
            const transcripts = await Promise.all(links.map(l => extractConversationData(l.url)));
            const combined = transcripts.join('\n\n');
            
            console.log("[Pluto Logic] Passing combined data to AI for synthesis...");
            const result = await callLlamaWithRetry([
                { role: "system", content: "Synthesize research data accurately into a technical summary." },
                { role: "user", content: `DATA: ${combined}\n\nTITLE: ${title}` }
            ]);
            foundation = result.choices[0].message.content;
        } else {
            foundation = `Session: ${title || 'Intelligence'}`;
        }
        res.json({ success: true, foundation });
    } catch (e) {
        console.error(`[Pluto Router Error] /api/initialize: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/chat', async (req, res) => {
    const { foundation, history } = req.body;
    try {
        const lastMsg = history[history.length - 1].content;
        console.log(`[Pluto Router] Chat Request - History length: ${history.length}`);
        
        const result = await callLlamaWithRetry([
            { role: "system", content: `Grounding: ${foundation}` },
            { role: "user", content: lastMsg }
        ]);
        res.json({ success: true, reply: result.choices[0].message.content });
    } catch (e) {
        console.error(`[Pluto Router Error] /api/chat: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log("--------------------------------------------------");
    console.log(`🚀 Pluto Backend Active on port ${PORT}`);
    console.log("--------------------------------------------------");
});