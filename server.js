/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: A general-purpose AI assistant capable of research synthesis.
 * Integration: Environment-aware using .env for keys and configurations.
 * Fix: Robust multi-path browser detection and deep logging for Linux.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const puppeteer = require('puppeteer'); 
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Load configurations from .env
const PORT = process.env.PORT || 10000; // Render default
const LLAMA_API_KEY = process.env.LLAMA_API_KEY;
const LLAMA_MODEL = process.env.LLAMA_MODEL || "llama-3.3-70b-versatile";
const LLAMA_API_URL = process.env.LLAMA_API_URL || "https://api.groq.com/openai/v1/chat/completions";

/**
 * Robust Browser Path Resolver
 * Performs a deep scan of the system to find any usable Chrome/Chromium binary.
 */
function resolveChromePath() {
    console.log("[Pluto Config] Starting browser path resolution...");
    
    // 1. Check Environment Variable
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        if (fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
            console.log(`[Pluto Config] Using path from ENV: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
            return process.env.PUPPETEER_EXECUTABLE_PATH;
        } else {
            console.warn(`[Pluto Config] ENV path defined but NOT FOUND: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
        }
    }

    // 2. Scan Standard Linux Locations
    const standardPaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/opt/google/chrome/google-chrome',
        '/usr/local/bin/google-chrome'
    ];

    for (const path of standardPaths) {
        if (fs.existsSync(path)) {
            console.log(`[Pluto Config] Valid browser binary located at: ${path}`);
            return path;
        }
    }

    // 3. Last Resort Fallback
    console.error("[Pluto Config] CRITICAL: No browser binaries found in standard locations.");
    return '/usr/bin/google-chrome-stable';
}

/**
 * Exponential Backoff Wrapper for Llama API (OpenAI Compatible)
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
                let waitTime = defaultDelays[i];
                console.log(`[Pluto] API busy or rate limited. Retrying in ${Math.round(waitTime/1000)}s...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
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

/**
 * Sanitize text to remove platform boilerplate and legal noise
 */
function sanitizeScrapedContent(text) {
    if (!text) return "";
    return text
        .replace(/Terms of Service|Privacy Policy|Cookie Preferences|Report conversation|By messaging ChatGPT|Check important info|Sign in|Google|Docebo|LMS/gi, "")
        .replace(/pitfall|problem|issue|error|mistake/gi, "structural variation")
        .replace(/[^\x20-\x7E\n]/g, " ") 
        .substring(0, 10000);
}

/**
 * Surgical Scraper for AI Share Links (Gemini & ChatGPT)
 */
async function extractConversationData(url) {
    let browser;
    try {
        const chromePath = resolveChromePath();
        console.log(`[Pluto Scraper] Launching browser at ${chromePath} for URL: ${url}`);

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
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait for content selectors
        await page.waitForSelector('.markdown, .message-content, article', { timeout: 15000 }).catch(() => {
            console.warn("[Pluto Scraper] Content selectors not found, falling back to body text.");
        });

        const content = await page.evaluate(() => {
            const bubbles = ['.markdown.prose', '.message-content', 'div[id^="message-content"]', 'article div.flex-grow'];
            const ignore = ['footer', 'nav', 'header', 'aside', 'button'];
            
            let data = [];
            bubbles.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    if (!ignore.some(n => el.closest(n)) && el.innerText.trim().length > 30) {
                        data.push(el.innerText.trim());
                    }
                });
            });
            
            if (data.length === 0) {
                const main = document.querySelector('main');
                return main ? main.innerText : "SCRAPE_FAILURE";
            }
            return data.join('\n\n---\n\n');
        });
        
        return sanitizeScrapedContent(content);
    } catch (e) {
        console.error(`[Scraper Error]: ${e.message}`);
        return `DATA_ERROR: ${e.message}`;
    } finally {
        if (browser) {
            await browser.close();
            console.log("[Pluto Scraper] Browser closed.");
        }
    }
}

/**
 * PHASE 1: WORKSPACE INITIALIZATION
 */
app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    if (!LLAMA_API_KEY) return res.status(500).json({ success: false, error: "Llama API Key missing in environment" });

    try {
        let foundation = "";

        if (links && links.length > 0 && links.some(l => l.url && l.url.trim() !== "")) {
            const transcripts = await Promise.all(
                links.filter(l => l.url && l.url.trim() !== "").map(l => extractConversationData(l.url))
            );
            const combinedData = transcripts.join('\n\n');

            const messages = [
                { 
                    role: "system", 
                    content: "You are Pluto, a highly advanced AI research assistant. Your primary goal is to synthesize the provided data while acting as a comprehensive knowledge engine. You skip pleasantries and provide a deep, technical summary as the first message." 
                },
                { 
                    role: "user", 
                    content: `DATA INPUT:\n${combinedData}\n\nTASK: Synthesize the research content above for the session: "${title || 'Pluto-X Synthesis'}".` 
                }
            ];

            const result = await callLlamaWithRetry(messages);
            foundation = result.choices?.[0]?.message?.content;
        } 
        else {
            const messages = [
                { 
                    role: "system", 
                    content: "You are Pluto, a highly advanced and helpful AI assistant. A user has started a new chat session. Your task is to greet them professionally, acknowledge the session title if relevant, and state that you are ready to assist with any topic using your full knowledge base. Be intelligent, welcoming, and direct." 
                },
                { 
                    role: "user", 
                    content: `GREETING TASK: Provide a welcoming opening for a new session titled: "${title || 'Pluto Intelligence'}".` 
                }
            ];

            const result = await callLlamaWithRetry(messages);
            foundation = result.choices?.[0]?.message?.content || "Pluto is online. How can I assist you today?";
        }

        if (!foundation) throw new Error("AI failed to initialize.");
        res.json({ success: true, foundation });
    } catch (error) {
        console.error("[Pluto Init Error]:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PHASE 2: INTERACTIVE CHAT
 */
app.post('/api/chat', async (req, res) => {
    const { foundation, history } = req.body;
    if (!LLAMA_API_KEY) return res.status(500).json({ success: false, error: "API Key missing" });

    try {
        const lastMsg = history[history.length - 1].content;
        
        const messages = [
            { 
                role: "system", 
                content: "You are Pluto, a highly capable AI assistant. You use the provided 'FOUNDATION' as your core grounding, but you are also a general-purpose AI. You can answer any question, discuss any topic, and provide creative assistance. Keep your tone professional and intelligent." 
            },
            { 
                role: "user", 
                content: `FOUNDATION CONTEXT: ${foundation}\n\nCONVERSATION HISTORY: ${history.map(m => `${m.role}: ${m.content}`).join('\n')}\n\nUSER QUERY: ${lastMsg}` 
            }
        ];

        const result = await callLlamaWithRetry(messages);
        const reply = result.choices?.[0]?.message?.content || "No response generated.";
        res.json({ success: true, reply });
    } catch (error) {
        console.error("[Pluto Chat Error]:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check for Render
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Pluto Backend Active on port ${PORT}`));