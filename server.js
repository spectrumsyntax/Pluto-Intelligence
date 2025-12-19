/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: A general-purpose AI assistant capable of research synthesis.
 * Fix: Deep-Scrape logic for Gemini/ChatGPT to bypass legal boilerplate.
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
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process'] 
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Use 'networkidle2' to wait for all background scripts to stop
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Extra 8s for React/Next.js content hydration
        await new Promise(r => setTimeout(r, 8000));

        const content = await page.evaluate(() => {
            // Broad but specific selectors for AI chat apps
            const selectors = [
                '.markdown', 
                '.message-content', 
                '.model-response-text',
                'div[data-message-author-role]',
                'article',
                '.p-4.md\\:p-6'
            ];
            
            let data = [];
            selectors.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    const txt = el.innerText.trim();
                    // Ignore short strings that are likely UI labels
                    if (txt.length > 50) data.push(txt);
                });
            });
            
            // If no specific bubbles found, try grabbing the main content area but skip nav/footers
            if (data.length === 0) {
                const main = document.querySelector('main');
                if (main && main.innerText.length > 200) return main.innerText;
                return "SCRAPE_FAILURE: No chat bubbles detected.";
            }
            return data.join('\n\n---\n\n');
        });
        
        await browser.close();
        
        const final = sanitizeScrapedContent(content);
        // If the result is just the website's legal footer, mark as failure
        if (final.length < 300 || final.toLowerCase().includes('terms of service')) {
            return "DATA_ERROR: Failed to bypass login/legal wall.";
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
            const combinedData = transcripts.join('\n\n');

            if (combinedData.includes("DATA_ERROR") || combinedData.length < 400) {
                throw new Error("Pluto could not access the chat content. Please ensure your links are 'Public' share links and not your private URL.");
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