/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: A general-purpose AI assistant capable of research synthesis.
 * Fix: Relaxed validation to allow content with legal footers and improved selectors.
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

/**
 * Enhanced cleaning to remove legal noise specifically from Gemini/ChatGPT
 */
function sanitizeScrapedContent(text) {
    if (!text) return "";
    return text
        .replace(/Terms of Service|Privacy Policy|Cookie Preferences|Report conversation|By messaging ChatGPT|Check important info|Sign in|Google|Explore our other|Try Gemini|Try ChatGPT|Verify you are human/gi, "")
        .replace(/[^\x20-\x7E\n]/g, " ") 
        .trim()
        .substring(0, 15000);
}

/**
 * Surgical Scraper - Optimized for SPA (Single Page App) Hydration
 */
async function extractConversationData(url) {
    let browser;
    try {
        const chromePath = resolveChromePath();
        console.log(`[Pluto Scraper] Targeting AI Link: ${url}`);
        
        browser = await puppeteer.launch({ 
            executablePath: chromePath,
            headless: "new", 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--no-zygote', 
                '--single-process',
                '--window-size=1920,1080'
            ] 
        });

        const page = await browser.newPage();
        // Set a more modern desktop user agent to avoid being flagged as a bot
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Wait for page load
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
        
        // Extra time for AI content to render bubbles after the network is idle
        await new Promise(r => setTimeout(r, 10000));

        const content = await page.evaluate(() => {
            const selectors = [
                '.markdown', 
                '.message-content', 
                '.model-response-text',
                'div[data-message-author-role]',
                'article',
                '.p-4.md\\:p-6',
                '.conversation-container',
                'main' // Ultimate fallback
            ];
            
            let data = [];
            selectors.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    const txt = el.innerText.trim();
                    // Increased length check to ensure we grab real sentences
                    if (txt.length > 60) data.push(txt);
                });
            });
            
            if (data.length === 0) {
                return "SCRAPE_FAILURE: No substantial content bubbles detected.";
            }
            return data.join('\n\n---\n\n');
        });
        
        await browser.close();
        
        const final = sanitizeScrapedContent(content);
        
        // Relaxed validation: Just check if we actually found substantial text
        // (Removing the check for "terms of service" because it exists in the footer of successful pages)
        if (final.length < 350 || final.includes("SCRAPE_FAILURE")) {
            console.error(`[Pluto Scraper] Insufficient content found for ${url}. Length: ${final.length}`);
            return "DATA_ERROR: Failed to extract meaningful content from the page.";
        }
        
        return final;
    } catch (e) {
        if (browser) await browser.close();
        return `DATA_ERROR: ${e.message}`;
    }
}

app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    try {
        let foundation = "";
        if (links && links.length > 0) {
            const transcripts = await Promise.all(
                links.filter(l => l.url).map(l => extractConversationData(l.url))
            );
            
            // Filter out individual data errors but try to keep what worked
            const validTranscripts = transcripts.filter(t => !t.startsWith("DATA_ERROR"));
            const combinedData = validTranscripts.join('\n\n');

            if (combinedData.length < 400) {
                throw new Error("Pluto could not extract enough meaningful chat content from the links. Please ensure the links are set to 'Public' and contain text-based conversation.");
            }

            const result = await callLlamaWithRetry([
                { role: "system", content: "You are Pluto. Synthesize the research data into a technical summary. IGNORE legal notices, login prompts, and UI buttons. Focus ONLY on the actual conversation content." },
                { role: "user", content: `DATA:\n${combinedData}\n\nTASK: Synthesize for: "${title}"` }
            ]);
            foundation = result.choices?.[0]?.message?.content;
        } else {
            const result = await callLlamaWithRetry([
                { role: "system", content: "Greet the user to a new session." },
                { role: "user", content: `Title: ${title}` }
            ]);
            foundation = result.choices?.[0]?.message?.content;
        }
        res.json({ success: true, foundation });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/chat', async (req, res) => {
    const { foundation, history } = req.body;
    try {
        const lastMsg = history[history.length - 1].content;
        const result = await callLlamaWithRetry([
            { role: "system", content: `Context: ${foundation}` },
            { role: "user", content: lastMsg }
        ]);
        res.json({ success: true, reply: result.choices?.[0]?.message?.content });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Pluto Backend Active on port ${PORT}`));