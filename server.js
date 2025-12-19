/**
 * Pluto AI Platform - Backend (Node.js)
 * Update: Specialized selectors for ChatGPT and Gemini shared links.
 * Added logic to filter out "Terms of Service" and "Privacy Policy" boilerplate.
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

async function callLlamaWithRetry(messages, retries = 5) {
    const defaultDelays = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(LLAMA_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLAMA_API_KEY}` },
                body: JSON.stringify({ model: LLAMA_MODEL, messages, temperature: 0.7, max_tokens: 8192 })
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
 * Filter out legal boilerplate and noise
 */
function cleanContent(text) {
    if (!text) return "";
    // Remove typical legal boilerplate from AI shared pages
    const filtered = text
        .replace(/Terms of Service|Privacy Policy|Cookie Preferences|Report conversation|Sign in|Login|All rights reserved|©|Copyright|By messaging ChatGPT|Verify you are human/gi, "")
        .replace(/[^\x20-\x7E\n]/g, " ") 
        .trim();
    
    return filtered.substring(0, 15000);
}

async function extractConversationData(url) {
    let browser;
    const sessionID = Math.random().toString(36).substring(7);
    try {
        const chromePath = resolveChromePath();
        console.log(`[Scraper][${sessionID}] Scraping AI Share Link: ${url}`);

        browser = await puppeteer.launch({ 
            executablePath: chromePath, 
            headless: "new", 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'] 
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Wait for page load
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        
        // ChatGPT and Gemini pages often take extra time to hydrate the chat bubbles
        await new Promise(r => setTimeout(r, 6000));

        const content = await page.evaluate(() => {
            // Specialized selectors for AI platforms:
            // .markdown is ChatGPT, .conversation-container is common for exports, 
            // .model-response-text is Gemini, .message-content is general
            const chatSelectors = [
                '.markdown', 
                '.message-content', 
                '.conversation-container', 
                '.model-response-text',
                '.p-4.md\\:p-6', // ChatGPT shared bubble wrapper
                'div[data-message-author-role]' // ChatGPT specific
            ];
            
            let data = [];
            chatSelectors.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    const txt = el.innerText.trim();
                    if (txt.length > 20) data.push(txt);
                });
            });

            // If we found specific chat bubbles, use them. Otherwise, fall back to body but with less priority.
            if (data.length > 0) {
                return data.join('\n\n---\n\n');
            }
            
            // Fallback: search for any div that might contain long text but skip nav/footer
            const bodyText = Array.from(document.querySelectorAll('div'))
                .filter(div => div.innerText.length > 100 && !['NAV', 'FOOTER', 'HEADER'].includes(div.parentElement.tagName))
                .map(div => div.innerText)
                .join('\n\n');

            return bodyText || document.body.innerText;
        });
        
        return cleanContent(content);
    } catch (e) {
        console.error(`[Scraper][${sessionID}] FAILED: ${e.message}`);
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
            
            // Verify we actually got content and not just "ERROR" or legal boilerplate
            if (combined.length < 200 || combined.toLowerCase().includes('error')) {
                throw new Error("Could not extract enough meaningful chat content from the links provided. Please ensure the share links are public.");
            }

            const result = await callLlamaWithRetry([
                { role: "system", content: "You are Pluto. Synthesize the provided ChatGPT/Gemini conversation into a helpful research summary. Focus only on the content of the chat, ignore all legal notices or UI text." },
                { role: "user", content: `DATA:\n${combined}\n\nTITLE: ${title}` }
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